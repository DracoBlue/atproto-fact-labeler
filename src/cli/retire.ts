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
import { BskyClient } from '../replier/bsky.ts';
import {
  deleteClaimVerdict,
  tombstoneClaimVerdict,
  summariseRetireResults,
  type RetireResultItem,
} from '../labels/retire-claim-verdict.ts';

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
    try {
      await labeler.start();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        process.stderr.write(
          `\n  retire needs to start its own LabelerServer to sign + emit the negations,\n` +
            `  but the labeler port is already in use — most likely the live labeler is\n` +
            `  still running. Stop it first, then re-run retire, then start it again:\n\n` +
            `    docker compose stop fact-labeler\n` +
            `    docker compose run --rm fact-labeler pnpm retire\n` +
            `    docker compose start fact-labeler\n\n` +
            `  Both processes would otherwise race on the same labels.db file.\n`,
        );
        process.exitCode = 1;
        return;
      }
      throw err;
    }
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

    // After the wire-label negation, drop / tombstone the corresponding
    // app.kiesel.facts.claimVerdict records on the labeler PDS. The labeler
    // server's own DID + creds are reused; if not configured, skip silently.
    if (!args.dryRun && result.retiredAtprotoUris.length > 0) {
      await retireClaimVerdictRecords(result.retiredAtprotoUris);
    }
  } finally {
    if (!args.dryRun) await labeler.stop();
    closeDb();
  }
}

/**
 * Drop or tombstone the listed claimVerdict records on the labeler PDS.
 * Mode is the operator-configured ATPROTO_RETIRE_MODE. Best-effort: a
 * failure here does NOT roll back the wire-label retraction — the label
 * is already off the wire and the record will be picked up by a future
 * verdicts:backfill run if needed.
 */
async function retireClaimVerdictRecords(atUris: string[]): Promise<void> {
  const cfg = getConfig();
  if (!cfg.LABELER_BSKY_IDENTIFIER || !cfg.LABELER_BSKY_APP_PASSWORD) {
    process.stderr.write(
      `\n  Skipped atproto-side retire — LABELER_BSKY_* creds not set.\n` +
        `  Run with creds present to delete/tombstone ${atUris.length} record(s).\n`,
    );
    return;
  }
  const bsky = new BskyClient({
    serviceUrl: cfg.LABELER_BSKY_SERVICE,
    identifier: cfg.LABELER_BSKY_IDENTIFIER,
    password: cfg.LABELER_BSKY_APP_PASSWORD,
  });
  await bsky.login();

  const mode = cfg.ATPROTO_RETIRE_MODE;
  const now = new Date().toISOString();
  const results: RetireResultItem[] = [];
  for (const atUri of atUris) {
    if (mode === 'delete') {
      results.push(await deleteClaimVerdict(bsky, atUri));
      continue;
    }
    // tombstone: fetch the existing record, splice in retiredAt, putRecord.
    const m = atUri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!m) {
      results.push({ atUri, status: 'skipped-no-rkey' });
      continue;
    }
    const [, did, collection, rkey] = m;
    let current: Record<string, unknown> | null = null;
    try {
      const res = await fetch(
        `${cfg.LABELER_BSKY_SERVICE.replace(/\/$/, '')}/xrpc/com.atproto.repo.getRecord` +
          `?repo=${encodeURIComponent(did!)}&collection=${encodeURIComponent(
            collection!,
          )}&rkey=${encodeURIComponent(rkey!)}`,
      );
      if (res.ok) {
        const body = (await res.json()) as { value?: Record<string, unknown> };
        current = body.value ?? null;
      }
    } catch {
      // fall through with current = null
    }
    if (!current) {
      results.push({ atUri, status: 'failed', reason: 'tombstone: getRecord failed' });
      continue;
    }
    results.push(await tombstoneClaimVerdict(bsky, atUri, current, now));
  }

  process.stderr.write(
    `\n  atproto retire (${mode}): ${summariseRetireResults(results)}\n`,
  );
  for (const r of results) {
    if (r.status === 'failed') {
      logger.warn({ atUri: r.atUri, reason: r.reason }, 'atproto retire: failure');
    }
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'retire failed');
  process.exitCode = 1;
});
