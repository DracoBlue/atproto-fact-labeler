/**
 * Stage 4 — combine retrieval + NLI + aggregation with polarity awareness.
 *
 * Replaces the old `lookupCandidates → normaliseRating → aggregateVerdicts`
 * chain. Concretely:
 *   1) Stage 1 retrieve(claim) → top-K cosine candidates.
 *   2) Stage 3 judgeNli(claim, candidate.claimReviewed) per candidate.
 *   3) Drop `neutral`. Flip publisher verdict on `contradiction`. Pass through
 *      on `entailment`.
 *   4) Aggregate over the surviving set. Returns `null` if 0 survive
 *      (the orchestrator will then skip — equivalent to today's "no match").
 *
 * The flip table embeds the "two claims have identical truth conditions"
 * principle from Full Fact: if the publisher reviewed P and our claim H
 * contradicts P, then a "false" verdict on P implies a "true" verdict on H.
 */
import { getConfig } from '../config/index.ts';
import { logger } from '../util/logger.ts';
import { retrieveCandidates, type RetrieveCandidate } from './retrieve.ts';
import { rerankCandidates } from './rerank.ts';
import { judgeNli, type NliLabel } from './entail.ts';
import {
  aggregateVerdicts,
  normaliseRating,
  type Aggregated,
  type Verdict,
  type NormalisedRating,
} from './normalise-rating.ts';
import type { DbLike } from '../store/runtime-sqlite.ts';

export interface MatchedCandidate extends RetrieveCandidate {
  /** Stage 2 rerank score, undefined when reranking was skipped. */
  rerankScore?: number;
  nliLabel: NliLabel;
  nliConfidence: number;
  /** Normalised publisher verdict BEFORE polarity flip. */
  publisherVerdict: Verdict;
  /** Verdict AFTER polarity flip (== publisherVerdict on entailment). */
  effectiveVerdict: Verdict;
}

export interface MatchingResult {
  /** Final aggregated verdict over surviving (non-neutral) candidates. */
  aggregated: Aggregated | null;
  /** All retrieved candidates with NLI judgments — used as evidence. */
  candidates: MatchedCandidate[];
  /** Diagnostic counters. */
  retrieved: number;
  /** Candidates after Stage 2 rerank (== retrieved when rerank disabled). */
  reranked: number;
  entailed: number;
  contradicted: number;
  neutral: number;
}

export interface MatchingOptions {
  topK?: number;
  minCosine?: number;
  lang?: string;
}

/**
 * The polarity-flip table. Embodies "if P → not Q, then verdict(P) flips for Q."
 *  - false ↔ true
 *  - mixed unchanged (a mixed P is mixed for not-P too)
 *  - outdated → unknown (we cannot infer the negation's currency)
 *  - disputed unchanged
 *  - unknown unchanged
 */
export function flipVerdict(v: Verdict): Verdict {
  switch (v) {
    case 'false':
      return 'true';
    case 'true':
      return 'false';
    case 'outdated':
      return 'unknown';
    case 'mixed':
    case 'disputed':
    case 'unknown':
    default:
      return v;
  }
}

export async function matchClaim(
  claim: string,
  options: MatchingOptions = {},
  db?: DbLike,
): Promise<MatchingResult> {
  const cfg = getConfig();
  const retrieve = await retrieveCandidates(
    claim,
    { topK: options.topK ?? 10, minCosine: options.minCosine },
    db,
  );

  // Stage 2 — relevance rerank. Cuts the top-K=10 down to RERANK_KEEP (default 5)
  // so Stage 3 NLI only runs on the most relevant survivors.
  let postRerank: Array<RetrieveCandidate & { rerankScore?: number }> = retrieve.candidates;
  if (cfg.RERANK_MODE === 'llm' && retrieve.candidates.length > 0) {
    const rer = await rerankCandidates(claim, retrieve.candidates, {
      keep: cfg.RERANK_KEEP,
      threshold: cfg.RERANK_THRESHOLD,
    });
    postRerank = rer.candidates;
    logger.debug(
      { input: retrieve.candidates.length, kept: rer.candidates.length, scores: rer.allScores },
      'matching: post-rerank',
    );
  }

  const matched: MatchedCandidate[] = [];
  let entailed = 0;
  let contradicted = 0;
  let neutral = 0;

  for (const cand of postRerank) {
    const judgment = await judgeNli(claim, cand.claimReviewed);
    if (!judgment) {
      // Treat unparseable as neutral — safe default (drop).
      neutral++;
      matched.push({
        ...cand,
        nliLabel: 'neutral',
        nliConfidence: 0,
        publisherVerdict: 'unknown',
        effectiveVerdict: 'unknown',
      });
      continue;
    }

    const norm = normaliseRating(cand.publisher, cand.ratingNative);
    const publisherVerdict = norm?.verdict ?? 'unknown';
    let effective = publisherVerdict;
    if (judgment.label === 'contradiction') {
      effective = flipVerdict(publisherVerdict);
      contradicted++;
    } else if (judgment.label === 'entailment') {
      entailed++;
    } else {
      neutral++;
    }
    matched.push({
      ...cand,
      nliLabel: judgment.label,
      nliConfidence: judgment.confidence,
      publisherVerdict,
      effectiveVerdict: effective,
    });
  }

  // Build aggregation set from only entailment + contradiction candidates,
  // using the EFFECTIVE verdict (post-flip). Confidence carries over from the
  // publisher rating normalisation, weighted by NLI confidence.
  const aggInputs: NormalisedRating[] = matched
    .filter((m) => m.nliLabel !== 'neutral')
    .map((m) => {
      const baseConf = normaliseRating(m.publisher, m.ratingNative)?.confidence ?? 0.5;
      return {
        verdict: m.effectiveVerdict,
        confidence: baseConf * Math.max(0.3, m.nliConfidence),
        publisherSpecific: !!normaliseRating(m.publisher, m.ratingNative)?.publisherSpecific,
      };
    });

  const aggregated = aggregateVerdicts(aggInputs);

  logger.debug(
    {
      retrieved: retrieve.candidates.length,
      reranked: postRerank.length,
      entailed,
      contradicted,
      neutral,
      aggregatedVerdict: aggregated?.verdict ?? null,
    },
    'matching done',
  );

  return {
    aggregated,
    candidates: matched,
    retrieved: retrieve.candidates.length,
    reranked: postRerank.length,
    entailed,
    contradicted,
    neutral,
  };
}
