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

  // AppView used by report ingest to fetch post text by URI.
  APPVIEW_URL: z.string().default('https://api.bsky.app'),

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

  // Ensure the SQLite directory exists.
  const dbPath = resolve(_config.SQLITE_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });

  return _config;
}
