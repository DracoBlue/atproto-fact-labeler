/**
 * CLI: remove `claim_review` rows whose publisher is no longer on the allowlist.
 *
 * Pass --dry-run to see counts + a sample without modifying. Otherwise the
 * non-allowlisted rows are deleted (FTS index and evidence rows clean up via
 * existing AFTER DELETE triggers / FK relationships).
 *
 *   pnpm cleanup:claims --dry-run
 *   pnpm cleanup:claims
 */
import { resolve } from 'node:path';

import { getConfig } from '../config/index.ts';
import { PublisherAllowlist } from '../ingest/publisher-allowlist.ts';
import { getDb, getDbAsync } from '../store/db.ts';
import { logger } from '../util/logger.ts';

interface Row {
  id: number;
  source_url: string;
  publisher: string;
  publisher_url: string | null;
}

async function main(): Promise<void> {
  const cfg = getConfig();
  await getDbAsync();
  const db = getDb();
  const dryRun = process.argv.includes('--dry-run');

  const allowlist = PublisherAllowlist.fromFile(resolve(cfg.CLAIMREVIEW_PUBLISHER_ALLOWLIST));
  if (allowlist.size === 0) {
    throw new Error(
      `Allowlist at ${cfg.CLAIMREVIEW_PUBLISHER_ALLOWLIST} is empty — refusing to run (would delete every row).`,
    );
  }

  const all = db
    .prepare('SELECT id, source_url, publisher, publisher_url FROM claim_review')
    .all() as Row[];

  const toDelete: Row[] = [];
  for (const r of all) {
    if (!allowlist.isAllowedUrl(r.publisher_url)) toDelete.push(r);
  }

  logger.info(
    {
      total: all.length,
      toDelete: toDelete.length,
      keep: all.length - toDelete.length,
      allowlistSize: allowlist.size,
    },
    dryRun ? 'cleanup dry-run' : 'cleanup',
  );

  const sample = toDelete.slice(0, 10);
  for (const r of sample) {
    logger.info(
      { id: r.id, publisher: r.publisher, publisher_url: r.publisher_url, source_url: r.source_url },
      'sample row to delete',
    );
  }

  if (dryRun || toDelete.length === 0) return;

  // evidence.claim_review_id references claim_review(id) without ON DELETE.
  // Past verdicts may have cited a row we're about to drop — keep the
  // evidence record as audit trail but NULL the link before the delete,
  // otherwise the FK constraint fires.
  const unlink = db.prepare('UPDATE evidence SET claim_review_id = NULL WHERE claim_review_id = ?');
  const del = db.prepare('DELETE FROM claim_review WHERE id = ?');
  const tx = db.transaction((rows: Row[]) => {
    let unlinkedTotal = 0;
    for (const r of rows) {
      const res = unlink.run(r.id);
      unlinkedTotal += Number(res.changes ?? 0);
      del.run(r.id);
    }
    return unlinkedTotal;
  });
  const unlinked = tx(toDelete);
  logger.info({ deleted: toDelete.length, evidenceUnlinked: unlinked }, 'cleanup complete');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'cleanup-claims crashed');
  process.exitCode = 1;
});
