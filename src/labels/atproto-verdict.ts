/**
 * Build the `app.kiesel.facts.claimVerdict` record body for publication to
 * the labeler's PDS. Pure — no IO, no DB, no Bsky call. Inputs are the
 * pieces already gathered by `onDecision` (claim text, verdict label,
 * post strongRef, evidence snapshot from the proposal).
 *
 * Schema source of truth:
 *   lexicons/app/kiesel/facts/claimVerdict.json
 */
import type { EvidenceSnapshot } from '../pipeline/orchestrator.ts';
import { verdictToLabel } from './vocabulary.ts';
import type { Verdict } from '../pipeline/normalise-rating.ts';

export const CLAIM_VERDICT_NSID = 'app.kiesel.facts.claimVerdict';

export interface BuildClaimVerdictInput {
  /** Post being labeled (the claimVerdict's subject). */
  subject: { uri: string; cid: string };
  /** The atomic claim as extracted from the post. */
  claimText: string;
  /** Standalone version of the claim, when different. */
  decontextualizedText?: string | null;
  /** Internal verdict word: 'true' → 'supported', etc. */
  verdict: Verdict;
  /** Aggregated confidence in [0, 1]. */
  confidence: number | null;
  /** Evidence list + vote breakdown, persisted on the proposal row. */
  snapshot: EvidenceSnapshot;
  /** Optional short rationale text. */
  rationale?: string | null;
  /** When the pipeline produced this verdict. */
  verifiedAt: string;
  /** Optional 'as-of' date the verdict reflects (oldest cited review). */
  validAt?: string | null;
}

/** Verdict mapping internal → record vocabulary. Mirrors verdictToLabel. */
const VERDICT_TO_RECORD: Record<Verdict, string> = {
  true: 'supported',
  false: 'refuted',
  mixed: 'mixed',
  disputed: 'disputed',
  outdated: 'outdated',
  unknown: 'unknown',
};

export function buildClaimVerdictRecord(input: BuildClaimVerdictInput): Record<string, unknown> {
  const recordVerdict = VERDICT_TO_RECORD[input.verdict];
  if (!recordVerdict) {
    throw new Error(`buildClaimVerdictRecord: unmapped verdict '${input.verdict}'`);
  }
  const emittedLabel = verdictToLabel(input.verdict);
  const record: Record<string, unknown> = {
    $type: CLAIM_VERDICT_NSID,
    subject: { uri: input.subject.uri, cid: input.subject.cid },
    claimText: input.claimText,
    verdict: recordVerdict,
    evidence: input.snapshot.evidence,
    voteBreakdown: input.snapshot.voteBreakdown,
    verifiedAt: input.verifiedAt,
  };
  if (
    input.decontextualizedText &&
    input.decontextualizedText.trim() &&
    input.decontextualizedText !== input.claimText
  ) {
    record.decontextualizedText = input.decontextualizedText;
  }
  if (input.confidence !== null) {
    // The atproto data model has no float type — confidence is encoded as an
    // integer in [0, 1000]. The lexicon documents this. Consumers divide by
    // 1000 to recover the [0, 1] value. Clamp to be defensive about pipeline
    // output drift.
    const scaled = Math.round(input.confidence * 1000);
    record.confidence = Math.max(0, Math.min(1000, scaled));
  }
  if (input.rationale) record.rationale = input.rationale;
  if (input.validAt) record.validAt = input.validAt;
  if (emittedLabel) record.emittedLabel = emittedLabel;
  return record;
}
