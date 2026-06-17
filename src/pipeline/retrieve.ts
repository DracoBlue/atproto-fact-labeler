/**
 * Stage 1 — dense retrieval.
 *
 * Embed the incoming claim, cosine against every ClaimReview row whose
 * embedding_model matches the current model, return top-K candidates sorted
 * by cosine descending.
 *
 * Threshold deliberately LOW (~0.55) — see docs/PIPELINE.md § "Why a single
 * threshold doesn't work." The quality gate lives in Stage 3 (NLI), not here.
 * Stage 1's job is to recall as many topically related candidates as possible
 * without flooding Stage 3.
 */
import { getConfig } from '../config/index.ts';
import { getDb } from '../store/db.ts';
import type { DbLike } from '../store/runtime-sqlite.ts';
import { logger } from '../util/logger.ts';
import { embedOne, blobToVector, cosine } from '../embedding/client.ts';

export interface RetrieveCandidate {
  id: number;
  sourceUrl: string;
  publisher: string;
  publisherUrl: string | null;
  claimReviewed: string;
  ratingNative: string | null;
  reviewDate: string | null;
  lang: string | null;
  attribution: string;
  /** cosine in [-1, 1] — typically [0, 1] for unit-normalised embeddings. */
  cosine: number;
}

export interface RetrieveOptions {
  topK?: number;
  /** Drop candidates below this cosine. Defaults to 0.55 — see file header. */
  minCosine?: number;
}

export interface RetrieveResult {
  candidates: RetrieveCandidate[];
  /** total number of indexed rows scanned (post-model-filter). */
  scanned: number;
}

const SELECT_INDEXED = `
  SELECT id, source_url, publisher, publisher_url, claim_reviewed,
         rating_native, review_date, lang, attribution,
         embedding, embedding_dim
  FROM claim_review
  WHERE embedding IS NOT NULL
    AND embedding_model = ?
`;

export async function retrieveCandidates(
  claim: string,
  options: RetrieveOptions = {},
  db?: DbLike,
): Promise<RetrieveResult> {
  const cfg = getConfig();
  const target = db ?? getDb();
  const topK = options.topK ?? 10;
  const minCosine = options.minCosine ?? 0.55;

  if (!claim.trim()) {
    return { candidates: [], scanned: 0 };
  }

  // Embed the query
  const { vector: qvec, dim: qdim } = await embedOne(claim);

  // Scan all rows for the current model
  const rows = target.prepare(SELECT_INDEXED).all(cfg.EMBEDDING_MODEL) as Array<{
    id: number;
    source_url: string;
    publisher: string;
    publisher_url: string | null;
    claim_reviewed: string;
    rating_native: string | null;
    review_date: string | null;
    lang: string | null;
    attribution: string;
    embedding: Buffer | Uint8Array;
    embedding_dim: number;
  }>;

  if (!rows.length) {
    logger.warn(
      { model: cfg.EMBEDDING_MODEL },
      'retrieve: no rows have embeddings for the current model — run pnpm cli:embed-rebuild',
    );
    return { candidates: [], scanned: 0 };
  }

  const scored: RetrieveCandidate[] = [];
  for (const r of rows) {
    if (r.embedding_dim !== qdim) continue; // model/dim mismatch
    const v = blobToVector(r.embedding);
    const c = cosine(qvec, v);
    if (c < minCosine) continue;
    scored.push({
      id: r.id,
      sourceUrl: r.source_url,
      publisher: r.publisher,
      publisherUrl: r.publisher_url,
      claimReviewed: r.claim_reviewed,
      ratingNative: r.rating_native,
      reviewDate: r.review_date,
      lang: r.lang,
      attribution: r.attribution,
      cosine: c,
    });
  }

  scored.sort((a, b) => b.cosine - a.cosine);
  return { candidates: scored.slice(0, topK), scanned: rows.length };
}
