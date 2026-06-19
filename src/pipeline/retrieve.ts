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
  /**
   * Accepted BCP-47 lang(s) of the claim. When set, retrieval restricts to
   * ClaimReview rows in one of these languages, plus rows without a
   * language tag. Pass multiple when the post's declared lang and the
   * detected lang disagree (users mis-tag) — both are tried.
   * Empty array / undefined = no filter.
   */
  lang?: string | string[];
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

function selectIndexedLang(numLangs: number): string {
  const placeholders = Array(numLangs).fill('?').join(', ');
  return `
    SELECT id, source_url, publisher, publisher_url, claim_reviewed,
           rating_native, review_date, lang, attribution,
           embedding, embedding_dim
      FROM claim_review
     WHERE embedding IS NOT NULL
       AND embedding_model = ?
       AND (lang IN (${placeholders}) OR lang IS NULL)
  `;
}

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

  // Scan all rows for the current model, optionally restricted to one or
  // more accepted languages plus the universal lang IS NULL bucket.
  const langs = normaliseLangs(options.lang);
  const rows = (langs.length > 0
    ? target.prepare(selectIndexedLang(langs.length)).all(cfg.EMBEDDING_MODEL, ...langs)
    : target.prepare(SELECT_INDEXED).all(cfg.EMBEDDING_MODEL)) as Array<{
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

  logger.debug({ langs, scanned: rows.length }, 'retrieve: scan');

  if (!rows.length) {
    logger.warn(
      { model: cfg.EMBEDDING_MODEL, langs },
      'retrieve: no rows match — run pnpm cli:embed-rebuild, or the lang filter is too strict',
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

/** Normalise the lang option: lowercase, 2-letter, dedup, drop empties. */
function normaliseLangs(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = new Set<string>();
  for (const v of arr) {
    if (!v) continue;
    const norm = v.toLowerCase().slice(0, 2);
    if (norm.length === 2) out.add(norm);
  }
  return [...out];
}
