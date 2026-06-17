/**
 * atproto-fact-labeler — service entrypoint.
 *
 * Wires up: config → DB → labeler server → detail HTTP → HITL → ingest loop.
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
  await labelerServer.start();

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

    // Accepted — persist accepted statuses and emit the label.
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

  // Pick a HITL surface.
  const surface: HitlSurface =
    cfg.HITL_MODE === 'telegram'
      ? new TelegramHitl(onDecision)
      : cfg.HITL_MODE === 'auto'
        ? new AutoHitl(onDecision)
        : new StdinHitl(onDecision);

  await surface.start?.(abort.signal);

  // Pipeline driver — every ingested post goes through it; resulting proposals
  // are pushed to the HITL surface.
  const handlePost = async (post: Parameters<typeof processPost>[0]): Promise<void> => {
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

  // Persist + reload Jetstream cursor across restarts.
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

  // Wire shutdown.
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

  // Choose ingest mode.
  if (cfg.JETSTREAM_FIXTURE) {
    logger.info({ path: cfg.JETSTREAM_FIXTURE }, 'using fixture ingest');
    await runFixture({ path: cfg.JETSTREAM_FIXTURE, onPost: handlePost, signal: abort.signal });
    logger.info('fixture ingest finished — service idling. Press Ctrl+C to exit.');
    // Stay alive so the HITL loop can still finish queued items.
    await new Promise<void>((resolveFn) => abort.signal.addEventListener('abort', () => resolveFn()));
  } else {
    logger.info({ url: cfg.JETSTREAM_URL }, 'starting Jetstream ingest');
    await runJetstream({
      url: cfg.JETSTREAM_URL,
      cursorMicros: startCursor,
      saveCursor,
      onPost: handlePost,
      signal: abort.signal,
    });
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal');
  process.exitCode = 1;
});
