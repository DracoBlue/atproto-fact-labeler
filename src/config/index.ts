import { config as loadEnv } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

loadEnv();

const Schema = z.object({
  // LLM
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY must be set (API key for the OpenAI-compatible endpoint)'),
  OPENAI_BASE_URL: z.string().url().default('https://ai-gateway.vercel.sh/v1'),
  OPENAI_MODEL: z.string().default('google/gemini-2.5-flash'),
  /**
   * max_tokens sent on each chat-completions request. Reasoning models
   * (qwen3 family, deepseek-r1, etc.) burn tokens on internal "thinking" before
   * producing the actual answer — give them generous head-room or you'll get
   * empty content with finish_reason=length. Set to 0 to let the server choose.
   */
  OPENAI_MAX_TOKENS: z.coerce.number().int().nonnegative().default(4096),

  // --- Embedding (Stage 1: dense retrieval) -----------------------------
  // OpenAI-compatible `/v1/embeddings` endpoint. Optional base_url/key fall
  // back to OPENAI_* so a single LM Studio instance can serve both. Set
  // explicitly when embeddings live on a different server.
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  /**
   * Embedding model name. Default = granite-278m-multilingual: ships with
   * LM Studio, 768 dims, genuine multilingual (EN↔DE crosslingual cosine 0.81
   * measured on our test set). See docs/PIPELINE.md.
   */
  EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-small'),

  // --- Reranker (Stage 2: relevance gate before NLI) --------------------
  // `llm`: single batched LLM call rates each top-K retrieved candidate
  //        for topical relevance to the user's claim. Keeps top RERANK_KEEP
  //        above RERANK_THRESHOLD, drops the rest before Stage 3 NLI runs.
  // `off`: skip Stage 2; Stage 3 NLI runs on every Stage 1 candidate.
  RERANK_MODE: z.enum(['llm', 'off']).default('llm'),
  RERANK_KEEP: z.coerce.number().int().positive().default(5),
  RERANK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),

  // --- NLI (Stage 3: polarity gate) -------------------------------------
  // `llm-judge` reuses the LLM (OPENAI_*) with a 3-class entailment prompt.
  // `dedicated` is reserved but throws — see docs/ADR_nli_llm_judge_over_mdeberta.md.
  NLI_MODE: z.enum(['llm-judge', 'dedicated']).default('llm-judge'),

  // Labeler identity
  LABELER_DID: z.string().default('did:plc:placeholder-replace-after-setup'),
  // Optional handle for mention-text fallback when post.facets is empty.
  // Must be a bare handle without the leading "@" and look roughly
  // like a domain (contain a dot, no whitespace, ASCII only).
  LABELER_HANDLE: z
    .string()
    .optional()
    .superRefine((val, ctx) => {
      if (!val) return;
      if (val.startsWith('@')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `LABELER_HANDLE must not include the leading "@" (got "${val}" — use "${val.slice(1)}")`,
        });
        return;
      }
      if (!/^[a-z0-9._-]+\.[a-z0-9.-]+$/i.test(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `LABELER_HANDLE must be a domain-style handle like "facts.example.org" (got "${val}")`,
        });
      }
    }),
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
  // Authed AppView used as a fallback when the public one is rate-limited or
  // transiently unavailable. Only used when REPLY_TO_MENTIONS=true (the only
  // path that gives us a Bluesky session). The fallback reuses the labeler's
  // access JWT to pass authorisation.
  APPVIEW_AUTHED_URL: z.string().default('https://api.bsky.app'),
  // Require a valid atproto service JWT on POST /xrpc/com.atproto.moderation.createReport.
  // ON by default — a real Bluesky client always signs the call via its PDS.
  // Turn off only for local development / curl-based testing.
  REQUIRE_REPORT_AUTH: z
    .preprocess((v) => v === undefined || v === '1' || v === 'true' || v === true, z.boolean())
    .default(true),
  // PLC directory used to resolve report-issuer DIDs to signing keys.
  PLC_DIRECTORY_URL: z.string().default('https://plc.directory'),

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
  /**
   * Default BCP-47 language tag used when the mention post has no `langs` set
   * or its language isn't in the supported list. Currently supported: en, de.
   */
  LABELER_REPLY_DEFAULT_LANG: z.enum(['en', 'de']).default('en'),

  // HITL
  HITL_MODE: z.enum(['stdin', 'telegram', 'auto', 'auto-telegram']).default('stdin'),
  TG_BOT_TOKEN: z.string().optional(),
  TG_REVIEWER_CHAT_ID: z.string().optional(),
  // Auto-HITL policy. After cleanup:claims pruned the spam publishers the
  // realistic confidence band on legitimate matches sits around 0.6–0.8;
  // the previous default of 0.8 produced a lot of false negatives. Tune
  // per-deployment via env.
  HITL_AUTO_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  HITL_AUTO_MIN_VOTES: z.coerce.number().int().min(1).default(2),

  // Storage
  SQLITE_PATH: z.string().default('data/labeler.sqlite'),

  // ClaimReview source
  CLAIMREVIEW_FEED_PATH: z.string().default('data.json'),
  CLAIMREVIEW_PUBLISHER_ALLOWLIST: z
    .string()
    .default('config/claimreview-publishers-allowlist.txt'),

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
