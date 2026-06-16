import { config as loadEnv } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

loadEnv();

const Schema = z.object({
  // LLM
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY must be set (LM Studio API key from .env)'),
  OPENAI_BASE_URL: z.string().url().default('http://127.0.0.1:1234/v1'),
  OPENAI_MODEL: z.string().default('google/gemma-4-e2b'),

  // Labeler identity
  LABELER_DID: z.string().default('did:plc:placeholder-replace-after-setup'),
  LABELER_SIGNING_KEY: z.string().default(''),
  LABELER_PORT: z.coerce.number().int().positive().default(14831),
  LABELER_HOSTNAME: z.string().default('http://localhost:14831'),

  // Ingest
  JETSTREAM_URL: z
    .string()
    .default('wss://jetstream2.us-east.bsky.network/subscribe'),
  JETSTREAM_FIXTURE: z.string().optional(),

  // HITL
  HITL_MODE: z.enum(['stdin', 'telegram', 'auto']).default('stdin'),
  TG_BOT_TOKEN: z.string().optional(),
  TG_REVIEWER_CHAT_ID: z.string().optional(),

  // Storage
  SQLITE_PATH: z.string().default('data/labeler.sqlite'),

  // ClaimReview source
  CLAIMREVIEW_FEED_PATH: z.string().default('data.json'),

  // Detail page
  DETAIL_PORT: z.coerce.number().int().positive().default(14832),

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
