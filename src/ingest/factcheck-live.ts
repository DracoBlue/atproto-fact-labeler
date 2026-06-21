/**
 * Glue between `factcheck-api.ts` and the local `claim_review` cache.
 *
 * The matching pipeline calls `populateLiveCandidates(claim, langs)` before
 * Stage 2 retrieval. We fetch from the Google Fact Check Tools API, filter
 * through the publisher allowlist, persist new hits, embed them inline so
 * Stage 2's cosine search picks them up in the same `matchClaim` call.
 *
 * Subsequent invocations against the same claim see the rows as ordinary
 * cached entries — no further API calls, no embed cost.
 */
import { resolve } from 'node:path';

import { getConfig } from '../config/index.ts';
import { embedOne, vectorToBlob } from '../embedding/client.ts';
import { logger } from '../util/logger.ts';
import type { DbLike } from '../store/runtime-sqlite.ts';
import { detectLang } from './detect-lang.ts';
import { searchFactCheckApi, type FactCheckSearchHit } from './factcheck-api.ts';
import { PublisherAllowlist } from './publisher-allowlist.ts';

let _allowlist: PublisherAllowlist | undefined;
function allowlist(): PublisherAllowlist {
  if (_allowlist) return _allowlist;
  const cfg = getConfig();
  _allowlist = PublisherAllowlist.fromFileOrEmpty(resolve(cfg.CLAIMREVIEW_PUBLISHER_ALLOWLIST));
  return _allowlist;
}

const INSERT_SQL = `
  INSERT OR IGNORE INTO claim_review (
    source_url, publisher, publisher_url, claim_reviewed, claim_author,
    rating_native, rating_url, review_date, lang, sd_license, attribution
  ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?)
`;

function buildAttribution(hit: FactCheckSearchHit): string {
  return `Fact-checked by ${hit.publisher}. Sourced via Google Fact Check Tools API.`;
}

function publisherUrl(hit: FactCheckSearchHit): string {
  return `https://${hit.publisherSite.replace(/^https?:\/\//, '')}/`;
}

export interface LivePopulateResult {
  apiCalls: number;
  hitsTotal: number;
  hitsAllowlisted: number;
  inserted: number;
  embedded: number;
}

/**
 * Call the API for each unique lang, filter, persist, and embed-inline any
 * row that hasn't been seen before. Idempotent and safe to call per-claim.
 */
export async function populateLiveCandidates(
  claim: string,
  langs: readonly string[],
  db: DbLike,
): Promise<LivePopulateResult> {
  const cfg = getConfig();
  const result: LivePopulateResult = {
    apiCalls: 0,
    hitsTotal: 0,
    hitsAllowlisted: 0,
    inserted: 0,
    embedded: 0,
  };

  if (!cfg.FACTCHECK_API_KEY) return result;
  const trimmed = claim.trim();
  if (!trimmed) return result;

  const langSet = new Set(langs.length > 0 ? langs : [undefined as unknown as string]);
  const calls = await Promise.all(
    [...langSet].map(async (lang) => {
      result.apiCalls++;
      return searchFactCheckApi(cfg.FACTCHECK_API_KEY!, trimmed, {
        lang: lang || undefined,
        pageSize: cfg.FACTCHECK_API_PAGE_SIZE,
        timeoutMs: cfg.FACTCHECK_API_TIMEOUT_MS,
      });
    }),
  );

  // Flatten + dedupe by source_url
  const seen = new Set<string>();
  const merged: FactCheckSearchHit[] = [];
  for (const hits of calls) {
    for (const h of hits) {
      result.hitsTotal++;
      if (seen.has(h.sourceUrl)) continue;
      seen.add(h.sourceUrl);
      merged.push(h);
    }
  }

  const al = allowlist();
  const passed: FactCheckSearchHit[] = [];
  for (const h of merged) {
    if (al.size > 0 && !al.isAllowedHost(h.publisherSite)) continue;
    result.hitsAllowlisted++;
    passed.push(h);
  }
  if (passed.length === 0) return result;

  // Insert; sqlite tells us which rows were new so we only embed those.
  const insert = db.prepare(INSERT_SQL);
  const newIds: Array<{ id: number; text: string }> = [];
  const tx = db.transaction((rows: FactCheckSearchHit[]) => {
    for (const h of rows) {
      const lang = h.lang ?? detectLang(h.claimReviewed);
      const info = insert.run(
        h.sourceUrl,
        h.publisher,
        publisherUrl(h),
        h.claimReviewed,
        h.ratingNative || null,
        h.reviewDate,
        lang,
        buildAttribution(h),
      );
      if (info.changes && info.changes > 0) {
        const lastIdRow = db.prepare('SELECT id FROM claim_review WHERE source_url = ?').get(h.sourceUrl) as
          | { id: number }
          | undefined;
        if (lastIdRow) newIds.push({ id: lastIdRow.id, text: h.claimReviewed });
      }
    }
  });
  tx(passed);
  result.inserted = newIds.length;

  if (newIds.length === 0) return result;

  // Embed the new rows. Sequential is fine — small batch (<=10), cached
  // afterwards. Update the embedding columns in-place.
  const updateEmbed = db.prepare(
    `UPDATE claim_review SET embedding = ?, embedding_dim = ?, embedding_model = ? WHERE id = ?`,
  );
  for (const row of newIds) {
    try {
      const { vector, dim } = await embedOne(row.text.slice(0, 1500));
      updateEmbed.run(vectorToBlob(vector), dim, cfg.EMBEDDING_MODEL, row.id);
      result.embedded++;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, id: row.id },
        'factcheck-live: inline embed failed; row stays without embedding',
      );
    }
  }

  logger.debug(result, 'factcheck-live: populate done');
  return result;
}

/** Exposed for tests that need a fresh allowlist cache. */
export function _resetAllowlistCacheForTests(): void {
  _allowlist = undefined;
}
