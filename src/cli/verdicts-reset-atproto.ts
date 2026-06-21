/**
 * Drop the atproto-record reference for selected verdict rows.
 *
 *   - calls `deleteRecord` on the labeler's PDS for each verdict's at-uri
 *     (404 is treated as success — record already gone)
 *   - NULLs `verdict.atproto_uri` + `verdict.atproto_cid` in SQLite
 *
 * The next `pnpm verdicts:backfill` run picks these verdicts up again and
 * republishes them. Use when an earlier schema iteration shipped records
 * with a now-invalid field shape (e.g. float `confidence` before the
 * integer×1000 migration) and the cleanest fix is to redo them.
 *
 *   pnpm verdicts:reset-atproto --id=21 --id=22 --id=23
 *   pnpm verdicts:reset-atproto --id=21 --dry-run
 */
import { getConfig } from '../config/index.ts';
import { getDb, getDbAsync, closeDb } from '../store/db.ts';
import { logger } from '../util/logger.ts';
import { BskyClient } from '../replier/bsky.ts';
import { deleteClaimVerdict } from '../labels/retire-claim-verdict.ts';

interface CliArgs {
  ids: number[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { ids: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--id') args.ids.push(Number(argv[++i]));
    else if (a.startsWith('--id=')) args.ids.push(Number(a.slice('--id='.length)));
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      process.stderr.write(`unknown flag: ${a}\n`);
      printUsage();
      process.exit(1);
    }
  }
  args.ids = args.ids.filter((n) => Number.isInteger(n));
  return args;
}

function printUsage(): void {
  process.stderr.write(`Usage: pnpm verdicts:reset-atproto --id=<N> [--id=<M> ...] [--dry-run]

Delete the on-PDS claimVerdict record for each verdict id, then NULL the
atproto_uri/cid columns so the next pnpm verdicts:backfill republishes them.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.ids.length === 0) {
    printUsage();
    process.exit(1);
  }
  const cfg = getConfig();
  await getDbAsync();
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, post_uri, atproto_uri, atproto_cid
         FROM verdict
        WHERE id IN (${args.ids.map(() => '?').join(',')})`,
    )
    .all(...args.ids) as Array<{
      id: number;
      post_uri: string;
      atproto_uri: string | null;
      atproto_cid: string | null;
    }>;

  if (rows.length === 0) {
    process.stderr.write(`No matching verdict rows for ids ${args.ids.join(', ')}.\n`);
    closeDb();
    return;
  }

  for (const r of rows) {
    process.stderr.write(
      `  verdict #${r.id}  ${r.post_uri}  atproto_uri=${r.atproto_uri ?? '(none)'}\n`,
    );
  }

  if (args.dryRun) {
    process.stderr.write(`\nDry-run — nothing changed.\n`);
    closeDb();
    return;
  }

  if (!cfg.LABELER_BSKY_IDENTIFIER || !cfg.LABELER_BSKY_APP_PASSWORD) {
    throw new Error(
      'LABELER_BSKY_IDENTIFIER + LABELER_BSKY_APP_PASSWORD are required.',
    );
  }
  const bsky = new BskyClient({
    serviceUrl: cfg.LABELER_BSKY_SERVICE,
    identifier: cfg.LABELER_BSKY_IDENTIFIER,
    password: cfg.LABELER_BSKY_APP_PASSWORD,
  });
  await bsky.login();

  const clearStmt = db.prepare(
    'UPDATE verdict SET atproto_uri = NULL, atproto_cid = NULL WHERE id = ?',
  );

  let deleted = 0;
  let cleared = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.atproto_uri) {
      const res = await deleteClaimVerdict(bsky, r.atproto_uri);
      if (res.status === 'deleted') {
        deleted++;
        logger.info({ verdictId: r.id, atUri: r.atproto_uri, note: res.reason }, 'reset: PDS record deleted');
      } else {
        failed++;
        logger.warn({ verdictId: r.id, status: res.status, reason: res.reason }, 'reset: PDS delete failed; clearing local row anyway');
      }
    }
    clearStmt.run(r.id);
    cleared++;
  }

  process.stderr.write(
    `\n  PDS records deleted: ${deleted}\n  Local rows cleared:  ${cleared}\n  Delete failures:     ${failed}\n` +
      `\nNext step:  pnpm verdicts:backfill\n`,
  );
  closeDb();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'verdicts:reset-atproto crashed');
  process.exitCode = 1;
});
