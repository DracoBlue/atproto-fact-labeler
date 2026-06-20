/**
 * atproto-fact-labeler — service entrypoint.
 *
 * Wires up: config → DB → labeler server → detail HTTP → reports → HITL → ingest loop.
 * Stops cleanly on SIGINT / SIGTERM.
 */
import { getConfig } from './config/index.ts';
import { getDb, getDbAsync, closeDb } from './store/db.ts';
import { logger } from './util/logger.ts';
import { runJetstream } from './ingest/jetstream.ts';
import { runFixture } from './ingest/fixture.ts';
import { processPost } from './pipeline/orchestrator.ts';
import { createLabelerServer } from './labels/server.ts';
import { verdictToLabel } from './labels/vocabulary.ts';
import { registerDetailRoutes } from './detail/server.ts';
import { registerReportRoutes } from './ingest/reports.ts';
import { AppViewClient } from './ingest/appview.ts';
import { evaluateTrigger, type TriggerConfig, type TriggerHit } from './ingest/triggers.ts';
import { resolveWatchlistToDids } from './config/resolve-watchlist.ts';
import type { IngestedPost } from './ingest/types.ts';
import { AutoHitl } from './hitl/auto.ts';
import { AutoTelegramHitl } from './hitl/auto-telegram.ts';
import { StdinHitl } from './hitl/stdin.ts';
import { TelegramHitl } from './hitl/telegram.ts';
import type { HitlSurface } from './hitl/types.ts';
import type { Proposal, TriggerContext } from './pipeline/orchestrator.ts';
import { BskyClient } from './replier/bsky.ts';
import {
  buildNoClaimReply,
  buildNoMatchReply,
  buildNoTargetReply,
  buildReplyText,
} from './replier/format.ts';
import { isAppealReason, isLabelerOwnUri, recordFeedback } from './feedback/store.ts';
import {
  clearQueueRow,
  enqueueReply,
  hasQueuedReply,
  recordFailure,
  takeReadyBatch,
  type ReplyKind,
} from './replier/queue.ts';

