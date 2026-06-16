/**
 * Stage S2 — look up an extracted claim against the local ClaimReview index.
 *
 * Strategy:
 *  - Strip stopwords + low-signal tokens from the claim.
 *  - Build an FTS5 MATCH query that ORs the remaining tokens.
 *  - Rank by BM25 (default FTS5 score), boost rows whose language matches the
 *    extracted claim's language and whose review_date is recent.
 *  - Return the top-N candidates.
 *
 * Cross-publisher verdict aggregation happens later (see normalise-rating.ts).
 */
import { getDb } from '../store/db.ts';
import type { DbLike } from '../store/runtime-sqlite.ts';

export interface LookupCandidate {
  id: number;
  sourceUrl: string;
  publisher: string;
  publisherUrl: string | null;
  claimReviewed: string;
  ratingNative: string | null;
  reviewDate: string | null;
  lang: string | null;
  attribution: string;
  bm25Score: number;
  /** Lower = better when bm25 is negative; here we expose a normalised 0..1 quality. */
  quality: number;
}

const STOPWORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'do', 'does', 'did', 'have', 'has', 'had', 'i', 'you', 'he', 'she',
  'it', 'we', 'they', 'this', 'that', 'these', 'those', 'of', 'in', 'on', 'at',
  'to', 'for', 'with', 'as', 'by', 'from', 'about',
  // German
  'der', 'die', 'das', 'den', 'dem', 'ein', 'eine', 'einen', 'einem', 'einer',
  'und', 'oder', 'ist', 'sind', 'war', 'waren', 'sein', 'haben', 'hat', 'hatte',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'dies', 'diese', 'dieser',
  'in', 'an', 'auf', 'mit', 'von', 'zu', 'für', 'als',
  // French
  'le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'est', 'sont', 'être',
  'avoir', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'ce',
  'cette', 'de', 'à', 'au', 'pour', 'avec', 'sans',
  // Spanish
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'es', 'son',
  'era', 'eran', 'ser', 'tener', 'yo', 'tú', 'él', 'ella', 'nosotros', 'ellos',
  'este', 'esta', 'de', 'a', 'en', 'por', 'para', 'con', 'sin',
]);

/** Tokenise a free-text claim into FTS5-safe terms. */
export function buildFtsQuery(claim: string): string {
  const tokens = claim
    .replace(/ß/g, 'ss')
    .replace(/Æ/g, 'AE')
    .replace(/æ/g, 'ae')
    .replace(/Œ/g, 'OE')
    .replace(/œ/g, 'oe')
    .replace(/Ø/g, 'O')
    .replace(/ø/g, 'o')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 \-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]+$/g, '').replace(/^[^a-z0-9]+/g, ''))
    .filter((t) => t.length >= 3)
    .filter((t) => !STOPWORDS.has(t));
  if (!tokens.length) return '';
  // Dedup, cap to 10 tokens, OR-join. Use prefix matching so 'vaccin' matches 'vaccines'.
  const unique = [...new Set(tokens)].slice(0, 10);
  return unique.map((t) => `${t}*`).join(' OR ');
}

const QUERY_SQL = `
  SELECT
    cr.id            AS id,
    cr.source_url    AS source_url,
    cr.publisher     AS publisher,
    cr.publisher_url AS publisher_url,
    cr.claim_reviewed AS claim_reviewed,
    cr.rating_native AS rating_native,
    cr.review_date   AS review_date,
    cr.lang          AS lang,
    cr.attribution   AS attribution,
    bm25(claim_review_fts) AS bm25
  FROM claim_review_fts
  JOIN claim_review cr ON cr.id = claim_review_fts.rowid
  WHERE claim_review_fts MATCH ?
  ORDER BY bm25
  LIMIT ?
`;

export interface LookupOptions {
  topK?: number;
  /** Two-letter language hint; matching candidates get a quality bonus. */
  lang?: string;
}

export interface LookupResult {
  query: string;
  candidates: LookupCandidate[];
}

export function lookupCandidates(
  claim: string,
  options: LookupOptions = {},
  db?: DbLike,
): LookupResult {
  const target = db ?? getDb();
  const topK = options.topK ?? 5;
  const query = buildFtsQuery(claim);
  if (!query) return { query, candidates: [] };

  let rows: Array<Record<string, unknown>>;
  try {
    rows = target.prepare(QUERY_SQL).all(query, topK * 3) as Array<Record<string, unknown>>;
  } catch {
    // FTS5 can throw on weird queries (e.g. single quote unbalanced). Fall back to no results.
    return { query, candidates: [] };
  }

  const wantLang = options.lang?.toLowerCase();

  const candidates = rows.map((r): LookupCandidate => {
    const bm25 = Number(r.bm25 ?? 0);
    // FTS5 bm25 returns negative values; lower = better. Convert to 0..1.
    const bm25Quality = 1 / (1 + Math.abs(bm25));
    const langBonus = wantLang && String(r.lang ?? '').toLowerCase() === wantLang ? 0.15 : 0;
    return {
      id: Number(r.id),
      sourceUrl: String(r.source_url),
      publisher: String(r.publisher),
      publisherUrl: r.publisher_url as string | null,
      claimReviewed: String(r.claim_reviewed),
      ratingNative: r.rating_native as string | null,
      reviewDate: r.review_date as string | null,
      lang: r.lang as string | null,
      attribution: String(r.attribution),
      bm25Score: bm25,
      quality: Math.min(1, bm25Quality + langBonus),
    };
  });

  // Re-sort by adjusted quality and trim to topK.
  candidates.sort((a, b) => b.quality - a.quality);
  return { query, candidates: candidates.slice(0, topK) };
}
