/**
 * pnpm cli:embed-rebuild [--force] [--batch N] [--limit N]
 *
 * Compute dense embeddings for every claim_review row whose `embedding` is
 * NULL, or all rows when --force is given. Required before Stage 1 (dense
 * retrieve) can produce useful results.
 *
 * If EMBEDDING_MODEL has changed since the last run, rows tagged with the
 * old model are re-embedded automatically (model-aware backfill).
 */
import { getConfig } from '../config/index.ts';
import { getDbAsync, closeDb } from '../store/db.ts';
import { logger } from '../util/logger.ts';
import { embedBatch, vectorToBlob } from '../embedding/client.ts';

interface Args { force: boolean; batch: number; limit: number | null }

function parseArgs(argv: string[]): Args {
  let force = false;
  let batch = 32;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--batch') batch = Math.max(1, Number(argv[++i] ?? '32'));
    else if (a === '--limit') limit = Math.max(1, Number(argv[++i] ?? ''));
  }
  return { force, batch, limit };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getConfig();
  const db = await getDbAsync();

  const targetModel = cfg.EMBEDDING_MODEL;
  const whereClause = args.force
    ? '1=1'
    : `(embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?)`;
  const whereParams = args.force ? [] : [targetModel];

  const total = Number(
    (db.prepare(
      `SELECT COUNT(*) AS n FROM claim_review WHERE ${whereClause}`,
    ).get(...whereParams) as { n: number }).n,
  );

  if (total === 0) {
    logger.info({ model: targetModel }, 'embed-rebuild: nothing to do');
    closeDb();
    return;
  }

  const cap = args.limit ?? total;
  logger.info(
    { total, willEmbed: Math.min(cap, total), batchSize: args.batch, model: targetModel, force: args.force },
    'embed-rebuild: starting',
  );

  // Paginate by id > lastId to avoid re-selecting the same rows. Without this,
  // --force mode (where whereClause = '1=1') would loop over rows 1..batch.
  const selectStmt = db.prepare(
    `SELECT id, claim_reviewed FROM claim_review WHERE ${whereClause} AND id > ? ORDER BY id LIMIT ?`,
  );
  const updateStmt = db.prepare(
    `UPDATE claim_review SET embedding = ?, embedding_dim = ?, embedding_model = ? WHERE id = ?`,
  );

  let processed = 0;
  let lastId = 0;
  const tStart = Date.now();
  while (processed < cap) {
    const remaining = cap - processed;
    const take = Math.min(args.batch, remaining);
    const rows = selectStmt.all(...whereParams, lastId, take) as Array<{ id: number; claim_reviewed: string }>;
    if (!rows.length) break;
    lastId = rows[rows.length - 1]!.id;

    // Granite-278m and most small embedding models cap at 512 tokens (~2000
    // chars). Truncate input claims aggressively. We embed the *claim_reviewed*
    // text which is typically already a single sentence.
    const inputs = rows.map((r) => r.claim_reviewed.slice(0, 1500));
    let result;
    try {
      result = await embedBatch(inputs);
    } catch (err) {
      logger.error({ err: (err as Error).message, batchStart: rows[0]?.id }, 'embed batch failed');
      throw err;
    }

    const tx = db.transaction((items: Array<{ id: number; vec: Float32Array }>) => {
      for (const item of items) {
        updateStmt.run(vectorToBlob(item.vec), item.vec.length, targetModel, item.id);
      }
    });
    tx(rows.map((r, i) => ({ id: r.id, vec: result.vectors[i]! })));

    processed += rows.length;
    const dt = (Date.now() - tStart) / 1000;
    const rate = processed / dt;
    const eta = Math.max(0, (cap - processed) / rate);
    if (processed % (args.batch * 10) === 0 || processed === cap) {
      logger.info(
        {
          processed,
          total: cap,
          rate: Math.round(rate * 10) / 10,
          etaSeconds: Math.round(eta),
          dim: result.dim,
        },
        'embed-rebuild progress',
      );
    }
  }

  logger.info({ processed, elapsedSeconds: Math.round((Date.now() - tStart) / 1000) }, 'embed-rebuild done');
  closeDb();
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, 'embed-rebuild failed');
  process.exit(1);
});