async function main(): Promise<void> {
  const cfg = getConfig();
  await getDbAsync();
  const db = getDb();
  const abort = new AbortController();

  const labelerServer = createLabelerServer();
  registerDetailRoutes(labelerServer.app);

  /** Authenticated Bluesky client for posting mention-replies. Optional. */
  const bsky = cfg.REPLY_TO_MENTIONS
    ? new BskyClient({
        serviceUrl: cfg.LABELER_BSKY_SERVICE,
        identifier: cfg.LABELER_BSKY_IDENTIFIER!,
        password: cfg.LABELER_BSKY_APP_PASSWORD!,
      })
    : null;
  if (bsky) {
    try {
      await bsky.login();
    } catch (err) {
      logger.error(
        { err },
        'failed to log in to Bluesky for mention-replies — REPLY_TO_MENTIONS will be a no-op',
      );
    }
  }

  // Once the optional BskyClient is wired we can give the AppViewClient an
  // authed fallback — same access JWT, called only when public reads fail.
  const appview = new AppViewClient({
    baseUrl: cfg.APPVIEW_URL,
    authedFallback: bsky
      ? { baseUrl: cfg.APPVIEW_AUTHED_URL, getJwt: () => bsky.accessJwt }
      : undefined,
  });

  /** Decision handler: write back to DB and emit a label if accepted. */
  const onDecision = async ({
    proposalId,
    decision,
    by,
  }: {
    proposalId: number;
    decision: 'accept' | 'reject' | 'defer';
    by: string;
  }): Promise<void> => {
    db.prepare(
      `UPDATE proposal SET decision = ?, decided_by = ?, decided_at = datetime('now')
        WHERE id = ?`,
    ).run(decision, by, proposalId);

    if (decision !== 'accept') {
      if (decision === 'reject') {
        db.prepare(`UPDATE claim
                       SET status = 'rejected'
                      WHERE id = (SELECT claim_id FROM proposal WHERE id = ?)`).run(proposalId);
        db.prepare(`UPDATE verdict
                       SET status = 'rejected'
                      WHERE id = (SELECT verdict_id FROM proposal WHERE id = ?)`).run(proposalId);
      }
      return;
    }

    db.prepare(`UPDATE claim
                   SET status = 'accepted'
                  WHERE id = (SELECT claim_id FROM proposal WHERE id = ?)`).run(proposalId);
    db.prepare(`UPDATE verdict
                   SET status = 'accepted'
                  WHERE id = (SELECT verdict_id FROM proposal WHERE id = ?)`).run(proposalId);

    const row = db
      .prepare(
        `SELECT v.id      AS verdict_id,
                v.label   AS verdict,
                p.post_uri,
                pc.cid    AS post_cid
           FROM proposal p
           JOIN verdict v   ON v.id = p.verdict_id
           JOIN post_cache pc ON pc.uri = p.post_uri
          WHERE p.id = ?`,
      )
      .get(proposalId) as
      | { verdict_id: number; verdict: string; post_uri: string; post_cid: string }
      | undefined;
    if (!row) return;

    const val = verdictToLabel(row.verdict as Parameters<typeof verdictToLabel>[0]);
    if (!val) return;

    try {
      await labelerServer.emitLabel({ uri: row.post_uri, cid: row.post_cid, val });
      db.prepare(
        `INSERT INTO label_emit (post_uri, post_cid, val, cts, verdict_id)
         VALUES (?, ?, ?, datetime('now'), ?)`,
      ).run(row.post_uri, row.post_cid, val, row.verdict_id);
    } catch (err) {
      logger.error({ err, proposalId }, 'failed to emit label');
    }

    // Optional: reply to the mention post on Bluesky with the verdict.
    await maybeReplyToMention(proposalId);
    // Optional: quote-post the reported post on the labeler's own feed.
    await maybeQuoteForReport(proposalId, row.post_uri, row.post_cid);
  };

  /**
   * Resolve trigger context from a proposal record. Used by the verdict-reply
   * path so we know who to reply to, in which thread, and in which language.
   */
  const loadTriggerCtx = (
    proposalId: number,
  ):
    | {
        reason: string;
        source_uri: string;
        source_cid: string;
        root_uri: string | null;
        root_cid: string | null;
        source_lang: string | null;
        verdict: string;
        post_uri: string;
      }
    | null => {
    const row = db
      .prepare(
        `SELECT p.trigger_reason       AS reason,
                p.trigger_source_uri   AS source_uri,
                p.trigger_source_cid   AS source_cid,
                p.trigger_root_uri     AS root_uri,
                p.trigger_root_cid     AS root_cid,
                p.trigger_source_lang  AS source_lang,
                v.label                AS verdict,
                p.post_uri             AS post_uri
           FROM proposal p
           JOIN verdict v ON v.id = p.verdict_id
          WHERE p.id = ?`,
      )
      .get(proposalId) as
      | {
          reason: string | null;
          source_uri: string | null;
          source_cid: string | null;
          root_uri: string | null;
          root_cid: string | null;
          source_lang: string | null;
          verdict: string;
          post_uri: string;
        }
      | undefined;
    if (!row) return null;
    if (!row.reason || !row.source_uri || !row.source_cid) return null;
    return {
      reason: row.reason,
      source_uri: row.source_uri,
      source_cid: row.source_cid,
      root_uri: row.root_uri,
      root_cid: row.root_cid,
      source_lang: row.source_lang,
      verdict: row.verdict,
      post_uri: row.post_uri,
    };
  };

  /**
   * Has a reply been delivered *or* queued against this mention-source URI?
   * Either way we shouldn't add another job — the queued one will eventually
   * either succeed or end up in `status='failed'`.
   */
  const hasReplied = (replyToUri: string): boolean => {
    const delivered = !!db
      .prepare(`SELECT 1 FROM mention_reply WHERE replied_to_uri = ? LIMIT 1`)
      .get(replyToUri);
    if (delivered) return true;
    return hasQueuedReply(db, replyToUri);
  };

  /**
   * Send a Bluesky reply. Success → mention_reply row. Failure → reply_queue
   * for the drain worker to retry with exponential backoff.
   */
  const sendReply = async (args: {
    text: string;
    parentUri: string;
    parentCid: string;
    rootUri: string;
    rootCid: string;
    replyKind: ReplyKind;
    proposalId?: number;
  }): Promise<void> => {
    if (!bsky) return;
    try {
      const result = await bsky.postReply({
        text: args.text,
        parent: { uri: args.parentUri, cid: args.parentCid },
        root: { uri: args.rootUri, cid: args.rootCid },
      });
      db.prepare(
        `INSERT INTO mention_reply (proposal_id, reply_kind, reply_uri, reply_cid, replied_to_uri)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(args.proposalId ?? null, args.replyKind, result.uri, result.cid, args.parentUri);
      logger.info(
        { kind: args.replyKind, replyUri: result.uri, repliedTo: args.parentUri },
        'mention-reply posted',
      );
    } catch (err) {
      const inserted = enqueueReply(db, {
        parentUri: args.parentUri,
        parentCid: args.parentCid,
        rootUri: args.rootUri,
        rootCid: args.rootCid,
        text: args.text,
        replyKind: args.replyKind,
        proposalId: args.proposalId,
      });
      logger.warn(
        { err, kind: args.replyKind, repliedTo: args.parentUri, queued: inserted },
        'mention-reply post failed — queued for retry',
      );
    }
  };

  /** Drain a batch of queued replies; called periodically. */
  const drainReplyQueue = async (): Promise<void> => {
    if (!bsky) return;
    const batch = takeReadyBatch(db, 10);
    if (batch.length === 0) return;
    logger.debug({ count: batch.length }, 'draining reply queue');
    for (const job of batch) {
      try {
        const result = await bsky.postReply({
          text: job.text,
          parent: { uri: job.parentUri, cid: job.parentCid },
          root: { uri: job.rootUri, cid: job.rootCid },
        });
        db.prepare(
          `INSERT INTO mention_reply (proposal_id, reply_kind, reply_uri, reply_cid, replied_to_uri)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(job.proposalId ?? null, job.replyKind, result.uri, result.cid, job.parentUri);
        clearQueueRow(db, job.id);
        logger.info(
          { kind: job.replyKind, replyUri: result.uri, repliedTo: job.parentUri, attempts: job.attempts + 1 },
          'queued mention-reply delivered',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordFailure(db, job.id, job.attempts, msg);
        logger.warn(
          { err: msg, kind: job.replyKind, repliedTo: job.parentUri, attempts: job.attempts + 1 },
          'queued mention-reply still failing',
        );
      }
    }
  };

  // Start the drain loop. Interval is short enough that recovery from a
  // transient failure feels responsive, long enough not to hammer Bluesky.
  let drainTimer: NodeJS.Timeout | undefined;
  if (bsky) {
    const DRAIN_INTERVAL_MS = 30_000;
    drainTimer = setInterval(() => {
      drainReplyQueue().catch((err) => logger.error({ err }, 'drainReplyQueue threw'));
    }, DRAIN_INTERVAL_MS);
    // Kick once immediately so a restart picks up anything left behind.
    setTimeout(() => drainReplyQueue().catch(() => {}), 1000);
  }

  /** Post a Bluesky reply with the verdict when conditions are met. */
  const maybeReplyToMention = async (proposalId: number): Promise<void> => {
    if (!bsky) return;
    const ctx = loadTriggerCtx(proposalId);
    if (!ctx) return;
    if (
      ctx.reason !== 'mention' &&
      ctx.reason !== 'mention-reply' &&
      ctx.reason !== 'mention-quote'
    ) return;
    if (hasReplied(ctx.source_uri)) return;

    const publishers = (
      db
        .prepare(
          `SELECT DISTINCT publisher FROM evidence
             WHERE verdict_id = (SELECT verdict_id FROM proposal WHERE id = ?)
             ORDER BY id LIMIT 5`,
        )
        .all(proposalId) as Array<{ publisher: string | null }>
    )
      .map((r) => r.publisher ?? '')
      .filter(Boolean);

    // Top-ranked evidence is the first row by id (insert order = lookup quality DESC).
    const topSource = db
      .prepare(
        `SELECT source_url FROM evidence
           WHERE verdict_id = (SELECT verdict_id FROM proposal WHERE id = ?)
           ORDER BY id LIMIT 1`,
      )
      .get(proposalId) as { source_url: string | null } | undefined;
    const primarySourceUrl = topSource?.source_url ?? undefined;

    const detailUrl =
      (cfg.LABELER_DETAIL_BASE_URL ?? cfg.LABELER_HOSTNAME).replace(/\/$/, '') +
      `/posts?uri=${encodeURIComponent(ctx.post_uri)}`;

    const text = buildReplyText({
      verdict: ctx.verdict,
      publishers,
      detailUrl,
      primarySourceUrl,
      lang: ctx.source_lang ?? undefined,
      defaultLang: cfg.LABELER_REPLY_DEFAULT_LANG,
    });

    await sendReply({
      text,
      parentUri: ctx.source_uri,
      parentCid: ctx.source_cid,
      rootUri: ctx.root_uri ?? ctx.source_uri,
      rootCid: ctx.root_cid ?? ctx.source_cid,
      replyKind: 'verdict',
      proposalId,
    });
  };

  /**
   * For report-triggered accepted proposals, quote-post the reported post on
   * the labeler's own feed with the verdict text. Idempotent on the reported
   * URI — re-reports of the same post don't re-post. Honours the author's
   * postgate (`disableRule`); skip + log if quotes are disabled.
   *
   * Doesn't use `loadTriggerCtx` because the report trigger has no
   * `source_uri / source_cid` (the subject IS the post being labeled). Instead
   * we load verdict + post-lang directly here.
   */
  const maybeQuoteForReport = async (
    proposalId: number,
    postUri: string,
    postCid: string,
  ): Promise<void> => {
    if (!bsky || !cfg.REPLY_TO_REPORTS) return;
    const row = db
      .prepare(
        `SELECT p.trigger_reason AS reason,
                v.label          AS verdict,
                pc.lang          AS post_lang
           FROM proposal p
           JOIN verdict v   ON v.id = p.verdict_id
           JOIN post_cache pc ON pc.uri = p.post_uri
          WHERE p.id = ?`,
      )
      .get(proposalId) as
      | { reason: string | null; verdict: string; post_lang: string | null }
      | undefined;
    if (!row || row.reason !== 'report') return;
    if (hasReplied(postUri)) {
      logger.debug({ postUri, proposalId }, 'report-quote: already replied to this URI, skipping');
      return;
    }

    const allowed = await bsky.quotesAllowed(postUri);
    if (!allowed) {
      logger.info({ postUri, proposalId }, 'report-quote: author disabled quotes (postgate), skipping');
      return;
    }

    const publishers = (
      db
        .prepare(
          `SELECT DISTINCT publisher FROM evidence
             WHERE verdict_id = (SELECT verdict_id FROM proposal WHERE id = ?)
             ORDER BY id LIMIT 5`,
        )
        .all(proposalId) as Array<{ publisher: string | null }>
    )
      .map((r) => r.publisher ?? '')
      .filter(Boolean);

    const topSource = db
      .prepare(
        `SELECT source_url FROM evidence
           WHERE verdict_id = (SELECT verdict_id FROM proposal WHERE id = ?)
           ORDER BY id LIMIT 1`,
      )
      .get(proposalId) as { source_url: string | null } | undefined;
    const primarySourceUrl = topSource?.source_url ?? undefined;

    const detailUrl =
      (cfg.LABELER_DETAIL_BASE_URL ?? cfg.LABELER_HOSTNAME).replace(/\/$/, '') +
      `/posts?uri=${encodeURIComponent(postUri)}`;

    const text = buildReplyText({
      verdict: row.verdict,
      publishers,
      detailUrl,
      primarySourceUrl,
      lang: row.post_lang ?? undefined,
      defaultLang: cfg.LABELER_REPLY_DEFAULT_LANG,
    });

    try {
      const result = await bsky.postQuote({
        text,
        embed: { uri: postUri, cid: postCid },
      });
      db.prepare(
        `INSERT INTO mention_reply (proposal_id, reply_kind, reply_uri, reply_cid, replied_to_uri)
         VALUES (?, 'verdict', ?, ?, ?)`,
      ).run(proposalId, result.uri, result.cid, postUri);
      logger.info(
        { proposalId, postUri, quoteUri: result.uri },
        'report-quote: quote-post published',
      );
    } catch (err) {
      // The label IS the primary public signal. Quote-post is best-effort —
      // on transient failure we log and move on rather than queue for retry
      // (the retry queue is keyed on parent_uri shared with mention replies).
      logger.warn(
        { err: (err as Error).message, postUri, proposalId },
        'report-quote: quote-post failed, label still emitted',
      );
    }
  };

  /**
   * When a mention trigger produced no proposal (no falsifiable claim, or no
   * ClaimReview match), post a short diagnostic reply so the user knows we
   * looked and what we found.
   */
  const maybeReplyDiagnostic = async (args: {
    triggerReason: string;
    sourceUri: string;
    sourceCid: string;
    rootUri: string;
    rootCid: string;
    sourceLang?: string;
    extractedClaims: number;
    falsifiableClaims: number;
    claimsWithMatches: number;
  }): Promise<void> => {
    if (!bsky) return;
    if (
      args.triggerReason !== 'mention' &&
      args.triggerReason !== 'mention-reply' &&
      args.triggerReason !== 'mention-quote'
    ) return;
    if (hasReplied(args.sourceUri)) return;

    let text: string;
    let replyKind: 'no-claim' | 'no-match';
    if (args.falsifiableClaims === 0) {
      replyKind = 'no-claim';
      text = buildNoClaimReply({
        lang: args.sourceLang,
        defaultLang: cfg.LABELER_REPLY_DEFAULT_LANG,
      });
    } else if (args.claimsWithMatches === 0) {
      replyKind = 'no-match';
      text = buildNoMatchReply({
        lang: args.sourceLang,
        defaultLang: cfg.LABELER_REPLY_DEFAULT_LANG,
      });
    } else {
      // Claims with matches but every one was dropped before propose() —
      // currently impossible in our orchestrator, but kept as a no-op for safety.
      return;
    }

    await sendReply({
      text,
      parentUri: args.sourceUri,
      parentCid: args.sourceCid,
      rootUri: args.rootUri,
      rootCid: args.rootCid,
      replyKind,
    });
  };

  const autoPolicy = {
    minConfidence: cfg.HITL_AUTO_MIN_CONFIDENCE,
    minVotes: cfg.HITL_AUTO_MIN_VOTES,
  };
  const surface: HitlSurface =
    cfg.HITL_MODE === 'telegram'
      ? new TelegramHitl(onDecision)
      : cfg.HITL_MODE === 'auto'
        ? new AutoHitl(onDecision, autoPolicy)
        : cfg.HITL_MODE === 'auto-telegram'
          ? new AutoTelegramHitl(onDecision, autoPolicy)
          : new StdinHitl(onDecision);

  await surface.start?.(abort.signal);

  /** Common dispatcher: take a fully-formed post and run it through the pipeline. */
  const dispatchPost = async (post: IngestedPost, trigger: TriggerContext): Promise<void> => {
    logger.info({ uri: post.uri, reason: trigger.reason }, 'dispatch');
    let result: Awaited<ReturnType<typeof processPost>>;
    try {
      result = await processPost(post, {}, trigger);
    } catch (err) {
      logger.error({ err, uri: post.uri }, 'pipeline error');
      return;
    }

    const proposals: Proposal[] = result.proposals;
    for (const p of proposals) {
      try {
        await surface.enqueue(p);
      } catch (err) {
        logger.error({ err, proposalId: p.proposalId }, 'HITL enqueue failed');
      }
    }

    // If a mention produced no proposal at all, send a diagnostic reply so
    // the user knows we looked and what we (didn't) find.
    if (
      proposals.length === 0 &&
      (trigger.reason === 'mention' ||
        trigger.reason === 'mention-reply' ||
        trigger.reason === 'mention-quote') &&
      trigger.sourceUri &&
      trigger.sourceCid
    ) {
      await maybeReplyDiagnostic({
        triggerReason: trigger.reason,
        sourceUri: trigger.sourceUri,
        sourceCid: trigger.sourceCid,
        rootUri: trigger.rootUri ?? trigger.sourceUri,
        rootCid: trigger.rootCid ?? trigger.sourceCid,
        sourceLang: trigger.sourceLang,
        extractedClaims: result.extractedClaims,
        falsifiableClaims: result.falsifiableClaims,
        claimsWithMatches: result.claimsWithMatches,
      });
    }
  };

  /** Resolve a URI to a post (cache lookup or AppView fetch) and dispatch. */
  const dispatchByUri = async (uri: string, trigger: TriggerContext): Promise<void> => {
    const cached = db
      .prepare(
        `SELECT uri, cid, did, text, lang, indexed_at AS indexedAt
           FROM post_cache WHERE uri = ? LIMIT 1`,
      )
      .get(uri) as
      | { uri: string; cid: string; did: string; text: string; lang: string | null; indexedAt: string }
      | undefined;
    if (cached) {
      await dispatchPost(
        {
          uri: cached.uri,
          cid: cached.cid,
          did: cached.did,
          text: cached.text,
          lang: cached.lang ?? undefined,
          indexedAt: cached.indexedAt,
          kind: 'post',
        },
        trigger,
      );
      return;
    }
    const fetched = await appview.getPost(uri);
    if (!fetched) {
      logger.warn({ uri }, 'could not resolve target post via AppView');
      // Tell the mention author we tried. Verdict reply path can't run because
      // we have no post to extract claims from; instead we send a `no-target`
      // diagnostic so the user isn't left hanging.
      if (
        (trigger.reason === 'mention-reply' || trigger.reason === 'mention-quote') &&
        trigger.sourceUri &&
        trigger.sourceCid &&
        bsky &&
        !hasReplied(trigger.sourceUri)
      ) {
        await sendReply({
          text: buildNoTargetReply({
            lang: trigger.sourceLang,
            defaultLang: cfg.LABELER_REPLY_DEFAULT_LANG,
          }),
          parentUri: trigger.sourceUri,
          parentCid: trigger.sourceCid,
          rootUri: trigger.rootUri ?? trigger.sourceUri,
          rootCid: trigger.rootCid ?? trigger.sourceCid,
          replyKind: 'no-target',
        });
      }
      return;
    }
    // Belt-and-braces self-guard: the trigger layer already drops posts
    // authored by the labeler, but a mention chain or report can reference
    // a post we authored. Reports against our own posts are filtered upstream
    // into the feedback channel; this catches everything else.
    if (fetched.did === cfg.LABELER_DID) {
      logger.info({ uri }, 'dropped self-targeted dispatch (post authored by labeler)');
      return;
    }
    await dispatchPost(fetched, trigger);
  };

  // --- Reports trigger (variant 3) -----------------------------------------
  if (cfg.TRIGGER_REPORTS) {
    registerReportRoutes(
      labelerServer.app,
      async (report) => {
      // Appeals — a user pressing "Anfechten" / "Appeal" on a label the
      // labeler emitted. The bsky client sends a createReport with reasonType
      // set to *reasonAppeal* (two namespaces in flight; both seen in the
      // wild). An appeal is NOT a fresh fact-check request — re-running the
      // pipeline would land on the same verdict. Record it as feedback so an
      // operator can review the existing label, and skip the dispatch.
      if (isAppealReason(report.reasonType)) {
        const id = recordFeedback(db, {
          subjectUri: report.subjectUri,
          subjectCid: report.subjectCid,
          reasonType: report.reasonType,
          reason: report.reason,
        });
        logger.warn(
          {
            feedbackId: id,
            uri: report.subjectUri,
            reasonType: report.reasonType,
            reportedBy: report.reportedBy,
          },
          'label appeal received — recorded as feedback, pipeline NOT re-run. Operator review: pnpm feedback:list / pnpm retire --uri=...',
        );
        // Push a Telegram notification when the operator has wired one up.
        // The surface object exposes `notifyAppeal` on `telegram` and
        // `auto-telegram` modes; on `stdin` / `auto` it's a no-op.
        const maybeAppealNotifier = surface as unknown as {
          notifyAppeal?: (input: {
            subjectUri: string;
            reportedBy: string;
            reason?: string | null;
            detailUrl?: string;
          }) => Promise<void>;
        };
        if (typeof maybeAppealNotifier.notifyAppeal === 'function') {
          const detailUrl =
            (cfg.LABELER_DETAIL_BASE_URL ?? cfg.LABELER_HOSTNAME).replace(/\/$/, '') +
            `/posts?uri=${encodeURIComponent(report.subjectUri)}`;
          await maybeAppealNotifier.notifyAppeal({
            subjectUri: report.subjectUri,
            reportedBy: report.reportedBy,
            reason: report.reason,
            detailUrl,
          });
        }
        return;
      }
      // A user reporting one of our own posts is signalling "you got something
      // wrong" — record it as operator feedback instead of running the pipeline
      // on our own work.
      if (isLabelerOwnUri(report.subjectUri, cfg.LABELER_DID)) {
        const id = recordFeedback(db, {
          subjectUri: report.subjectUri,
          subjectCid: report.subjectCid,
          reasonType: report.reasonType,
          reason: report.reason,
        });
        logger.warn(
          { feedbackId: id, uri: report.subjectUri, reasonType: report.reasonType },
          'report against own post — recorded as feedback',
        );
        return;
      }
      logger.info(
        { uri: report.subjectUri, reasonType: report.reasonType, reportedBy: report.reportedBy },
        'report received',
      );
      await dispatchByUri(report.subjectUri, { reason: 'report' });
    },
      {
        requireAuth: cfg.REQUIRE_REPORT_AUTH,
        labelerDid: cfg.LABELER_DID,
        plcUrl: cfg.PLC_DIRECTORY_URL,
      },
    );
    logger.info(
      { authRequired: cfg.REQUIRE_REPORT_AUTH },
      'TRIGGER_REPORTS enabled — /xrpc/com.atproto.moderation.createReport mounted',
    );
  }

  await labelerServer.start();

  // --- Jetstream-driven triggers (variants 1, 2, 4) ------------------------
  // Watchlist entries may be handles or DIDs in env config; resolve them all
  // to DIDs at startup. If any resolution fails, we abort — a half-resolved
  // watchlist silently misses posts.
  const resolvedWatchlist = await resolveWatchlistToDids(cfg.TRIGGER_WATCHLIST, {
    appviewUrl: cfg.APPVIEW_URL,
  });
  if (resolvedWatchlist.length !== cfg.TRIGGER_WATCHLIST.length) {
    logger.info(
      { configured: cfg.TRIGGER_WATCHLIST.length, resolved: resolvedWatchlist.length },
      'watchlist deduped after handle resolution',
    );
  }

  const triggerCfg: TriggerConfig = {
    firehose: cfg.TRIGGER_FIREHOSE,
    mentions: cfg.TRIGGER_MENTIONS,
    watchlist: resolvedWatchlist,
    labelerDid: cfg.LABELER_DID,
    labelerHandle: cfg.LABELER_HANDLE,
  };

  const handlePost = async (post: IngestedPost): Promise<void> => {
    const hit = evaluateTrigger(post, triggerCfg);
    if (!hit) return;
    const trigger = buildTriggerContext(post, hit);
    if (hit.targetIsSourcePost) {
      await dispatchPost(post, trigger);
    } else {
      await dispatchByUri(hit.targetUri, trigger);
    }
  };

  // Cursor persistence for Jetstream.
  const cursorRow = db.prepare(`SELECT v FROM kv_state WHERE k='jetstream_cursor'`).get() as
    | { v: string }
    | undefined;
  const startCursor = cursorRow ? Number(cursorRow.v) : undefined;
  const saveCursor = (micros: number): void => {
    db.prepare(
      `INSERT INTO kv_state (k, v) VALUES ('jetstream_cursor', ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(String(micros));
  };

  const shutdown = async (reason: string): Promise<void> => {
    logger.info({ reason }, 'shutting down');
    abort.abort();
    if (drainTimer) clearInterval(drainTimer);
    await surface.stop?.();
    await labelerServer.stop();
    closeDb();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // --- Pick ingest mode ----------------------------------------------------
  // Jetstream stays connected even when TRIGGER_FIREHOSE is false — we still
  // need it for TRIGGER_MENTIONS and TRIGGER_WATCHLIST. If none of the three
  // is enabled and there's no fixture, the service runs report-only.
  const needsJetstream =
    cfg.TRIGGER_FIREHOSE || cfg.TRIGGER_MENTIONS || resolvedWatchlist.length > 0;

  if (cfg.JETSTREAM_FIXTURE) {
    logger.info({ path: cfg.JETSTREAM_FIXTURE }, 'using fixture ingest');
    await runFixture({ path: cfg.JETSTREAM_FIXTURE, onPost: handlePost, signal: abort.signal });
    logger.info('fixture ingest finished — service idling. Press Ctrl+C to exit.');
    await new Promise<void>((resolveFn) => abort.signal.addEventListener('abort', () => resolveFn()));
  } else if (needsJetstream) {
    logger.info(
      {
        url: cfg.JETSTREAM_URL,
        firehose: cfg.TRIGGER_FIREHOSE,
        mentions: cfg.TRIGGER_MENTIONS,
        watchlist: resolvedWatchlist.length,
      },
      'starting Jetstream ingest',
    );
    await runJetstream({
      url: cfg.JETSTREAM_URL,
      cursorMicros: startCursor,
      saveCursor,
      onPost: handlePost,
      signal: abort.signal,
    });
  } else {
    logger.info('all Jetstream triggers disabled — service is report-only. Press Ctrl+C to exit.');
    await new Promise<void>((resolveFn) => abort.signal.addEventListener('abort', () => resolveFn()));
  }
}

/**
 * Build the per-proposal trigger context from the originating post + trigger hit.
 * The mention reply path needs to know the mentioning post's URI, CID, and
 * thread root so it can construct a syntactically correct Bluesky reply.
 */
function buildTriggerContext(post: IngestedPost, hit: TriggerHit): TriggerContext {
  if (
    hit.reason === 'mention' ||
    hit.reason === 'mention-reply' ||
    hit.reason === 'mention-quote'
  ) {
    const root = post.replyRoot ?? { uri: post.uri, cid: post.cid };
    return {
      reason: hit.reason,
      sourceUri: post.uri,
      sourceCid: post.cid,
      rootUri: root.uri,
      rootCid: root.cid,
      sourceLang: post.lang,
    };
  }
  return { reason: hit.reason };
}

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal');
  process.exitCode = 1;
});
