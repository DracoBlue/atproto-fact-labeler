/**
 * Pipeline orchestrator. For every ingested post:
 *
 *   S0 ingest    → already done by caller
 *   S1 extract   → LLM atomic claim list
 *   S2 retrieve  → dense embedding cosine top-K (see retrieve.ts)
 *   S3 entail    → NLI polarity judge per candidate (see entail.ts)
 *   S4 match     → drop neutral, flip on contradiction, aggregate
 *   S5 propose   → write a proposal to the HITL queue
 *
 * The retrieve→entail→match chain is implemented in matching.ts.
 * See docs/pipeline/README.md for the architecture rationale.
 */
import { getDb } from '../store/db.ts';
import type { DbLike } from '../store/runtime-sqlite.ts';
import { logger } from '../util/logger.ts';
import type { IngestedPost } from '../ingest/types.ts';
import { extractClaims } from './extract.ts';
import { matchClaim, type MatchedCandidate } from './matching.ts';
import type { Aggregated } from './normalise-rating.ts';

export interface Proposal {
  proposalId: number;
  postUri: string;
  postCid: string;
  postText: string;
  claimId: number;
  verdictId: number;
  claimText: string;
  decontextualized: string;
  verdict: string;
  aggregated: Aggregated | null;
  evidence: MatchedCandidate[];
}

export interface PipelineEnv {
  db?: DbLike;
  /** Skip the LLM extraction call; use this fallback list instead (testing only). */
  extractStub?: (post: IngestedPost) => ReturnType<typeof extractClaims>;
}

/**
 * Trigger context — passed through from the dispatcher when known. Persisted on
 * each proposal so post-decision hooks (e.g. the mention-reply feature) know
 * where the request originated.
 */
export interface TriggerContext {
  reason: string;
  /** When the trigger was a mention, this is the mentioning post's URI. */
  sourceUri?: string;
  sourceCid?: string;
  /** Thread root for the reply, when known. */
  rootUri?: string;
  rootCid?: string;
  /**
   * BCP-47 language tag of the mentioning post. Used to pick reply translations
   * so the bot answers the user in the user's own language.
   */
  sourceLang?: string;
}

/**
 * Diagnostic information returned alongside any proposals. Lets callers see
 * *why* no proposal was emitted (no falsifiable claim vs no ClaimReview match).
 */
export interface PipelineResult {
  proposals: Proposal[];
  extractedClaims: number;
  falsifiableClaims: number;
  claimsWithMatches: number;
}

const INSERT_POST_CACHE = `
  INSERT OR REPLACE INTO post_cache (uri, cid, did, text, lang, indexed_at, seen_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
`;

const INSERT_CLAIM = `
  INSERT INTO claim
    (post_uri, atomic_text, decontextualized_text, span_start, span_end,
     lang, is_falsifiable, entities_json, confidence, extractor_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_VERDICT = `
  INSERT INTO verdict
    (claim_id, post_uri, label, valid_at, verifier_kind, verifier_id, confidence, rationale)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

// The legacy `evidence` table is no longer written to. Evidence lives in
// `proposal.evidence_snapshot` until the HITL decision, then becomes the
// `evidence[]` array of the published claimVerdict atproto record. The
// table schema stays (CREATE IF NOT EXISTS in src/store/db.ts) so existing
// rows from pre-migration verdicts remain readable by the detail server's
// dual-read fallback. New rows are not produced.

const INSERT_PROPOSAL = `
  INSERT INTO proposal
    (post_uri, claim_id, verdict_id,
     trigger_reason, trigger_source_uri, trigger_source_cid,
     trigger_root_uri, trigger_root_cid, trigger_source_lang,
     evidence_snapshot)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Snapshot shape stored on `proposal.evidence_snapshot`. On accept this
 * becomes the `evidence[]` array of the published claimVerdict atproto
 * record verbatim. Shape is intentionally close to the lexicon's
 * `#evidenceItem` definition so the publish step is a near-no-op
 * transformation. See lexicons/app/kiesel/facts/claimVerdict.json.
 */
export interface EvidenceSnapshot {
  evidence: Array<{
    polarity: 'entail' | 'contradict' | 'neutral';
    intakePath: 'self-published' | 'bulk-feed' | 'factcheck-api';
    attribution: string;
    externalSource: {
      publisherName: string;
      publisherSite?: string;
      publisherUrl?: string;
      sourceUrl: string;
      claimReviewed: string;
      ratingNative?: string;
      reviewDate?: string;
      lang?: string;
    };
  }>;
  voteBreakdown: { entail: number; contradict: number; neutral: number };
}

