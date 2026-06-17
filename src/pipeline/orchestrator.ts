/**
 * Pipeline orchestrator. For every ingested post:
 *
 *   S0 ingest    → already done by caller
 *   S1 extract   → LLM atomic claim list
 *   S2 lookup    → FTS over ClaimReview index
 *   S3 normalise → publisher rating → internal verdict
 *   S5 propose   → write a proposal to the HITL queue
 *
 * Each proposal carries enough context for a human or auto-accept policy to decide.
 */
import { getDb } from '../store/db.ts';
import type { DbLike } from '../store/runtime-sqlite.ts';
import { logger } from '../util/logger.ts';
import type { IngestedPost } from '../ingest/types.ts';
import { extractClaims } from './extract.ts';
import { lookupCandidates, type LookupCandidate } from './lookup.ts';
import {
  aggregateVerdicts,
  normaliseRating,
  type Aggregated,
} from './normalise-rating.ts';

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
  evidence: LookupCandidate[];
}

export interface PipelineEnv {
  db?: DbLike;
  /** Skip the LLM extraction call; use this fallback list instead (testing only). */
  extractStub?: (post: IngestedPost) => ReturnType<typeof extractClaims>;
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

const INSERT_EVIDENCE = `
  INSERT INTO evidence
    (verdict_id, source_url, publisher, rating_native, reviewed_at,
     retrieval_method, license, attribution, claim_review_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_PROPOSAL = `
  INSERT INTO proposal (post_uri, claim_id, verdict_id)
  VALUES (?, ?, ?)
`;

export async function processPost(
  post: IngestedPost,
  env: PipelineEnv = {},
): Promise<Proposal[]> {
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

  if (!extracted.claims.length) {
    logger.debug({ uri: post.uri }, 'no claims extracted');
    return [];
  }

  const proposals: Proposal[] = [];

  for (const c of extracted.claims) {
    if (!c.is_falsifiable) continue;
    if ((c.confidence ?? 0) < 0.45) continue;

    // S2 — lookup.
    const lookup = lookupCandidates(c.decontextualized_text || c.atomic_text, {
      lang: c.lang ?? post.lang,
      topK: 5,
    }, db);

    if (!lookup.candidates.length) {
      logger.debug({ claim: c.atomic_text }, 'no claim-review match, skipping');
      continue;
    }

    // S3 — normalise + aggregate.
    const normalised = lookup.candidates
      .map((cand) => normaliseRating(cand.publisher, cand.ratingNative))
      .filter(<T,>(v: T | null): v is T => v !== null);

    if (!normalised.length) continue;

    const agg = aggregateVerdicts(normalised);
    if (!agg) continue;

    // S5 — persist claim, verdict, evidence, proposal.
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

    const verdictResult = db.prepare(INSERT_VERDICT).run(
      claimId,
      post.uri,
      agg.verdict,
      lookup.candidates[0]?.reviewDate ?? null,
      'feed',
      lookup.candidates.map((cand) => cand.publisher).join(','),
      agg.confidence,
      `Aggregated from ${agg.votes} fact-check(s); agreement=${agg.agreement}.`,
    );
    const verdictId = Number(verdictResult.lastInsertRowid);

    const evidenceStmt = db.prepare(INSERT_EVIDENCE);
    for (const cand of lookup.candidates) {
      evidenceStmt.run(
        verdictId,
        cand.sourceUrl,
        cand.publisher,
        cand.ratingNative,
        cand.reviewDate,
        'claim_review_fts',
        'see sd_license',
        cand.attribution,
        cand.id,
      );
    }

    const proposalResult = db.prepare(INSERT_PROPOSAL).run(post.uri, claimId, verdictId);
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
      evidence: lookup.candidates,
    });
  }

  return proposals;
}
