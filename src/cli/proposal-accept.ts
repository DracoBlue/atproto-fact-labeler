/**
 * Operator override — manually accept a proposal that the auto-HITL deferred.
 *
 *   pnpm proposal:accept --list                # show deferred proposals
 *   pnpm proposal:accept --id 6                # accept by proposal id
 *   pnpm proposal:accept --id 6 --dry-run      # show what would happen
 *
 * The accept path here mirrors the live decision handler in src/index.ts:
 * mark proposal / claim / verdict as accepted, look up the label value, emit
 * via the LabelerServer (which signs + writes to the wire), then INSERT into
 * label_emit. Operator must stop the live labeler first — the LabelerServer
 * needs the same port and writes the same labels.db.
 */
import { getConfig } from '../config/index.ts';
import { getDb, getDbAsync, closeDb } from '../store/db.ts';
import { createLabelerServer } from '../labels/server.ts';
import { publishClaimVerdict } from '../labels/publish-claim-verdict.ts';
import { verdictToLabel } from '../labels/vocabulary.ts';
import { BskyClient } from '../replier/bsky.ts';
import { logger } from '../util/logger.ts';
import type { Verdict } from '../pipeline/normalise-rating.ts';

interface CliArgs {
  id?: number;
  list: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { list: false, dryRun: false };
  for (const a of argv) {
    if (a === '--list') args.list = true;
    else if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a.startsWith('--id=')) args.id = Number(a.slice('--id='.length));
    else if (a === '--id') {
      // handled by next-arg path is awkward; require --id=N for simplicity
    } else if (a === '--help' || a === '-h') {
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
  process.stderr.write(`Usage: pnpm proposal:accept [--list | --id=N] [--dry-run]

Manually accept a proposal that the auto-HITL deferred.

Options:
  --list           Show currently deferred proposals (no DB writes).
  --id=N           Accept proposal id N. Requires the live labeler to be
                   stopped first; emit goes through a fresh LabelerServer.
  --dry-run        With --id, show the verdict + target without emitting.
  -h, --help       This message.
`);
}

interface DeferredRow {
  proposal_id: number;
  post_uri: string;
  claim_text: string;
  verdict_label: string;
  confidence: number | null;
  decided_at: string | null;
  decision: string | null;
}

function listDeferred(): DeferredRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT p.id          AS proposal_id,
              p.post_uri    AS post_uri,
              c.atomic_text AS claim_text,
              v.label       AS verdict_label,
              v.confidence  AS confidence,
              p.decided_at  AS decided_at,
              p.decision    AS decision
         FROM proposal p
         JOIN claim   c ON c.id = p.claim_id
         JOIN verdict v ON v.id = p.verdict_id
        WHERE p.decision = 'defer' OR p.decision IS NULL
        ORDER BY p.id DESC
        LIMIT 50`,
    )
    .all() as DeferredRow[];
}

async function acceptOne(id: number, dryRun: boolean): Promise<void> {
  const db = getDb();
  const cfg = getConfig();
  const row = db
    .prepare(
      `SELECT p.id          AS proposal_id,
              p.post_uri    AS post_uri,
              p.decision    AS decision,
              p.claim_id    AS claim_id,
              p.verdict_id  AS verdict_id,
              v.label       AS verdict,
              pc.cid        AS post_cid
         FROM proposal p
         JOIN verdict v   ON v.id = p.verdict_id
         JOIN post_cache pc ON pc.uri = p.post_uri
        WHERE p.id = ?`,
    )
    .get(id) as
    | {
        proposal_id: number;
        post_uri: string;
        decision: string | null;
        claim_id: number;
        verdict_id: number;
        verdict: string;
        post_cid: string;
      }
    | undefined;

  if (!row) {
    process.stderr.write(`  No proposal with id=${id}.\n`);
    process.exitCode = 1;
    return;
  }
  if (row.decision === 'accept') {
    process.stderr.write(`  Proposal ${id} is already accepted. Nothing to do.\n`);
    return;
  }
  if (row.decision === 'reject') {
    process.stderr.write(
      `  Proposal ${id} was rejected. Re-running it would require a fresh pipeline pass.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const val = verdictToLabel(row.verdict as Verdict);
  if (!val) {
    process.stderr.write(`  Cannot map verdict='${row.verdict}' to a label value.\n`);
    process.exitCode = 1;
    return;
  }

