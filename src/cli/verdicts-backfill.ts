/**
 * Backfill `app.kiesel.facts.claimVerdict` records for every locally-accepted
 * verdict that does not yet have one on the labeler's PDS.
 *
 * Pre-migration verdicts (accepted before the lexicon work landed) have:
 *   verdict.atproto_uri IS NULL
 *   proposal.evidence_snapshot IS NULL
 *   legacy `evidence` rows populated
 *
 * For each such verdict we read the evidence rows, synthesise a snapshot in
 * the shape orchestrator would have written today, build the record, and
 * publish it.
 *
 * Idempotent — re-runs only touch rows where atproto_uri is still NULL. Safe
 * to run while the live labeler is up (UPDATE on a single column per row).
 *
 *   pnpm verdicts:backfill              # backfill all eligible verdicts
 *   pnpm verdicts:backfill --dry-run    # show what would be published
 *   pnpm verdicts:backfill --limit N    # cap to N records this run
 */
import { getConfig } from '../config/index.ts';
import { getDb, getDbAsync, closeDb } from '../store/db.ts';
import { logger } from '../util/logger.ts';
import { BskyClient } from '../replier/bsky.ts';
import { buildClaimVerdictRecord, CLAIM_VERDICT_NSID } from '../labels/atproto-verdict.ts';
import type { EvidenceSnapshot } from '../pipeline/orchestrator.ts';
import type { Verdict } from '../pipeline/normalise-rating.ts';

interface CliArgs {
  dryRun: boolean;
  limit: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--limit') args.limit = Number(argv[++i] ?? Infinity);
    else if (a.startsWith('--limit=')) args.limit = Number(a.slice('--limit='.length));
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      process.stderr.write(`unknown flag: ${a}\n`);
      printUsage();
      process.exit(1);
    }
  }
  return args;
}

function printUsage(): void {
  process.stderr.write(`Usage: pnpm verdicts:backfill [--dry-run] [--limit N]

For every accepted-and-live verdict that does not yet have an
app.kiesel.facts.claimVerdict atproto record, build one from the
legacy evidence rows and publish it on the labeler PDS.

Options:
  --dry-run        Print what would be published. No PDS writes.
  --limit N        Cap the number of records published in this run.
  -h, --help       This message.
`);
}

interface BackfillRow {
  verdict_id: number;
  proposal_id: number;
  claim_id: number;
  verdict: string;
  confidence: number | null;
  rationale: string | null;
  verified_at: string;
  valid_at: string | null;
  claim_text: string;
  decontextualized_text: string | null;
  post_uri: string;
  post_cid: string;
}

