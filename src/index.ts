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
import type { IngestedPost } from './ingest/types.ts';
import { AutoHitl } from './hitl/auto.ts';
import { StdinHitl } from './hitl/stdin.ts';
import { TelegramHitl } from './hitl/telegram.ts';
import type { HitlSurface } from './hitl/types.ts';
import type { Proposal, TriggerContext } from './pipeline/orchestrator.ts';
import { BskyClient } from './replier/bsky.ts';
import { buildNoClaimReply, buildNoMatchReply, buildReplyText } from './replier/format.ts';

async function main(): Promise<void> {
  const cfg = getConfig();
  await getDbAsync();
  const db = getDb();
  const abort = new AbortController();

  const labelerServer = createLabelerServer();
  registerDetailRoutes(labelerServer.app);

  const appview = new AppViewClient({ baseUrl: cfg.APPVIEW_URL });

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

  /** Has a reply been recorded against this mention-source URI already? */
  const hasReplied = (replyToUri: string): boolean => {
    return !!db
      .prepare(`SELECT 1 FROM mention_reply WHERE replied_to_uri = ? LIMIT 1`)
      .get(replyToUri);
  };

  /** Send and persist a Bluesky reply with the given pre-rendered text. */
  const sendReply = async (args: {
    text: string;
    parentUri: string;
    parentCid: string;
    rootUri: string;
    rootCid: string;
    replyKind: 'verdict' | 'no-claim' | 'no-match';
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
      logger.error({ err, kind: args.replyKind, repliedTo: args.parentUri }, 'mention-reply post failed');
    }
  };

  /** Post a Bluesky reply with the verdict when conditions are met. */
  const maybeReplyToMention = async (proposalId: number): Promise<void> => {
    if (!bsky) return;
    const ctx = loadTriggerCtx(proposalId);
    if (!ctx) return;
    if (ctx.reason !== 'mention' && ctx.reason !== 'mention-reply') return;
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
    if (args.triggerReason !== 'mention' && args.triggerReason !== 'mention-reply') return;
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

  const surface: HitlSurface =
    cfg.HITL_MODE === 'telegram'
      ? new TelegramHitl(onDecision)
      : cfg.HITL_MODE === 'auto'
        ? new AutoHitl(onDecision)
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
      (trigger.reason === 'mention' || trigger.reason === 'mention-reply') &&
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
      return;
    }
    await dispatchPost(fetched, trigger);
  };

  // --- Reports trigger (variant 3) -----------------------------------------
  if (cfg.TRIGGER_REPORTS) {
    registerReportRoutes(labelerServer.app, async (report) => {
      logger.info({ uri: report.subjectUri, reasonType: report.reasonType }, 'report received');
      await dispatchByUri(report.subjectUri, { reason: 'report' });
    });
    logger.info('TRIGGER_REPORTS enabled — /xrpc/com.atproto.moderation.createReport mounted');
  }

  await labelerServer.start();

  // --- Jetstream-driven triggers (variants 1, 2, 4) ------------------------
  const triggerCfg: TriggerConfig = {
    firehose: cfg.TRIGGER_FIREHOSE,
    mentions: cfg.TRIGGER_MENTIONS,
    watchlist: cfg.TRIGGER_WATCHLIST,
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
    cfg.TRIGGER_FIREHOSE || cfg.TRIGGER_MENTIONS || cfg.TRIGGER_WATCHLIST.length > 0;

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
        watchlist: cfg.TRIGGER_WATCHLIST.length,
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
  if (hit.reason === 'mention' || hit.reason === 'mention-reply') {
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
