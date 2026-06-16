/**
 * Local smoke test of the full pipeline without LM Studio.
 *
 * - Stubs out the LLM extraction with hard-coded atomic claims.
 * - Feeds the orchestrator with a fixture post.
 * - Drives the AutoHitl surface to accept high-confidence proposals.
 * - Verifies the label-server signs and persists the label row.
 *
 * Exits 0 iff at least one label was emitted.
 *
 * Run: pnpm tsx src/cli/smoke-test.ts
 *
 * Requirements:
 *  - data.json has been ingested into the SQLite index (run `pnpm run ingest`).
 *  - .env has a valid LABELER_SIGNING_KEY (or it will be auto-generated).
 */
import { getConfig } from '../config/index.ts';
import { getDb, getDbAsync, closeDb } from '../store/db.ts';
import { logger } from '../util/logger.ts';
import { processPost } from '../pipeline/orchestrator.ts';
import { createLabelerServer } from '../labels/server.ts';
import { verdictToLabel } from '../labels/vocabulary.ts';
import { AutoHitl } from '../hitl/auto.ts';

interface RowCount {
  n: number;
}

async function main(): Promise<void> {
  getConfig();
  await getDbAsync();
  const db = getDb();

  const reviews = db.prepare(`SELECT COUNT(*) AS n FROM claim_review`).get() as RowCount;
  if (reviews.n === 0) {
    logger.error('SQLite has no ClaimReview rows. Run `pnpm run ingest data.json` first.');
    process.exitCode = 1;
    return;
  }
  logger.info({ rows: reviews.n }, 'ClaimReview index loaded');

  const labeler = createLabelerServer();
  await labeler.start();

  // Track every accept so we can verify the loop actually emits.
  const accepted: number[] = [];

  const surface = new AutoHitl(
    async ({ proposalId, decision }) => {
      db.prepare(
        `UPDATE proposal SET decision = ?, decided_by = 'smoke',
                              decided_at = datetime('now') WHERE id = ?`,
      ).run(decision, proposalId);
      if (decision !== 'accept') return;
      accepted.push(proposalId);

      // Mirror what the production decision handler does.
      db.prepare(`UPDATE claim   SET status = 'accepted'
                     WHERE id = (SELECT claim_id   FROM proposal WHERE id = ?)`).run(proposalId);
      db.prepare(`UPDATE verdict SET status = 'accepted'
                     WHERE id = (SELECT verdict_id FROM proposal WHERE id = ?)`).run(proposalId);

      const row = db
        .prepare(
          `SELECT v.id AS verdict_id, v.label AS verdict, p.post_uri, pc.cid AS post_cid
             FROM proposal p
             JOIN verdict v ON v.id = p.verdict_id
             JOIN post_cache pc ON pc.uri = p.post_uri
            WHERE p.id = ?`,
        )
        .get(proposalId) as
        | { verdict_id: number; verdict: string; post_uri: string; post_cid: string }
        | undefined;
      if (!row) return;
      const val = verdictToLabel(row.verdict as Parameters<typeof verdictToLabel>[0]);
      if (!val) return;
      await labeler.emitLabel({ uri: row.post_uri, cid: row.post_cid, val });
      db.prepare(
        `INSERT INTO label_emit (post_uri, post_cid, val, cts, verdict_id)
         VALUES (?, ?, ?, datetime('now'), ?)`,
      ).run(row.post_uri, row.post_cid, val, row.verdict_id);
    },
    // Lenient policy for the smoke run.
    { minConfidence: 0.3, minVotes: 1 },
  );

  // A pair of posts paired with hand-crafted claims that should hit recent
  // English-language fact-checks in the Data Commons feed.
  const cases = [
    {
      post: {
        uri: 'at://did:plc:smoke-1/app.bsky.feed.post/test1',
        cid: 'bafyreismokesmokesmoke1',
        did: 'did:plc:smoke-1',
        text: 'Trump claims there is currently "no inflation" in the US.',
        lang: 'en',
        indexedAt: new Date().toISOString(),
        kind: 'post' as const,
      },
      stubClaims: [
        {
          atomic_text: 'There is no inflation in the US',
          decontextualized_text: 'There is no inflation in the US',
          span_start: null,
          span_end: null,
          is_falsifiable: true,
          lang: 'en',
          entities: ['US', 'inflation'],
          confidence: 0.95,
        },
      ],
    },
  ];

  for (const c of cases) {
    logger.info({ uri: c.post.uri, text: c.post.text }, 'driving smoke case');
    const proposals = await processPost(c.post, {
      extractStub: async () => ({
        claims: c.stubClaims,
        extractorVersion: 'smoke-stub',
        raw: '',
      }),
    });
    logger.info(
      { proposals: proposals.length, verdicts: proposals.map((p) => p.verdict) },
      'orchestrator returned',
    );
    for (const p of proposals) {
      await surface.enqueue(p);
    }
  }

  // Report.
  const emittedRows = db
    .prepare(`SELECT post_uri, val, cts FROM label_emit ORDER BY id DESC LIMIT 10`)
    .all() as Array<{ post_uri: string; val: string; cts: string }>;
  if (!emittedRows.length) {
    logger.error('no labels emitted — smoke test failed');
    process.exitCode = 1;
  } else {
    logger.info({ emitted: emittedRows }, 'labels emitted ✓');
  }

  await labeler.stop();
  closeDb();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'smoke test crashed');
  process.exitCode = 1;
});
