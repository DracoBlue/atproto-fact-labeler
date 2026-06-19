/**
 * Re-run the language detector over already-ingested `claim_review` rows.
 *
 * The original ingester used URL/TLD heuristics that left ~70 % of the
 * corpus untagged and stamped some rows with garbage codes ('in', 'au',
 * 'cn'). This CLI walks every row and rewrites `lang` using the same
 * `detectLang()` that ingest now uses for new entries.
 *
 *   pnpm cli:lang-rebuild               # rewrite every row
 *   pnpm cli:lang-rebuild --null-only   # only touch rows whose lang IS NULL
 *   pnpm cli:lang-rebuild --dry-run     # report changes without writing
 *
 * Idempotent — re-running on a fresh DB is a no-op.
 */
import { detectLang } from '../ingest/detect-lang.ts';
import { getDb, getDbAsync, closeDb } from '../store/db.ts';
import { logger } from '../util/logger.ts';

interface CliArgs {
  dryRun: boolean;
  nullOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, nullOnly: false };
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--null-only') args.nullOnly = true;
    else if (a === '--help' || a === '-h') {
      process.stderr.write(`Usage: pnpm cli:lang-rebuild [--dry-run] [--null-only]\n`);
      process.exit(0);
    } else {
      process.stderr.write(`unknown flag: ${a}\n`);
      process.exit(1);
    }
  }
  return args;
}

interface Row {
  id: number;
  claim_reviewed: string;
  lang: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await getDbAsync();
  const db = getDb();

  const rows = db
    .prepare(
      args.nullOnly
        ? 'SELECT id, claim_reviewed, lang FROM claim_review WHERE lang IS NULL'
        : 'SELECT id, claim_reviewed, lang FROM claim_review',
    )
    .all() as Row[];

  logger.info({ scanned: rows.length, mode: args.nullOnly ? 'null-only' : 'all' }, 'lang-rebuild start');

  const update = db.prepare('UPDATE claim_review SET lang = ? WHERE id = ?');
  let changed = 0;
  let cleared = 0;
  let unchanged = 0;
  const newDist = new Map<string, number>();

  const tx = db.transaction((batch: Array<{ id: number; lang: string | null }>) => {
    for (const r of batch) update.run(r.lang, r.id);
  });

  const buffer: Array<{ id: number; lang: string | null }> = [];
  for (const r of rows) {
    const detected = detectLang(r.claim_reviewed);
    newDist.set(detected ?? '<null>', (newDist.get(detected ?? '<null>') ?? 0) + 1);
    if (detected === r.lang) {
      unchanged++;
      continue;
    }
    if (detected === null && r.lang !== null) cleared++;
    else changed++;
    buffer.push({ id: r.id, lang: detected });
    if (!args.dryRun && buffer.length >= 1000) {
      tx(buffer.splice(0, buffer.length));
    }
  }
  if (!args.dryRun && buffer.length) tx(buffer);

  logger.info(
    {
      scanned: rows.length,
      changed,
      cleared,
      unchanged,
      dryRun: args.dryRun,
    },
    args.dryRun ? 'lang-rebuild dry-run summary' : 'lang-rebuild done',
  );

  const top = [...newDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  process.stderr.write(`\n  New lang distribution (top 12):\n`);
  for (const [code, n] of top) process.stderr.write(`    ${code.padEnd(8)} ${n}\n`);

  closeDb();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'lang-rebuild crashed');
  process.exitCode = 1;
});
