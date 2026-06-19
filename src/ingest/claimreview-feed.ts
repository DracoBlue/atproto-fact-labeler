/**
 * Stream-parse the Google Data Commons Fact Check JSON DataFeed and insert each
 * ClaimReview entry into SQLite (table `claim_review`).
 *
 * Licensing: the feed *compilation* is CC BY 4.0 (Google Data Commons), but the
 * *individual entries' text* (claim, verdict, rationale) remain under each
 * publisher's own copyright. We deliberately store only URL + metadata +
 * normalised rating, plus a verbatim attribution string. We never copy the
 * publisher's verdict prose verbatim into our records.
 */
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';

import chain from 'stream-chain';
import { parser as jsonParser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';

import { getConfig } from '../config/index.ts';
import { getDb } from '../store/db.ts';
import type { DbLike } from '../store/runtime-sqlite.ts';
import { logger } from '../util/logger.ts';
import { detectLang } from './detect-lang.ts';
import { PublisherAllowlist } from './publisher-allowlist.ts';

/** schema.org ClaimReview as it appears in the Data Commons feed. */
interface ClaimReview {
  '@type': 'ClaimReview';
  url?: string;
  claimReviewed?: string;
  datePublished?: string;
  inLanguage?: string;
  author?: { '@type': string; name?: string; url?: string };
  reviewRating?: {
    '@type'?: string;
    alternateName?: string;
    name?: string;
    ratingValue?: string | number;
    bestRating?: string | number;
    worstRating?: string | number;
    url?: string;
  };
  itemReviewed?: { '@type'?: string; author?: { '@type'?: string; name?: string } };
  sdLicense?: string;
  sdPublisher?: { '@type'?: string; name?: string; url?: string };
}

interface DataFeedItem {
  '@type': 'DataFeedItem';
  dateCreated?: string;
  item?: ClaimReview[];
  url?: string;
}

/**
 * Best-effort language for an entry.
 *
 * Order:
 *   1. The publisher's explicit `inLanguage` tag (BCP-47 → first 2 chars).
 *   2. On-device text detection (`eld`) over the claim text itself —
 *      handles the long tail of publishers that don't set inLanguage.
 *   3. NULL if the text is too short / detector isn't confident.
 *
 * The URL/TLD heuristic this replaced was buggy on multiple fronts —
 * see `docs/LANGUAGE_DETECTION.md` for the history.
 */
function guessLanguage(entry: ClaimReview): string | undefined {
  if (entry.inLanguage) return entry.inLanguage.toLowerCase().slice(0, 2);
  const detected = detectLang(entry.claimReviewed);
  return detected ?? undefined;
}

/** Verbatim attribution string we persist with every entry (CC BY 4.0 requirement). */
export function buildAttribution(entry: ClaimReview): string {
  const publisher = entry.author?.name?.trim() || entry.author?.url || 'unknown publisher';
  return `Fact-checked by ${publisher}. Compiled via Google Data Commons Fact Check feed (CC BY 4.0).`;
}

const INSERT_SQL = `
  INSERT OR REPLACE INTO claim_review (
    source_url, publisher, publisher_url, claim_reviewed, claim_author,
    rating_native, rating_url, review_date, lang, sd_license, attribution
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

interface IngestStats {
  read: number;
  inserted: number;
  skipped: number;
  skippedByAllowlist: number;
}

type RowTuple = readonly [
  string,         // source_url
  string,         // publisher
  string | null,  // publisher_url
  string,         // claim_reviewed
  string | null,  // claim_author
  string | null,  // rating_native
  string | null,  // rating_url
  string | null,  // review_date
  string | null,  // lang
  string | null,  // sd_license
  string,         // attribution
];

function buildRow(entry: ClaimReview): RowTuple | null {
  const sourceUrl = entry.url?.trim();
  const claimReviewed = entry.claimReviewed?.trim();
  if (!sourceUrl || !claimReviewed) return null;

  const ratingNative = (entry.reviewRating?.alternateName ?? entry.reviewRating?.name ?? '').trim();

  return [
    sourceUrl,
    entry.author?.name?.trim() ?? 'unknown',
    entry.author?.url ?? null,
    claimReviewed,
    entry.itemReviewed?.author?.name ?? null,
    ratingNative || null,
    entry.reviewRating?.url ?? null,
    entry.datePublished ?? null,
    guessLanguage(entry) ?? null,
    entry.sdLicense ?? null,
    buildAttribution(entry),
  ];
}

/** Returns ingest stats. */
export async function ingestClaimReviewFeed(feedPath: string, db?: DbLike): Promise<IngestStats> {
  const target = db ?? getDb();
  const stats: IngestStats = { read: 0, inserted: 0, skipped: 0, skippedByAllowlist: 0 };
  const insert = target.prepare(INSERT_SQL);

  const cfg = getConfig();
  const allowlist = PublisherAllowlist.fromFileOrEmpty(resolve(cfg.CLAIMREVIEW_PUBLISHER_ALLOWLIST));
  if (allowlist.size === 0) {
    logger.warn(
      { allowlistPath: cfg.CLAIMREVIEW_PUBLISHER_ALLOWLIST },
      'publisher allowlist missing or empty — ingesting every entry (NOT recommended)',
    );
  }

  // Path resolution: relative to cwd.
  const fullPath = resolve(feedPath);
  logger.info(
    { feedPath: fullPath, allowlistSize: allowlist.size },
    'starting ClaimReview feed ingest',
  );

  // Transactional batches for speed.
  const BATCH = 500;
  let batch: RowTuple[] = [];

  const flush = target.transaction((rows: unknown) => {
    for (const row of rows as RowTuple[]) {
      insert.run(...row);
      stats.inserted++;
    }
  });

  const pipeline = chain([
    createReadStream(fullPath),
    jsonParser(),
    pick({ filter: 'dataFeedElement' }),
    streamArray(),
  ]) as unknown as NodeJS.ReadableStream;

  return new Promise<IngestStats>((resolveFn, reject) => {
    pipeline.on('data', ({ value }: { value: DataFeedItem }) => {
      stats.read++;
      const items = value?.item ?? [];
      for (const entry of items) {
        const row = buildRow(entry);
        if (!row) {
          stats.skipped++;
          continue;
        }
        if (allowlist.size > 0 && !allowlist.isAllowedUrl(entry.author?.url)) {
          stats.skippedByAllowlist++;
          continue;
        }
        batch.push(row);
        if (batch.length >= BATCH) {
          const toFlush = batch;
          batch = [];
          flush(toFlush);
          if (stats.inserted % 5_000 === 0) {
            logger.info({ inserted: stats.inserted, read: stats.read }, 'ingest progress');
          }
        }
      }
    });

    pipeline.on('end', () => {
      if (batch.length) flush(batch);
      logger.info(stats, 'ingest done');
      resolveFn(stats);
    });

    pipeline.on('error', (err: Error) => {
      logger.error({ err }, 'ingest failed');
      reject(err);
    });
  });
}
