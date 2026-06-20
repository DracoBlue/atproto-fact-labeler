# Production Deploy

Going-live walkthrough for a real Bluesky labeler on your own domain,
behind a reverse-proxy host like **Coolify**, **Caddy**, **Traefik**,
**Nginx Proxy Manager**, **Cloudflare Tunnel**, or any other thing that
gives you HTTPS termination + container hosting.

This document is the **infrastructure** side. Once you're up, work
through [`LIFECYCLE.md`](./LIFECYCLE.md) for the Bluesky-side setup
(skyware registration, label declarations, retire, clear). The two
files are independent — DNS + container + env can be ready before you
register the labeler with Bluesky, and the labeler registration can be
done from any operator workstation, not necessarily the server.

For the **model choices** (LLM, embedding) and the rationale per
deployment shape, see [`ADR_model_choices.md`](./ADR_model_choices.md).
Summary: hybrid (Vercel LLM + local granite) is the recommended shape
for best retrieval quality, pure-Vercel works too at a ~7% crosslingual
quality cost.

## 1. Pick the labeler handle

The labeler runs as its own Bluesky service account. Two common
shapes:

- **`facts.example.org`** — a custom-domain handle. You control DNS for
  `example.org`, and you point a Bluesky handle at it. Polished, looks
  like a real service. **Pick this for production.**
- **`facts.bsky.social`** — a default-handle, no DNS required. Faster
  to set up. Fine for staging. The whole rest of the doc still works,
  you just skip the DNS step.

The remainder of this doc uses **`facts.example.org`** as the handle
and `example.org` as the apex domain you control. Substitute your own.

## 2. DNS setup for the custom handle

Bluesky resolves custom handles two ways. Pick whichever your DNS host
or reverse proxy is easier for.

### Option A — DNS `TXT` record (simpler)

Add a `TXT` record at `_atproto.facts.example.org` whose value is the
DID of the service account. Caveat: you create the account *first*
(at bsky.app, as `facts.example.org.bsky.social`), then read the DID
off the account, then add the TXT record.

```
_atproto.facts.example.org. 3600 IN TXT "did=did:plc:abcde123..."
```

### Option B — `.well-known/atproto-did` over HTTPS

Serve a plain-text file at `https://facts.example.org/.well-known/atproto-did`
containing only the DID:

```
did:plc:abcde123...
```

This works when the labeler host already terminates HTTPS at
`facts.example.org`. Coolify / Caddy / Traefik make it trivial to ship
a static file at that path.

After either record is live, set the handle in Bluesky settings → Handle
→ "I have my own domain", and click verify.

## 3. Get the fact-check feed into the data volume

The labeler ingests the **Google Data Commons Fact Check** feed
(`data.json`, about 60 MB at time of writing). It lives in the same
persistent `/data` volume as the SQLite index and signing key — one
volume to back up, one place to refresh:

```bash
# Once the container is up, drop the feed into the data volume.
# The runtime image is node:24-alpine which has wget, not curl:
docker compose run --rm fact-labeler sh -c \
  'wget -O /data/data.json https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json'
```

If you'd rather not call out into the container at all, the host can
download it next to your `docker-compose.yml` and you mount it into the
volume — but the inline download keeps everything in the named volume,
which is the cleaner backup story.

You'll want to refresh this periodically — a cron or weekly CI job
that re-downloads, re-ingests, and re-embeds is the standard pattern.
See § "Periodic re-ingest" below.

**Editorial note:** the feed is open-submission and ships a lot of spam
alongside real fact-checkers. The ingester only inserts rows whose
publisher is on a curated allowlist
(`config/claimreview-publishers-allowlist.txt`). Read
[`docs/FEED_QUALITY.md`](FEED_QUALITY.md) before going live — that
file decides which fact-checkers' verdicts your service propagates
onto Bluesky, and tells you how to report the spam back to Google.

## 4. Container env — production values

Copy `.env.example` to a per-deploy env file and override the values
below. The keys not listed here keep their `.env.example` defaults.