interface EvidenceRow {
  source_url: string;
  publisher: string;
  rating_native: string | null;
  reviewed_at: string | null;
  attribution: string;
  retrieval_method: string | null;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function inferIntakePath(attribution: string): EvidenceSnapshot['evidence'][number]['intakePath'] {
  if (/Google Fact Check Tools API/i.test(attribution)) return 'factcheck-api';
  if (/Google Data Commons/i.test(attribution)) return 'bulk-feed';
  return 'self-published';
}

/**
 * Convert the retrieval_method column ('dense+nli:entailment' /
 * 'dense+nli:contradiction' / 'dense+nli:neutral') to the lexicon polarity.
 */
function inferPolarity(
  retrieval_method: string | null,
): EvidenceSnapshot['evidence'][number]['polarity'] {
  if (!retrieval_method) return 'neutral';
  if (/entail/i.test(retrieval_method)) return 'entail';
  if (/contradict/i.test(retrieval_method)) return 'contradict';
  return 'neutral';
}

function buildSyntheticSnapshot(rows: EvidenceRow[]): EvidenceSnapshot {
  const evidence = rows.map((r) => ({
    polarity: inferPolarity(r.retrieval_method),
    intakePath: inferIntakePath(r.attribution),
    attribution: r.attribution,
    externalSource: {
      publisherName: r.publisher,
      publisherSite: hostOf(r.source_url),
      sourceUrl: r.source_url,
      claimReviewed: '',
      ratingNative: r.rating_native ?? undefined,
      reviewDate: r.reviewed_at ?? undefined,
    },
  }));
  const voteBreakdown = {
    entail: evidence.filter((e) => e.polarity === 'entail').length,
    contradict: evidence.filter((e) => e.polarity === 'contradict').length,
    neutral: evidence.filter((e) => e.polarity === 'neutral').length,
  };
  return { evidence, voteBreakdown };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getConfig();
  await getDbAsync();
  const db = getDb();

  const candidates = db
    .prepare(
      `SELECT v.id              AS verdict_id,
              p.id              AS proposal_id,
              c.id              AS claim_id,
              v.label           AS verdict,
              v.confidence      AS confidence,
              v.rationale       AS rationale,
              v.verified_at     AS verified_at,
              v.valid_at        AS valid_at,
              c.atomic_text     AS claim_text,
              c.decontextualized_text AS decontextualized_text,
              v.post_uri        AS post_uri,
              pc.cid            AS post_cid
         FROM verdict v
         JOIN claim c ON c.id = v.claim_id
         JOIN proposal p ON p.verdict_id = v.id
         JOIN post_cache pc ON pc.uri = v.post_uri
        WHERE v.status = 'accepted'
          AND v.retired_at IS NULL
          AND v.atproto_uri IS NULL
        ORDER BY v.id
        LIMIT ?`,
    )
    .all(Number.isFinite(args.limit) ? args.limit : 1_000_000) as BackfillRow[];

  if (candidates.length === 0) {
    process.stderr.write(`Nothing to backfill — every accepted verdict already has an atproto_uri.\n`);
    closeDb();
    return;
  }

  process.stderr.write(
    `Found ${candidates.length} accepted verdict(s) without an atproto record.\n` +
      (args.dryRun ? '\nDry-run — no records will be written.\n' : ''),
  );

  if (args.dryRun) {
    for (const row of candidates) {
      process.stderr.write(
        `  verdict #${row.verdict_id}: ${row.verdict} on ${row.post_uri}\n`,
      );
    }
    closeDb();
    return;
  }

  if (!cfg.LABELER_BSKY_IDENTIFIER || !cfg.LABELER_BSKY_APP_PASSWORD) {
    throw new Error(
      'LABELER_BSKY_IDENTIFIER + LABELER_BSKY_APP_PASSWORD are required to publish.',
    );
  }
  const bsky = new BskyClient({
    serviceUrl: cfg.LABELER_BSKY_SERVICE,
    identifier: cfg.LABELER_BSKY_IDENTIFIER,
    password: cfg.LABELER_BSKY_APP_PASSWORD,
  });
  await bsky.login();

  const selectEvidence = db.prepare(
    `SELECT source_url, publisher, rating_native, reviewed_at, attribution, retrieval_method
       FROM evidence
      WHERE verdict_id = ?
      ORDER BY id`,
  );
  const updateVerdict = db.prepare(
    `UPDATE verdict SET atproto_uri = ?, atproto_cid = ? WHERE id = ?`,
  );

  let published = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of candidates) {
    const evidenceRows = selectEvidence.all(row.verdict_id) as EvidenceRow[];
    if (evidenceRows.length === 0) {
      // No legacy evidence rows — nothing to reconstruct from. Skip.
      logger.warn(
        { verdictId: row.verdict_id, postUri: row.post_uri },
        'backfill: no evidence rows to synthesise from, skipping',
      );
      skipped++;
      continue;
    }
    const snapshot = buildSyntheticSnapshot(evidenceRows);
    let record: Record<string, unknown>;
    try {
      record = buildClaimVerdictRecord({
        subject: { uri: row.post_uri, cid: row.post_cid },
        claimText: row.claim_text,
        decontextualizedText: row.decontextualized_text,
        verdict: row.verdict as Verdict,
        confidence: row.confidence,
        snapshot,
        rationale: row.rationale,
        verifiedAt: row.verified_at,
        validAt: row.valid_at,
      });
    } catch (err) {
      logger.error({ err, verdictId: row.verdict_id }, 'backfill: build failed');
      failed++;
      continue;
    }
    try {
      const result = await bsky.createRecordTyped(CLAIM_VERDICT_NSID, record);
      updateVerdict.run(result.uri, result.cid, row.verdict_id);
      logger.info(
        { verdictId: row.verdict_id, atprotoUri: result.uri },
        'backfill: published',
      );
      published++;
    } catch (err) {
      logger.error(
        { err: (err as Error).message, verdictId: row.verdict_id },
        'backfill: createRecord failed',
      );
      failed++;
    }
  }

  process.stderr.write(
    `\n  Published: ${published}\n  Skipped:   ${skipped} (no legacy evidence rows)\n  Failed:    ${failed}\n`,
  );
  if (failed > 0) process.exitCode = 1;
  closeDb();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'verdicts:backfill crashed');
  process.exitCode = 1;
});