  process.stderr.write(
    `  Proposal ${id}\n` +
      `    post   ${row.post_uri}\n` +
      `    label  ${val}\n` +
      `    cid    ${row.post_cid}\n`,
  );

  if (dryRun) {
    process.stderr.write(`\n  Dry-run — no label emitted, no DB updates.\n`);
    return;
  }

  const labeler = createLabelerServer();
  try {
    await labeler.start();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      process.stderr.write(
        `\n  proposal:accept needs to start its own LabelerServer to sign + emit the\n` +
          `  label, but the port is already in use — most likely the live labeler is\n` +
          `  still running. Stop it first:\n\n` +
          `    docker compose stop fact-labeler\n` +
          `    docker compose run --rm fact-labeler pnpm proposal:accept --id=${id}\n` +
          `    docker compose start fact-labeler\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  try {
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE proposal SET decision = 'accept', decided_by = ?, decided_at = datetime('now')
          WHERE id = ?`,
      ).run('cli', id);
      db.prepare(`UPDATE claim   SET status = 'accepted' WHERE id = ?`).run(row.claim_id);
      db.prepare(`UPDATE verdict SET status = 'accepted' WHERE id = ?`).run(row.verdict_id);
    });
    tx();

    await labeler.emitLabel({ uri: row.post_uri, cid: row.post_cid, val });
    db.prepare(
      `INSERT INTO label_emit (post_uri, post_cid, val, cts, verdict_id)
       VALUES (?, ?, ?, datetime('now'), ?)`,
    ).run(row.post_uri, row.post_cid, val, row.verdict_id);

    logger.info(
      { proposalId: id, postUri: row.post_uri, val },
      'proposal accepted and label emitted',
    );
    process.stderr.write(`\n  Accepted. Label '${val}' emitted on ${row.post_uri}.\n`);

    // Publish the canonical claimVerdict atproto record (best-effort).
    // Requires LABELER_BSKY_* creds; without them we just skip — the wire
    // label is already out.
    if (cfg.LABELER_BSKY_IDENTIFIER && cfg.LABELER_BSKY_APP_PASSWORD) {
      const bsky = new BskyClient({
        serviceUrl: cfg.LABELER_BSKY_SERVICE,
        identifier: cfg.LABELER_BSKY_IDENTIFIER,
        password: cfg.LABELER_BSKY_APP_PASSWORD,
      });
      const publishResult = await publishClaimVerdict(db, bsky, id);
      if (publishResult.status === 'published') {
        process.stderr.write(`  Published atproto record: ${publishResult.atprotoUri}\n`);
      } else if (publishResult.status === 'failed') {
        process.stderr.write(`  ⚠ atproto record publish failed: ${publishResult.reason}\n`);
      }
    }
  } finally {
    await labeler.stop();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  getConfig();
  await getDbAsync();

  try {
    if (args.list) {
      const rows = listDeferred();
      if (!rows.length) {
        process.stderr.write(`  No deferred proposals.\n`);
        return;
      }
      process.stderr.write(`  ${rows.length} deferred proposal(s):\n\n`);
      for (const r of rows) {
        process.stderr.write(
          `    #${r.proposal_id}  verdict=${r.verdict_label}  conf=${r.confidence ?? '?'}\n` +
            `      uri=${r.post_uri}\n` +
            `      claim="${r.claim_text}"\n`,
        );
      }
      process.stderr.write(
        `\n  To accept one: pnpm proposal:accept --id=<N>\n` +
          `  (Stop the live labeler first; see docs/LIFECYCLE.md.)\n`,
      );
      return;
    }

    if (args.id === undefined || Number.isNaN(args.id)) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    await acceptOne(args.id, args.dryRun);
  } finally {
    closeDb();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'proposal:accept failed');
  process.exitCode = 1;
});
