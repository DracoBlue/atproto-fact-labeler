/**
 * Google Fact Check Tools API client — claims:search endpoint.
 *
 * Auth: API key only. Bearer tokens (user OAuth, service-account JWT) are
 * actively rejected by the endpoint — see docs/FACTCHECK_API.md for the
 * test that confirmed this.
 *
 * Returns a normalised shape that matches what the ingest pipeline writes
 * into `claim_review`, so live hits can be persisted via the same path as
 * bulk-feed entries.
 */
import { logger } from '../util/logger.ts';

const ENDPOINT = 'https://factchecktools.googleapis.com/v1alpha1/claims:search';

export interface FactCheckSearchHit {
  /** Source URL of the publisher's fact-check article. Stable identifier. */
  sourceUrl: string;
  /** Publisher display name, e.g. "USA Today". */
  publisher: string;
  /**
   * Publisher's site host as Google reports it (`usatoday.com`). Used to
   * filter through the existing publisher allowlist.
   */
  publisherSite: string;
  /** The text claim the publisher reviewed. */
  claimReviewed: string;
  /** Free-text rating ("False", "Mostly False", "Sin pruebas", …). */
  ratingNative: string;
  /** ISO date string of the review. Null if absent. */
  reviewDate: string | null;
  /** BCP-47 language code of the review. */
  lang: string | null;
  /** Title of the fact-check article. */
  title: string | null;
}

export interface FactCheckSearchOptions {
  /** ISO 639-1 lang, e.g. 'en', 'de'. Passed to languageCode. */
  lang?: string;
  /** Max results per call. Defaults to the configured FACTCHECK_API_PAGE_SIZE. */
  pageSize?: number;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
  /** Inject `fetch` for tests. */
  fetchImpl?: typeof fetch;
}

interface RawClaim {
  text?: string;
  claimant?: string;
  claimDate?: string;
  claimReview?: Array<{
    publisher?: { name?: string; site?: string };
    url?: string;
    title?: string;
    reviewDate?: string;
    textualRating?: string;
    languageCode?: string;
  }>;
}

interface RawResponse {
  claims?: RawClaim[];
  nextPageToken?: string;
}

/**
 * Issue a single `claims:search` call. Returns normalised hits. Never throws
 * for empty result / quota errors — those resolve to `[]` so the matching
 * pipeline keeps working from the local pool. Network errors / 5xx do throw.
 */
export async function searchFactCheckApi(
  apiKey: string,
  query: string,
  opts: FactCheckSearchOptions = {},
): Promise<FactCheckSearchHit[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = new URL(ENDPOINT);
  url.searchParams.set('query', query);
  url.searchParams.set('pageSize', String(opts.pageSize ?? 10));
  url.searchParams.set('key', apiKey);
  if (opts.lang) url.searchParams.set('languageCode', opts.lang);

  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;

  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    logger.warn({ err: (err as Error).message, query, lang: opts.lang }, 'factcheck-api: fetch failed');
    return [];
  }

  if (!res.ok) {
    // 400 (bad query), 429 (quota), 403 (key invalid) — log and return empty.
    // The pipeline falls back to the local pool; degrading is safer than throwing.
    const body = await res.text().catch(() => '');
    logger.warn(
      { status: res.status, query, lang: opts.lang, body: body.slice(0, 200) },
      'factcheck-api: non-2xx response',
    );
    return [];
  }

  let json: RawResponse;
  try {
    json = (await res.json()) as RawResponse;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'factcheck-api: invalid JSON');
    return [];
  }

  const hits: FactCheckSearchHit[] = [];
  for (const claim of json.claims ?? []) {
    const text = claim.text?.trim() ?? '';
    if (!text) continue;
    for (const review of claim.claimReview ?? []) {
      if (!review.url || !review.publisher?.site) continue;
      hits.push({
        sourceUrl: review.url,
        publisher: review.publisher.name?.trim() || review.publisher.site,
        publisherSite: review.publisher.site,
        claimReviewed: text,
        ratingNative: review.textualRating?.trim() || '',
        reviewDate: review.reviewDate ?? null,
        lang: review.languageCode?.toLowerCase().slice(0, 2) || null,
        title: review.title?.trim() || null,
      });
    }
  }
  return hits;
}
