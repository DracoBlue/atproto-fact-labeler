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
import { evaluateTrigger, type TriggerConfig } from './ingest/triggers.ts';
import type { IngestedPost } from './ingest/types.ts';
import { AutoHitl } from './hitl/auto.ts';
import { StdinHitl } from './hitl/stdin.ts';
import { TelegramHitl } from './hitl/telegram.ts';
import type { HitlSurface } from './hitl/types.ts';
import type { Proposal } from './pipeline/orchestrator.ts';

async function main(): Promise<void> {
  const cfg = getConfig();
  await getDbAsync();
  const db = getDb();
  const abort = new AbortController();

  const labelerServer = createLabelerServer();
  registerDetailRoutes(labelerServer.app);

  const appview = new AppViewClient({ baseUrl: cfg.APPVIEW_URL });

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
  };

  const surface: HitlSurface =
    cfg.HITL_MODE === 'telegram'
      ? new TelegramHitl(onDecision)
      : cfg.HITL_MODE === 'auto'
        ? new AutoHitl(onDecision)
        : new StdinHitl(onDecision);

  await surface.start?.(abort.signal);

  /** Common dispatcher: take a fully-formed post and run it through the pipeline. */
  const dispatchPost = async (post: IngestedPost, reason: string): Promise<void> => {
    logger.info({ uri: post.uri, reason }, 'dispatch');
    let proposals: Proposal[];
    try {
      proposals = await processPost(post);
    } catch (err) {
      logger.error({ err, uri: post.uri }, 'pipeline error');
      return;
    }
    for (const p of proposals) {
      try {
        await surface.enqueue(p);
      } catch (err) {
        logger.error({ err, proposalId: p.proposalId }, 'HITL enqueue failed');
      }
    }
  };

  /** Resolve a URI to a post (cache lookup or AppView fetch) and dispatch. */
  const dispatchByUri = async (uri: string, reason: string): Promise<void> => {
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
        reason,
      );
      return;
    }
    const fetched = await appview.getPost(uri);
    if (!fetched) {
      logger.warn({ uri }, 'could not resolve target post via AppView');
      return;
    }
    await dispatchPost(fetched, reason);
  };

  // --- Reports trigger (variant 3) -----------------------------------------
  if (cfg.TRIGGER_REPORTS) {
    registerReportRoutes(labelerServer.app, async (report) => {
      logger.info({ uri: report.subjectUri, reasonType: report.reasonType }, 'report received');
      await dispatchByUri(report.subjectUri, 'report');
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
    if (hit.targetIsSourcePost) {
      await dispatchPost(post, hit.reason);
    } else {
      await dispatchByUri(hit.targetUri, hit.reason);
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

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal');
  process.exitCode = 1;
});