/** Extract the publisher site host from a URL ('https://www.dpa.com/x' → 'dpa.com'). */
function hostOf(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Infer how this candidate entered the pool. Based on the `attribution`
 * string the ingest paths embed (see src/ingest/{claimreview-feed,
 * factcheck-live}.ts and docs/sources/own-claimreviews.md).
 */
function inferIntakePath(attribution: string): EvidenceSnapshot['evidence'][number]['intakePath'] {
  if (/Google Fact Check Tools API/i.test(attribution)) return 'factcheck-api';
  if (/Google Data Commons/i.test(attribution)) return 'bulk-feed';
  return 'self-published';
}

export async function processPost(
  post: IngestedPost,
  env: PipelineEnv = {},
  trigger: TriggerContext = { reason: 'unknown' },
): Promise<PipelineResult> {
  const db = env.db ?? getDb();

  // S0 — persist the post (idempotent).
  db.prepare(INSERT_POST_CACHE).run(
    post.uri,
    post.cid,
    post.did,
    post.text,
    post.lang ?? null,
    post.indexedAt,
  );

  // S1 — extract atomic claims.
  const extracted = env.extractStub
    ? await env.extractStub(post)
    : await extractClaims({ text: post.text, lang: post.lang });

  const proposals: Proposal[] = [];
  let falsifiableClaims = 0;
  let claimsWithMatches = 0;

  if (!extracted.claims.length) {
    logger.debug({ uri: post.uri }, 'no claims extracted');
    return {
      proposals,
      extractedClaims: 0,
      falsifiableClaims: 0,
      claimsWithMatches: 0,
    };
  }

  for (const c of extracted.claims) {
    if (!c.is_falsifiable) continue;
    if ((c.confidence ?? 0) < 0.45) continue;
    falsifiableClaims++;

    // S2..S5 — retrieve + rerank + NLI polarity gate + aggregate. See
    // docs/pipeline/README.md for the three-stage architecture.
    const match = await matchClaim(
      c.decontextualized_text || c.atomic_text,
      { topK: 10, lang: c.lang ?? post.lang },
      db,
    );

    if (!match.candidates.length) {
      logger.debug({ claim: c.atomic_text }, 'no candidates retrieved, skipping');
      continue;
    }
    claimsWithMatches++;

    const agg = match.aggregated;
    if (!agg) {
      logger.debug(
        {
          claim: c.atomic_text,
          retrieved: match.retrieved,
          neutral: match.neutral,
        },
        'all candidates judged neutral, skipping (uncovered)',
      );
      continue;
    }

    // S6 — persist claim, verdict, evidence, proposal.
    const claimResult = db.prepare(INSERT_CLAIM).run(
      post.uri,
      c.atomic_text,
      c.decontextualized_text,
      c.span_start ?? null,
      c.span_end ?? null,
      c.lang ?? post.lang ?? null,
      c.is_falsifiable ? 1 : 0,
      JSON.stringify(c.entities),
      c.confidence ?? null,
      extracted.extractorVersion,
    );
    const claimId = Number(claimResult.lastInsertRowid);

    const survivingCandidates = match.candidates.filter((m) => m.nliLabel !== 'neutral');
    const verdictResult = db.prepare(INSERT_VERDICT).run(
      claimId,
      post.uri,
      agg.verdict,
      survivingCandidates[0]?.reviewDate ?? null,
      'feed',
      survivingCandidates.map((cand) => cand.publisher).join(','),
      agg.confidence,
      `Aggregated from ${agg.votes} fact-check(s); agreement=${agg.agreement}. ` +
        `NLI: ${match.entailed} entail, ${match.contradicted} contradict, ${match.neutral} neutral (dropped).`,
    );
    const verdictId = Number(verdictResult.lastInsertRowid);

    // Build the evidence snapshot that will become the published
    // claimVerdict.evidence[] array on accept. Shape mirrors the lexicon
    // (lexicons/app/kiesel/facts/claimVerdict.json#evidenceItem). Persisted
    // on the proposal row so it survives crashes between pipeline-run and
    // HITL decision (see kiesel-app/facts:docs/DESIGN.md § Option C).
    const snapshot: EvidenceSnapshot = {
      evidence: survivingCandidates.map((cand) => ({
        polarity:
          cand.nliLabel === 'entailment'
            ? 'entail'
            : cand.nliLabel === 'contradiction'
              ? 'contradict'
              : 'neutral',
        intakePath: inferIntakePath(cand.attribution),
        attribution: cand.attribution,
        externalSource: {
          publisherName: cand.publisher,
          publisherSite: hostOf(cand.publisherUrl ?? cand.sourceUrl),
          publisherUrl: cand.publisherUrl ?? undefined,
          sourceUrl: cand.sourceUrl,
          claimReviewed: cand.claimReviewed,
          ratingNative: cand.ratingNative ?? undefined,
          reviewDate: cand.reviewDate ?? undefined,
          lang: cand.lang ?? undefined,
        },
      })),
      voteBreakdown: {
        entail: match.entailed,
        contradict: match.contradicted,
        neutral: match.neutral,
      },
    };

    const proposalResult = db.prepare(INSERT_PROPOSAL).run(
      post.uri,
      claimId,
      verdictId,
      trigger.reason,
      trigger.sourceUri ?? null,
      trigger.sourceCid ?? null,
      trigger.rootUri ?? null,
      trigger.rootCid ?? null,
      trigger.sourceLang ?? null,
      JSON.stringify(snapshot),
    );
    const proposalId = Number(proposalResult.lastInsertRowid);

    proposals.push({
      proposalId,
      postUri: post.uri,
      postCid: post.cid,
      postText: post.text,
      claimId,
      verdictId,
      claimText: c.atomic_text,
      decontextualized: c.decontextualized_text,
      verdict: agg.verdict,
      aggregated: agg,
      evidence: survivingCandidates,
    });
  }

  return {
    proposals,
    extractedClaims: extracted.claims.length,
    falsifiableClaims,
    claimsWithMatches,
  };
}
