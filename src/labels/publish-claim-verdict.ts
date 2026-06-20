/**
 * The publish-claim-verdict path: load the relevant rows for a proposal,
 * build the record body, createRecord on the labeler's PDS, stamp the
 * resulting at-uri/cid back on the verdict row, and clear the proposal's
 * evidence_snapshot. Shared between the live `onDecision` path in
 * src/index.ts and the operator override in src/cli/proposal-accept.ts.
 */
import { type EvidenceSnapshot } from '../pipeline/orchestrator.ts';
import { CLAIM_VERDICT_NSID, buildClaimVerdictRecord } from './atproto-verdict.ts';
import type { BskyClient } from '../replier/bsky.ts';
import type { DbLike } from '../store/runtime-sqlite.ts';
import { logger } from '../util/logger.ts';

export interface PublishResult {
  status: 'published' | 'skipped-no-snapshot' | 'skipped-no-row' | 'failed';
  atprotoUri?: string;
  atprotoCid?: string;
  reason?: string;
}

interface ProposalJoinRow {
  proposal_id: number;
  evidence_snapshot: string | null;
  verdict_id: number;
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

const SELECT_PROPOSAL_JOIN = `
  SELECT p.id              AS proposal_id,
         p.evidence_snapshot AS evidence_snapshot,
         v.id              AS verdict_id,
         v.label           AS verdict,
         v.confidence      AS confidence,
         v.rationale       AS rationale,
         v.verified_at     AS verified_at,
         v.valid_at        AS valid_at,
         c.atomic_text     AS claim_text,
         c.decontextualized_text AS decontextualized_text,
         p.post_uri        AS post_uri,
         pc.cid            AS post_cid
    FROM proposal p
    JOIN verdict v   ON v.id = p.verdict_id
    JOIN claim c     ON c.id = p.claim_id
    JOIN post_cache pc ON pc.uri = p.post_uri
   WHERE p.id = ?
`;

export async function publishClaimVerdict(
  db: DbLike,
  bsky: BskyClient,
  proposalId: number,
): Promise<PublishResult> {
  const row = db.prepare(SELECT_PROPOSAL_JOIN).get(proposalId) as ProposalJoinRow | undefined;
  if (!row) return { status: 'skipped-no-row', reason: 'no joinable rows for this proposalId' };
  if (!row.evidence_snapshot) {
    // Pre-migration verdicts don't carry a snapshot. Detail server falls
    // back to the legacy evidence-table render for those.
    return { status: 'skipped-no-snapshot' };
  }

  let snapshot: EvidenceSnapshot;
  try {
    snapshot = JSON.parse(row.evidence_snapshot) as EvidenceSnapshot;
  } catch (err) {
    return { status: 'failed', reason: `snapshot is not valid JSON: ${(err as Error).message}` };
  }

  let record: Record<string, unknown>;
  try {
    record = buildClaimVerdictRecord({
      subject: { uri: row.post_uri, cid: row.post_cid },
      claimText: row.claim_text,
      decontextualizedText: row.decontextualized_text,
      verdict: row.verdict as Parameters<typeof buildClaimVerdictRecord>[0]['verdict'],
      confidence: row.confidence,
      snapshot,
      rationale: row.rationale,
      verifiedAt: row.verified_at,
      validAt: row.valid_at,
    });
  } catch (err) {
    return { status: 'failed', reason: `build failed: ${(err as Error).message}` };
  }

  try {
    const result = await bsky.createRecordTyped(CLAIM_VERDICT_NSID, record);
    db.prepare('UPDATE verdict SET atproto_uri = ?, atproto_cid = ? WHERE id = ?').run(
      result.uri,
      result.cid,
      row.verdict_id,
    );
    db.prepare('UPDATE proposal SET evidence_snapshot = NULL WHERE id = ?').run(proposalId);
    logger.info(
      { proposalId, verdictId: row.verdict_id, atprotoUri: result.uri },
      'claimVerdict: published',
    );
    return { status: 'published', atprotoUri: result.uri, atprotoCid: result.cid };
  } catch (err) {
    return { status: 'failed', reason: (err as Error).message };
  }
}
