/**
 * Retire emitted labels — variant C of the operator lifecycle.
 *
 * Emits a `neg=true` companion for every label that is currently visible on
 * the wire. AppViews stop hydrating the negated labels; end users stop seeing
 * them. Idempotent: re-running after a crash skips already-negated labels.
 *
 *   pnpm tsx src/cli/retire.ts [--dry-run] [--val=...] [--uri=...]
 *
 * Filters:
 *   --val=<label-value>   Repeatable. Only negate labels with this val.
 *   --uri=<at://...>      Repeatable. Only negate labels on this post.
 *   --dry-run             Print what would be done; touch nothing.
 *
 * The script signs each negation with the local secp256k1 key and writes it
 * to the labeler-server's own SQLite (the same way the live pipeline does).
 * On-wire subscribers receive each negation via `subscribeLabels`.
 */
import { getConfig } from '../config/index.ts';
import { getDb, getDbAsync, closeDb } from '../store/db.ts';
import { logger } from '../util/logger.ts';
import { createLabelerServer } from '../labels/server.ts';
import { retireLiveLabels, type RetireFilter } from '../labels/lifecycle.ts';

interface CliArgs {
  dryRun: boolean;
  filter: RetireFilter;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, filter: {} };
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a.startsWith('--val=')) (args.filter.vals ??= []).push(a.slice('--val='.length));
    else if (a.startsWith('--uri=')) (args.filter.uris ??= []).push(a.slice('--uri='.length));
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      logger.error({ flag: a }, 'unknown flag');
      printUsage();
      process.exit(1);
    }
  }
  return args;
}

function printUsage(): void {
  process.stderr.write(`Usage: pnpm tsx src/cli/retire.ts [--dry-run] [--val=...] [--uri=...]

Emit a neg=true companion for every currently-live label.

Options:
  --dry-run           Show what would be negated; touch nothing.
  --val=VAL           Filter by label value (repeatable).
  --uri=URI           Filter by post URI (repeatable).
  -h, --help          This message.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  getConfig();
  await getDbAsync();
  const db = getDb();

  const labeler = createLabelerServer();
  if (!args.dryRun) {
    await labeler.start();
  }

  try {
    const result = await retireLiveLabels(db, {
      dryRun: args.dryRun,
      filter: args.filter,
      emit: args.dryRun
        ? undefined
        : async (label) => {
            await labeler.emitLabel(label);
          },
      onLabel: (label, i, total) => {
        process.stderr.write(
          `[${i + 1}/${total}] ${args.dryRun ? 'would negate' : 'negating'} ${label.val} on ${label.postUri}\n`,
        );
      },
    });

    logger.info(result, args.dryRun ? 'dry-run complete' : 'retire complete');
    if (args.dryRun) {
      process.stderr.write(
        `\n  Dry-run only — no labels were emitted. Re-run without --dry-run to apply.\n`,
      );
    } else if (result.negated === 0) {
      process.stderr.write(
        `\n  Nothing to retire. All matching labels are already negated.\n`,
      );
    } else {
      process.stderr.write(
        `\n  Retired ${result.negated} label(s). AppViews will stop hydrating them on next sync.\n` +
          `  Existing subscribers receive the negations via subscribeLabels in real time.\n`,
      );
    }
  } finally {
    if (!args.dryRun) await labeler.stop();
    closeDb();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'retire failed');
  process.exitCode = 1;
});
