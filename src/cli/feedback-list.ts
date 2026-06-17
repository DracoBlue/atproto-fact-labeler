/**
 * pnpm run feedback:list [--since 2026-06-01] [--unresolved] [--limit 50]
 *
 * Prints recent user feedback (reports filed against the labeler's own posts).
 * Default: 50 most recent rows, regardless of resolution state.
 */
import { getConfig } from '../config/index.ts';
import { getDb, getDbAsync, closeDb } from '../store/db.ts';
import { listFeedback } from '../feedback/store.ts';

interface CliArgs {
  since?: string;
  onlyUnresolved: boolean;
  limit: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { onlyUnresolved: false, limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--unresolved' || a === '-u') args.onlyUnresolved = true;
    else if (a === '--since' && argv[i + 1]) {
      args.since = argv[++i];
    } else if (a === '--limit' && argv[i + 1]) {
      args.limit = Number(argv[++i]) || args.limit;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      process.stderr.write(`Unknown flag: ${a}\n`);
      printUsage();
      process.exit(1);
    }
  }
  return args;
}

function printUsage(): void {
  process.stderr.write(`Usage: pnpm tsx src/cli/feedback-list.ts [--since DATE] [--unresolved] [--limit N]

Show user reports filed against the labeler's own posts.

Options:
  --since DATE   Only entries reported on or after DATE (ISO-8601).
  --unresolved   Only rows that have not been marked resolved.
  --limit N      Cap rows printed (default 50, max 500).
  -h, --help     This message.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  getConfig();
  await getDbAsync();
  const rows = listFeedback(getDb(), {
    since: args.since,
    onlyUnresolved: args.onlyUnresolved,
    limit: args.limit,
  });

  if (rows.length === 0) {
    process.stdout.write('No feedback rows match the query.\n');
    closeDb();
    return;
  }

  process.stdout.write(`\nFeedback (${rows.length} row${rows.length === 1 ? '' : 's'})\n`);
  process.stdout.write('='.repeat(72) + '\n');
  for (const row of rows) {
    const status = row.resolvedAt ? `resolved (${row.resolvedAt})` : 'open';
    process.stdout.write(
      `\n#${row.id}  ${row.reportedAt}  [${status}]\n` +
        `  subject : ${row.subjectUri}\n`,
    );
    if (row.reasonType) {
      process.stdout.write(`  type    : ${row.reasonType}\n`);
    }
    if (row.reason) {
      process.stdout.write(`  reason  : ${row.reason}\n`);
    }
    if (row.resolution) {
      process.stdout.write(`  result  : ${row.resolution}\n`);
    }
  }
  process.stdout.write('\n');
  closeDb();
}

main().catch((err: unknown) => {
  process.stderr.write(`feedback-list failed: ${(err as Error).message ?? err}\n`);
  process.exitCode = 1;
});
