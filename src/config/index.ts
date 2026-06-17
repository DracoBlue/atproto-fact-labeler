import { config as loadEnv } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

loadEnv();

const Schema = z.object({
  // LLM
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY must be set (API key for the OpenAI-compatible endpoint)'),
  OPENAI_BASE_URL: z.string().url().default('http://127.0.0.1:1234/v1'),
  OPENAI_MODEL: z.string().default('google/gemma-4-e2b'),

  // Labeler identity
  LABELER_DID: z.string().default('did:plc:placeholder-replace-after-setup'),
  // Optional handle for mention-text fallback when post.facets is empty.
  LABELER_HANDLE: z.string().optional(),
  LABELER_SIGNING_KEY: z.string().default(''),
  LABELER_PORT: z.coerce.number().int().positive().default(14831),
  LABELER_HOSTNAME: z.string().default('http://localhost:14831'),

  // Ingest
  JETSTREAM_URL: z
    .string()
    .default('wss://jetstream2.us-east.bsky.network/subscribe'),
  JETSTREAM_FIXTURE: z.string().optional(),

  // Triggers — control which posts hit the LLM. Default: mentions + reports.
  // Firehose mode (every post) is opt-in because it will overwhelm a single
  // local LLM. Mentions + reports are user-initiated and low-volume.
  TRIGGER_FIREHOSE: z
    .preprocess((v) => v === '1' || v === 'true' || v === true, z.boolean())
    .default(false),
  TRIGGER_MENTIONS: z
    .preprocess((v) => v === undefined || v === '1' || v === 'true' || v === true, z.boolean())
    .default(true),
  TRIGGER_REPORTS: z
    .preprocess((v) => v === undefined || v === '1' || v === 'true' || v === true, z.boolean())
    .default(true),
  /** Comma-separated DIDs whose top-level posts are always checked. */
  TRIGGER_WATCHLIST: z
    .preprocess(
      (v) => (typeof v === 'string' && v.length ? v.split(',').map((s) => s.trim()).filter(Boolean) : []),
      z.array(z.string()),
    )
    .default([]),

  // Public Bluesky AppView used to fetch post text by URI. Unauthenticated
  // reads — `public.api.bsky.app` is the dedicated read-only endpoint and the
  // right choice for our use case (no session, no rate-limit-tier promotion).
  APPVIEW_URL: z.string().default('https://public.api.bsky.app'),

  // --- Reply to @mention author ----------------------------------------
  // When true, the labeler posts a Bluesky reply to the mention post after a
  // mention-triggered label is accepted. Requires authenticated credentials
  // for the labeler service account (an app password from bsky.app).
  REPLY_TO_MENTIONS: z
    .preprocess((v) => v === '1' || v === 'true' || v === true, z.boolean())
    .default(false),
  /** PDS URL the labeler account lives on (bsky.social or self-hosted). */
  LABELER_BSKY_SERVICE: z.string().default('https://bsky.social'),
  /** Handle or DID of the labeler service account (writes posts as this account). */
  LABELER_BSKY_IDENTIFIER: z.string().optional(),
  /** App password from bsky.app (NOT the main account password). */
  LABELER_BSKY_APP_PASSWORD: z.string().optional(),
  /** Public detail-page base URL — embedded in mention replies as a deep-link. */
  LABELER_DETAIL_BASE_URL: z.string().optional(),

  // HITL
  HITL_MODE: z.enum(['stdin', 'telegram', 'auto']).default('stdin'),
  TG_BOT_TOKEN: z.string().optional(),
  TG_REVIEWER_CHAT_ID: z.string().optional(),

  // Storage
  SQLITE_PATH: z.string().default('data/labeler.sqlite'),

  // ClaimReview source
  CLAIMREVIEW_FEED_PATH: z.string().default('data.json'),

  // Log level
  LOG_LEVEL: z.string().default('info'),
});

export type AppConfig = z.infer<typeof Schema>;

let _config: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (_config) return _config;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  _config = parsed.data;

  // Cross-field invariant: REPLY_TO_MENTIONS requires Bluesky credentials.
  if (_config.REPLY_TO_MENTIONS) {
    const missing: string[] = [];
    if (!_config.LABELER_BSKY_IDENTIFIER) missing.push('LABELER_BSKY_IDENTIFIER');
    if (!_config.LABELER_BSKY_APP_PASSWORD) missing.push('LABELER_BSKY_APP_PASSWORD');
    if (missing.length) {
      throw new Error(
        `REPLY_TO_MENTIONS=true requires ${missing.join(' and ')} to be set.`,
      );
    }
  }

  // Ensure the SQLite directory exists.
  const dbPath = resolve(_config.SQLITE_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });

  return _config;
}