> **Looking for the full list of available env vars?**
> Section [§ 11 Configuration reference](#11-configuration-reference)
> below is the complete table — every knob, grouped by purpose, with
> default + meaning. This § 4 only walks through the values you
> typically need to *change* for a real production deploy.

### Required

```ini
# ---- LLM (Stage S1 + S2 + S3) ----
# Vercel AI Gateway is the documented cloud path. See docs/ADR_model_choices.md.
OPENAI_API_KEY=<vercel-or-openai-key>
OPENAI_BASE_URL=https://ai-gateway.vercel.sh/v1
OPENAI_MODEL=google/gemini-2.5-flash

# ---- Embeddings (Stage 1) ----
# TWO valid options, pick by deployment shape (see docs/ADR_model_choices.md):
#
# OPTION A — hybrid (recommended for best retrieval): granite-278m local.
# Run LM Studio on the same host as Coolify (or in a separate container)
# and point at it. EN↔DE crosslingual cosine 0.81, fast (~13 ms/query),
# zero per-query cost.
EMBEDDING_API_KEY=lm-studio
EMBEDDING_BASE_URL=http://127.0.0.1:1234/v1
EMBEDDING_MODEL=text-embedding-granite-embedding-278m-multilingual
#
# OPTION B — pure-Vercel (no LM Studio at all). Trades −7% crosslingual
# quality for one less process to run. EN↔DE crosslingual cosine 0.75,
# ~$0.07 one-time corpus rebuild, ~$1 per 1.4 M query calls. Pipeline
# Stage 2 + 3 are the real quality gates so the Stage 1 drop is acceptable.
# Uncomment to use:
# EMBEDDING_API_KEY=${OPENAI_API_KEY}
# EMBEDDING_BASE_URL=https://ai-gateway.vercel.sh/v1
# EMBEDDING_MODEL=google/text-multilingual-embedding-002

# ---- Labeler identity ----
LABELER_DID=did:plc:<your-service-DID>
LABELER_HANDLE=facts.example.org
LABELER_HOSTNAME=https://facts.example.org   # public HTTPS URL the proxy terminates at
LABELER_PORT=14831                            # internal port; reverse proxy maps 443 -> 14831
LABELER_DETAIL_BASE_URL=https://facts.example.org

# ---- Bluesky service-account credentials (for replies + AppView fallback) ----
# LABELER_BSKY_SERVICE must point at the PDS that actually hosts the
# service account. atproto is federated: each PDS authenticates its own
# users. If you signed up at bsky.app the PDS is bsky.social; if you
# signed up at Eurosky it is eurosky.social; if you self-host it is
# whatever URL your PDS runs at.
# Verify by resolving your handle to a DID and reading the
# `service[type='AtprotoPersonalDataServer'].serviceEndpoint` field
# from https://plc.directory/<your-DID>.
LABELER_BSKY_SERVICE=https://bsky.social
LABELER_BSKY_IDENTIFIER=facts.example.org
LABELER_BSKY_APP_PASSWORD=<app-password-from-your-PDS>
REPLY_TO_MENTIONS=true

# ---- Triggers ----
# Conservative default: mentions + reports only. Firehose mode will overrun a
# single LLM endpoint; turn on only with a higher-throughput model + plan.
TRIGGER_MENTIONS=true
TRIGGER_REPORTS=true
TRIGGER_FIREHOSE=false
```

### Optional

```ini
# Watchlist DIDs / handles that are always checked
TRIGGER_WATCHLIST=

# Default reply language when the mention post has no `langs` field
LABELER_REPLY_DEFAULT_LANG=en

# HITL — auto-accepts proposals when running headless. Switch to
# stdin / telegram for interactive review.
HITL_MODE=auto
TG_BOT_TOKEN=
TG_REVIEWER_CHAT_ID=

# Telemetry / debug
LOG_LEVEL=info
```

### Storage

```ini
SQLITE_PATH=/data/labeler.sqlite
CLAIMREVIEW_FEED_PATH=/data/data.json
```

`/data` should be a **persistent volume** — it carries the labeler's
SQLite index, embedding cache, and signing key after first run. Losing
this is equivalent to losing every emitted label and your label-signing
identity. Back it up.

## 5. Reverse-proxy specifics

### What the labeler exposes

| Path | Purpose | Auth |
| --- | --- | --- |
| `GET /xrpc/com.atproto.label.subscribeLabels` | Long-lived WebSocket. Subscribers (AppViews) attach here and receive every emitted label. **Required.** | none |
| `GET /xrpc/com.atproto.label.queryLabels` | Point-in-time label lookup. | none |
| `POST /xrpc/com.atproto.moderation.createReport` | Operators or end users report posts. | atproto service JWT — defaults on, see `REQUIRE_REPORT_AUTH` |
| `GET /posts/<at-uri>` | Detail HTML page per post. Linked from mention-replies. | none |
| `GET /healthz` | Liveness probe — returns `{"ok":true}`. **Use this for Coolify health checks.** | none |

All listen on `LABELER_PORT` (default 14831). The reverse proxy should
forward `https://facts.example.org:443` → container `:14831`, terminate
TLS, and proxy WebSockets (this matters for `subscribeLabels`).

### Coolify specifics

- **Build source**: GitHub → this repo. Coolify will pick up
  `Dockerfile` and `docker-compose.yml`. Either works; the Dockerfile is
  simpler.
- **Health check**: `/healthz`, expected 200, every 30 s.
- **Persistent storage**: mount a named volume at `/data`. The fact-check
  feed (`data.json`) lives inside this volume too — one mount, one
  backup target.
- **WebSocket**: enable WebSocket upgrade for the subscribeLabels path.
- **Environment**: copy the production env values from § 4 into the
  Coolify "Environment Variables" tab. Mark secrets as *secret* so they
  don't appear in build logs.

### Caddy specifics

Minimal `Caddyfile`:

```caddy
facts.example.org {
    encode gzip
    reverse_proxy localhost:14831
}
```

Caddy auto-acquires the certificate via Let's Encrypt and proxies
WebSockets through by default.

### Traefik specifics

Labels on the container:

```yaml
- traefik.enable=true
- traefik.http.routers.facts.rule=Host(`facts.example.org`)
- traefik.http.routers.facts.entrypoints=websecure
- traefik.http.routers.facts.tls.certresolver=le
- traefik.http.services.facts.loadbalancer.server.port=14831
```

## 6. First boot — ingest + embed before declaring live

Inside the container, *before* you declare the labeler to Bluesky:

```bash
# 1. Bring the ClaimReview index into the SQLite DB
pnpm ingest
# (or `docker compose run --rm fact-labeler pnpm ingest`)

# 2. Compute dense-retrieval embeddings for every row.
#    Default --batch=32 is tuned for local LM Studio. Against Vercel use:
#       pnpm cli:embed-rebuild --batch 16
#    Vercel's AI Gateway intermittently closes the response stream on
#    larger batches ("Premature close"). The CLI retries with exponential
#    backoff before giving up, but smaller batches reduce noise.
pnpm cli:embed-rebuild
# (~12 min for 92 k rows on M3 Max via local granite; 80-120 min via Vercel.)

# 3. Optionally test the pipeline against the 13-case fixture
pnpm test:matching
```

Step 3 is the gate — if `test:matching` is not 13/13 against your
chosen LLM, fix that *before* exposing the labeler to live traffic.
Once it's green, proceed to LIFECYCLE.md § Phase 1 to register the
service.

## 7. Periodic re-ingest

The Google Data Commons feed updates daily. To stay current:

```bash
# Cron entry — weekly is fine for most use-cases
0 4 * * 1   /usr/local/bin/refresh-facts.sh
```

`refresh-facts.sh` — runs the download inside the container so the file
lands in the volume directly:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/atproto-fact-labeler

# Download the fresh feed into the data volume (atomic via tmp + mv).
# Uses wget because node:24-alpine ships wget, not curl.
docker compose run --rm fact-labeler sh -c '
  set -e
  wget -O /data/data.json.new https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json
  mv /data/data.json.new /data/data.json
'

docker compose run --rm fact-labeler pnpm ingest
docker compose run --rm fact-labeler pnpm cli:embed-rebuild
```

For an index originally built before the `eld`-based language detector
landed, run a one-shot `pnpm cli:lang-rebuild` so the same-language SQL
filter in Stage 1 retrieval has correct `lang` values to filter
against. **Independent of `embed-rebuild`** — only the `lang` column is
touched, embeddings are not re-computed. Idempotent — re-running on a
freshly-ingested DB is a no-op. See
[`LANGUAGE_DETECTION.md`](LANGUAGE_DETECTION.md).

If you edited `config/claimreview-publishers-allowlist.txt` since the
last refresh — for example to drop a previously-trusted publisher —
also run `pnpm cleanup:claims` to delete the now-disallowed rows from
the existing index. New ingests honour the allowlist, but already-
ingested rows linger until removed. See
[`FEED_QUALITY.md`](FEED_QUALITY.md).

The `cli:embed-rebuild` is model-aware: only newly-ingested rows or
rows tagged with an outdated `EMBEDDING_MODEL` get re-embedded. Refresh
is cheap once the initial index is built.

## 8. Operational checks

```bash
# Identity + on-wire label counts
pnpm run lifecycle:status

# Tail the live log via Coolify, or:
docker compose logs -f fact-labeler

# Test the matching pipeline against the fixture (~5 min on Gemini-flash)
pnpm test:matching --filter polarity

# Manually label one post end-to-end
pnpm cli:label https://bsky.app/profile/<author>/post/<rkey>

# (dry-run if you do not want to emit:)
pnpm cli:label https://bsky.app/profile/<author>/post/<rkey> --dry-run
```

## 9. Backups

The persistent volume at `/data` carries the labeler signing key and
the full label history. Two things to back up routinely:

1. **`/data/labeler.sqlite`** — every emitted label, every claim, every
   verdict, every retire. This is the canonical historical record.
2. **`.env`'s `LABELER_SIGNING_KEY`** — losing this means losing the
   ability to sign new labels under the existing DID. Replacing the key
   requires running `pnpm dlx @skyware/labeler setup` again to update
   the DID document, and any cached labels signed with the old key are
   invalidated.

The fact-check index can be rebuilt from `data.json` + a re-run of
`pnpm ingest` + `pnpm cli:embed-rebuild` so it does not strictly need
backups, but rebuilding takes ~15 min.

## 10. Going live checklist

When all of the below are true, run [`LIFECYCLE.md`](./LIFECYCLE.md) §
Phase 1 to register with Bluesky:

- [ ] DNS resolves `facts.example.org` to your reverse proxy
- [ ] `https://facts.example.org/healthz` returns `{"ok":true}` from
      the public internet
- [ ] `https://facts.example.org/.well-known/atproto-did` returns your
      DID (or the equivalent `_atproto.` TXT record is live)
- [ ] `pnpm ingest` and `pnpm cli:embed-rebuild` have run inside the
      container
- [ ] `pnpm test:matching` is **13/13 green** against your configured
      LLM
- [ ] `LABELER_SIGNING_KEY` is persisted somewhere outside the container
- [ ] `LABELER_DID`, `LABELER_HANDLE`, `LABELER_HOSTNAME`,
      `LABELER_DETAIL_BASE_URL` all point at the public production URL
- [ ] `LABELER_BSKY_SERVICE` points at **the PDS that hosts the service
      account** (e.g. `https://bsky.social`, `https://eurosky.social`,
      or your self-hosted PDS) — *not* assumed to be bsky.social
- [ ] Bluesky service-account credentials in `LABELER_BSKY_IDENTIFIER`
      + `LABELER_BSKY_APP_PASSWORD` are valid (test by sending one
      `pnpm cli:label --reply`). Common 401 cause is `LABELER_BSKY_SERVICE`
      pointing at the wrong PDS.
- [ ] `config/labels.json` is on disk — needed by `pnpm dlx @skyware/labeler
      label edit` to declare the six `fact-*` label values in your
      labeler service record (see [`LIFECYCLE.md` Phase 1](./LIFECYCLE.md))
- [ ] Backup of `/data` is automated

## 11. Configuration reference

Every env var the labeler honours, grouped by purpose. Source of
truth: `src/config/index.ts` (zod schema) and
[`.env.example`](../.env.example) (the canonical commented file).
This section is the table form for browsing.

### LLM endpoint (Stages 1–3)

The chat-completions endpoint. Used for claim extraction, the rerank
pass, and the NLI judge. Anything OpenAI-compatible works: OpenAI,
Vercel AI Gateway (default), LM Studio, Ollama, vLLM, llama.cpp,
Together, Groq, Mistral, …

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — *(required)* | API key for the chat endpoint. Any non-empty value if the server doesn't check. |
| `OPENAI_BASE_URL` | `https://ai-gateway.vercel.sh/v1` | Chat-completions base URL. |
| `OPENAI_MODEL` | `google/gemini-2.5-flash` | Model name. All-local example: `qwen3.6-27b`. See [docs/ADR_model_choices.md](ADR_model_choices.md). |
| `OPENAI_MAX_TOKENS` | `8192` | Per-request `max_tokens`. Reasoning models burn tokens on internal thinking — too small a budget truncates the JSON. `0` lets the server pick. |

### Embedding endpoint (Stage 1)

Separate slot so embeddings can live on a different server from the
LLM. Leaving `_API_KEY` / `_BASE_URL` blank falls back to the
`OPENAI_*` slot.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBEDDING_API_KEY` | *(falls back to `OPENAI_API_KEY`)* | API key for the embedding endpoint. |
| `EMBEDDING_BASE_URL` | *(falls back to `OPENAI_BASE_URL`)* | `/v1/embeddings` base URL. |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Embedding model. All-local recommendation: `text-embedding-granite-embedding-278m-multilingual`. |

### Rerank (Stage 2)

Single batched LLM call rating retrieved candidates 0–1; only
candidates above threshold survive into NLI.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RERANK_MODE` | `llm` | `llm` runs the rerank call; `off` skips Stage 2. |
| `RERANK_KEEP` | `5` | Max candidates kept after rerank. |
| `RERANK_THRESHOLD` | `0.5` | Drop candidates below this rerank score. |

### NLI (Stage 3)

| Variable | Default | Purpose |
| --- | --- | --- |
| `NLI_MODE` | `llm-judge` | `llm-judge` reuses `OPENAI_MODEL` as a 3-class entailment judge. `dedicated` is reserved for a future dedicated NLI server (not implemented). |

### Labeler identity

| Variable | Default | Purpose |
| --- | --- | --- |
| `LABELER_DID` | `did:plc:placeholder-…` | The labeler service DID. Stays placeholder until you register a Bluesky service account — see [LIFECYCLE.md Phase 1](LIFECYCLE.md). |
| `LABELER_HANDLE` | *(empty)* | Optional Bluesky handle (no `@`, must look like a domain). Enables plain-text mention fallback when post `facets` are missing. |
| `LABELER_SIGNING_KEY` | *(auto on first run)* | secp256k1 signing key for label records. Auto-generated and persisted to `.env` on first run. **Back it up** — losing it invalidates every emitted label. |
| `LABELER_PORT` | `14831` | Internal port serving `subscribeLabels` / `queryLabels` **and** the detail page. |
| `LABELER_HOSTNAME` | `http://localhost:14831` | Public HTTPS URL the reverse proxy terminates at. |
| `LABELER_ROOT_REDIRECT` | *(derived)* | Where `GET /` 302-redirects to. **Unset** → derived from `LABELER_DID`: `https://bsky.app/profile/<DID>` (the labeler's own Bluesky profile, where every emitted verdict is visible). **Explicit URL** → that URL. **Empty string** → no redirect (root returns 404). When `LABELER_DID` is still the placeholder, the derived value falls back to the project repo. |
| `LABELER_DETAIL_BASE_URL` | *(falls back to `LABELER_HOSTNAME`)* | Public URL of the detail page. Used as a deep-link in mention replies and quote-posts. |

### Triggers

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRIGGER_MENTIONS` | `true` | Fact-check posts that mention the labeler (parent on reply, quoted record on quote-post). See [TRIGGER_MENTIONS.md](TRIGGER_MENTIONS.md). |
| `TRIGGER_REPORTS` | `true` | Mount `com.atproto.moderation.createReport` and dispatch every reported post. See [TRIGGER_REPORTS.md](TRIGGER_REPORTS.md). |
| `TRIGGER_FIREHOSE` | `false` | Fact-check **every** post on the firehose. Volume-heavy; only enable with a high-throughput LLM. See [TRIGGER_FIREHOSE.md](TRIGGER_FIREHOSE.md). |
| `TRIGGER_WATCHLIST` | *(empty)* | Comma-separated DIDs **or handles** whose posts are always checked. Handles resolve at startup; resolution failure aborts startup. See [TRIGGER_WATCHLIST.md](TRIGGER_WATCHLIST.md). |
| `JETSTREAM_URL` | `wss://jetstream2.us-east.bsky.network/subscribe` | Bluesky live firehose. US-east is fine from EU. |
| `JETSTREAM_FIXTURE` | *(empty)* | Path to a JSONL fixture for offline replay (development). |
| `APPVIEW_URL` | `https://public.api.bsky.app` | Bluesky read-only AppView; used to fetch post text by URI. Unauthenticated. |
| `APPVIEW_AUTHED_URL` | `https://api.bsky.app` | Authed fallback used when the public AppView returns 429/5xx and `REPLY_TO_MENTIONS=true`. Reuses the labeler's access token. |
| `REQUIRE_REPORT_AUTH` | `true` | Validate an atproto service JWT on the `createReport` endpoint. Real Bluesky clients always sign; flip to `false` only for local `curl` testing. |
| `PLC_DIRECTORY_URL` | `https://plc.directory` | DID directory used to resolve report-issuer signing keys. |

### Bluesky service account (replies + posting)

Required when **either** `REPLY_TO_MENTIONS` **or** `REPLY_TO_REPORTS`
is `true`. Same creds, two surfaces.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LABELER_BSKY_SERVICE` | `https://bsky.social` | PDS URL the service account lives on. Verify via PLC: `service[type='AtprotoPersonalDataServer'].serviceEndpoint`. Eurosky, self-hosted PDSes etc. need the explicit URL. |
| `LABELER_BSKY_IDENTIFIER` | *(empty)* | Handle or DID of the labeler account. |
| `LABELER_BSKY_APP_PASSWORD` | *(empty)* | App password from your PDS — *never* the main account password. |
| `REPLY_TO_MENTIONS` | `false` | Post a threaded reply under the mention post after a mention-triggered label is accepted. |
| `REPLY_TO_REPORTS` | `false` | Quote-post the reported post on the labeler's own feed after a report-triggered label is accepted. Author's `app.bsky.feed.postgate#disableRule` is honoured — if quotes are disabled, the labeler logs a skip and emits only the label. |
| `LABELER_REPLY_DEFAULT_LANG` | `en` | Fallback reply language when the post has no `langs` field or uses an unsupported language. Currently `en` or `de`. |

### HITL (decision review)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HITL_MODE` | `stdin` | `stdin` (interactive terminal) · `telegram` (every proposal to a chat with buttons) · `auto` (unattended; see policy below) · `auto-telegram` (auto-accept above the bar, push the rest to Telegram). |
| `TG_BOT_TOKEN` | *(empty)* | Required for `telegram` / `auto-telegram`. From `@BotFather`. |
| `TG_REVIEWER_CHAT_ID` | *(empty)* | Required for `telegram` / `auto-telegram`. Numeric chat ID (see `@userinfobot`). |
| `HITL_AUTO_MIN_CONFIDENCE` | `0.6` | Auto-accept when aggregated confidence ≥ this. Otherwise defer (or push to Telegram). |
| `HITL_AUTO_MIN_VOTES` | `2` | Auto-accept when vote count ≥ this. |

### Fact-check sources

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAIMREVIEW_FEED_PATH` | `data.json` | Path to a Google Data Commons (or own single-item) `DataFeed` JSON. See [OWN_FACT_CHECKS.md](OWN_FACT_CHECKS.md). |
| `CLAIMREVIEW_PUBLISHER_ALLOWLIST` | `config/claimreview-publishers-allowlist.txt` | Allowlist filtering both bulk ingest and live API responses. See [FEED_QUALITY.md](FEED_QUALITY.md). |
| `FACTCHECK_API_KEY` | *(empty)* | Google Fact Check Tools API key. When set, every `matchClaim()` also queries `claims:search` live and merges hits into the candidate pool. Setup: [FACTCHECK_API.md](FACTCHECK_API.md). |
| `FACTCHECK_API_PAGE_SIZE` | `10` | Results per `claims:search` call. |
| `FACTCHECK_API_TIMEOUT_MS` | `5000` | Per-call timeout for the live API. On timeout, the pipeline falls back to the local pool. |

### Storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `SQLITE_PATH` | `data/labeler.sqlite` | Index + verdict state DB. Set to `/data/labeler.sqlite` in Docker so it lands on the persistent volume. Companion `*-labels.db` (skyware) and `*-feedback.db` files live next to it. |

### Logging

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `trace` · `debug` · `info` · `warn` · `error` · `fatal`. |
