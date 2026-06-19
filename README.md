# atproto-fact-labeler

A self-hostable [atproto](https://atproto.com) labeler that surfaces
**existing fact-check verdicts** (CORRECTIV, dpa, AFP, Snopes, PolitiFact, …)
on Bluesky posts.

**This labeler does not decide what is true.** It routes the verdicts that
third-party fact-checkers have already published. Every emitted label points
back to its source. The vocabulary on the wire is descriptive
(`fact-supported`, `fact-refuted`, `fact-disputed`, `fact-unknown`,
`fact-outdated`, `fact-mixed`).

License: MIT (see [LICENSE](./LICENSE)).

## How it works

```
Bluesky / Jetstream                    com.atproto.moderation.createReport
        │                                      │
        ▼                                      │
   ingest worker                               │
        │                                      │
        ▼                                      ▼
 trigger filter (firehose · mentions · watchlist · reports)
        │
        ▼
 LLM extraction (any OpenAI-compatible API — local or hosted)
        │
        ▼
 dense retrieval (multilingual embeddings over the local ClaimReview index)
        │
        ▼
 relevance rerank (single batched LLM call — drop irrelevant before NLI pays per-pair cost)
        │
        ▼
 NLI polarity gate (entailment / contradiction / neutral — drop neutral, flip on contradiction)
        │
        ▼
 publisher-rating normaliser → internal verdict {true,false,mixed,unknown,disputed,outdated}
        │
        ▼
 HITL (stdin · Telegram · auto)
        │ on accept
        ▼
 @skyware/labeler  →  signed label on subscribeLabels  +  detail HTML page
```

The pipeline is **lookup-first**: a claim is only labeled when an existing
fact-check from a third-party publisher matches and the NLI judge
classifies it as either entailing or contradicting the post's claim. The
contradiction case flips the publisher's verdict so a post saying *"the
earth is not flat"* gets correctly labeled as supported by fact-checks
that refute *"the earth is flat"*. Claims with no surviving match are
dropped — this labeler does not generate verdicts of its own.
See [docs/PIPELINE.md](./docs/PIPELINE.md) for the architecture and
[docs/RESEARCH-MATCHING.md](./docs/RESEARCH-MATCHING.md) for the
literature it was built from.

**Triggers are user-initiated by default.** Running an LLM extraction on
every Bluesky post (~30 M/day) is impractical for any single-LLM setup, so
the default trigger set is **mentions + reports**. Firehose mode (every
post) and watchlist (named accounts) are opt-in. See
[Triggers](#triggers).

**What this does not do.** The labeler routes *existing* third-party
verdicts; it does not generate verdicts of its own and it will return
`uncovered` rather than guess when the publisher pool is thin for a
claim. See [docs/KNOWN_LIMITATIONS.md](./docs/KNOWN_LIMITATIONS.md) for
the measured edges — what the pipeline currently handles, what it
doesn't, and what the evidence is for each statement. The 14-case
fixture in [`test/fixtures/matching-cases.json`](./test/fixtures/matching-cases.json)
is the regression contract; `pnpm test:matching` reproduces every
number cited.

## Requirements

- **Node ≥ 24** and **pnpm ≥ 11** (or Docker, see below).
  After `pnpm install`, the native `better-sqlite3` build runs because
  `pnpm-workspace.yaml` allows it (`allowBuilds`). If pnpm still warns
  about ignored builds, run `pnpm install --force` once.
- An **OpenAI-compatible chat-completions endpoint**. Anything that speaks
  the OpenAI API works — OpenAI itself, [LM Studio](https://lmstudio.ai/),
  [Ollama](https://ollama.com/blog/openai-compatibility),
  [vLLM](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html),
  llama.cpp's server, Together, Groq, Mistral, etc. Configure it via
  `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `OPENAI_MODEL`. A small model is
  used both for extraction (S1) and as the NLI judge (S3). Reasoning-class
  models work best — `qwen3.6-27b` for all-local, `google/gemini-2.5-flash`
  for Vercel. See [docs/ADR_model_choices.md](./docs/ADR_model_choices.md).
- A copy of the **Google Data Commons Fact Check feed**:
  ```bash
  curl -L \
    https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json \
    -o data.json
  ```
  (Compilation is CC BY 4.0; per-entry text remains under each publisher's
  copyright — see [docs/LICENSING.md](./docs/LICENSING.md). The feed is
  open-submission and ships SEO/blog spam alongside real fact-checkers;
  we only ingest entries from publishers on a curated allowlist — see
  [docs/FEED_QUALITY.md](./docs/FEED_QUALITY.md).)

## Quick Start

```bash
# Clone
git clone https://github.com/DracoBlue/atproto-fact-labeler.git
cd atproto-fact-labeler

# Install
pnpm install
cp .env.example .env
# Edit .env — at minimum set OPENAI_API_KEY

# Download the Google Data Commons Fact Check feed (~60 MB).
# `data.json` is gitignored — every install fetches its own copy.
curl -L \
  https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json \
  -o data.json

# Build the local fact-check index
pnpm run ingest                    # uses CLAIMREVIEW_FEED_PATH from .env
# or: pnpm run ingest path/to/data.json

# Embed every claim_reviewed text so dense retrieval can find them.
# Required after every ingest. ~12 min for a 92k-row corpus on M3 Max.
pnpm cli:embed-rebuild

# Run
pnpm run start
```

You'll see something like:

```
labeler server listening on http://127.0.0.1:14831
starting Jetstream ingest
```

The service is now consuming `app.bsky.feed.post` events from the Bluesky
Jetstream, extracting atomic claims via the configured OpenAI-compatible
endpoint, matching them against
the local fact-check index, and proposing labels via your HITL surface.

When you press `a`/`y`, the label is signed by `@skyware/labeler` and
served on `subscribeLabels`. Without a real Bluesky service account
registered in PLC, the label won't be honoured by the public AppView yet —
see [docs/DEPLOY.md](./docs/DEPLOY.md) for the infrastructure side of
a production deploy (DNS, reverse proxy, Coolify/Caddy/Traefik,
persistent storage, going-live checklist) and
[docs/LIFECYCLE.md](./docs/LIFECYCLE.md) for the Bluesky-side lifecycle
(skyware registration, retire, clear).

## Docker (GHCR)

Pre-built images are published to GitHub Container Registry on each release:

```bash
docker pull ghcr.io/dracoblue/atproto-fact-labeler:latest
```

The published `docker-compose.yml` is the supported deploy surface — it
documents the volume layout, the LM-Studio-on-host bridge, and every
configurable env var with a sensible default.

```bash
# 1. Download the fact-check feed next to your compose file
curl -L https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json -o data.json

# 2. Provide the LLM endpoint — by default we expect LM Studio on the host
#    at port 1234 with an extraction model AND an embedding model loaded.
#    See § "LM Studio host setup" below.
export OPENAI_API_KEY=lm-studio   # any non-empty value if the server doesn't check

# 3. One-off: import the ClaimReview feed into the labeler's SQLite index
docker compose run --rm fact-labeler pnpm ingest

# 4. One-off: embed every claim_reviewed text so dense retrieval can find them.
#    ~12 min for a 92k-row corpus on Apple Silicon. Required after every ingest.
docker compose run --rm fact-labeler pnpm cli:embed-rebuild

# 5. Start the labeler service
docker compose up -d
```

Verify it's up:

```bash
curl http://localhost:14831/healthz   # → ok
docker compose logs -f fact-labeler
```

The image defaults `SQLITE_PATH=/data/labeler.sqlite`. The compose file
mounts a named `fact-labeler-data` volume there so the index and labeler
signing key persist across restarts.

### Deployment shapes

The labeler has two OpenAI-compatible model slots — LLM (Stages S1
extract + S2 rerank + S3 NLI) and embedding (S1 retrieve). Three
documented deployment shapes; full benchmark + rationale in
[`docs/ADR_model_choices.md`](./docs/ADR_model_choices.md):

| Shape | LLM slot | Embedding slot | Best for |
| --- | --- | --- | --- |
| **All-local** | `qwen3.6-27b` on LM Studio | `granite-278m-multilingual` on LM Studio | offline / air-gapped / privacy |
| **Hybrid** (recommended for Coolify-style hosts) | `google/gemini-2.5-flash` on Vercel | `granite-278m-multilingual` on LM Studio | best retrieval quality + cost-controlled LLM |
| **Pure-Vercel** | `google/gemini-2.5-flash` on Vercel | `google/text-multilingual-embedding-002` on Vercel | zero local-process dependency |

#### LM Studio host setup (all-local + hybrid)

The labeler in Docker reaches the LM Studio server on the Docker host
via `host.docker.internal:1234`. Models to load:

```bash
# All-local:
lms load qwen3.6-27b
lms load text-embedding-granite-embedding-278m-multilingual

# Hybrid: only the embedding model needs to be local
lms load text-embedding-granite-embedding-278m-multilingual
```

#### Pure-Vercel — no LM Studio at all

Set both `OPENAI_BASE_URL` and `EMBEDDING_BASE_URL` to the Vercel
gateway and use the documented Vercel model names:

```ini
OPENAI_BASE_URL=https://ai-gateway.vercel.sh/v1
OPENAI_API_KEY=<vercel-key>
OPENAI_MODEL=google/gemini-2.5-flash

EMBEDDING_BASE_URL=https://ai-gateway.vercel.sh/v1
EMBEDDING_API_KEY=<vercel-key>
EMBEDDING_MODEL=google/text-multilingual-embedding-002
```

Cost reference: ~$0.07 for the one-time 92k-row index rebuild, ~$1 per
1.4 M query calls.

For a production deploy walkthrough (DNS, reverse proxy, persistent
storage, going-live checklist), see [`docs/DEPLOY.md`](./docs/DEPLOY.md).

### One-shot ops inside the container

```bash
# Re-import after refreshing data.json
docker compose run --rm fact-labeler pnpm ingest

# Re-embed (model-aware — only stale rows by default)
docker compose run --rm fact-labeler pnpm cli:embed-rebuild
docker compose run --rm fact-labeler pnpm cli:embed-rebuild --force

# Label a single Bluesky post manually
docker compose run --rm fact-labeler pnpm cli:label https://bsky.app/profile/<handle>/post/<rkey>

# Print lifecycle / on-wire status
docker compose run --rm fact-labeler pnpm lifecycle:status
```

### Build from source

```bash
docker build -t atproto-fact-labeler .
# or with compose:
docker compose build
```

## Configuration

All configuration is via environment variables (`.env` for local runs, `-e`
flags for Docker). Source of truth: `src/config/index.ts`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — (required) | API key for the OpenAI-compatible endpoint (any non-empty value if the server doesn't check) |
| `OPENAI_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible chat-completions base URL — used by the extraction LLM and (when `NLI_MODE=llm-judge`) the NLI judge |
| `OPENAI_MODEL` | `qwen3.6-27b` | Extraction (S1), reranker (S2), NLI judge (S3). All-local default; for Vercel use `google/gemini-2.5-flash`. See [docs/ADR_model_choices.md](./docs/ADR_model_choices.md) |
| `OPENAI_MAX_TOKENS` | `4096` | `max_tokens` per request — reasoning models need generous head-room or `finish_reason=length` swallows the answer |
| `EMBEDDING_API_KEY` | _(falls back to OPENAI_API_KEY)_ | API key for the embedding endpoint |
| `EMBEDDING_BASE_URL` | _(falls back to OPENAI_BASE_URL)_ | OpenAI-compatible `/v1/embeddings` base URL. Lets you host embeddings on a different server from the LLM |
| `EMBEDDING_MODEL` | `text-embedding-granite-embedding-278m-multilingual` | Stage 1 dense-retrieval model. Granite-278m ships with LM Studio, 768 dim, EN↔DE crosslingual. See [docs/PIPELINE.md](./docs/PIPELINE.md) |
| `RERANK_MODE` | `llm` | Stage 2 relevance rerank. `llm` uses one batched call against `OPENAI_MODEL` to rate retrieved candidates 0..1. `off` skips Stage 2 entirely |
| `RERANK_KEEP` | `5` | Max candidates kept after Stage 2 rerank — Stage 3 NLI runs on this many at most |
| `RERANK_THRESHOLD` | `0.5` | Drop candidates whose rerank score is below this floor |
| `NLI_MODE` | `llm-judge` | Stage 3 polarity gate. `llm-judge` prompts `OPENAI_MODEL` as a 3-class entailment judge. `dedicated` is reserved (see [`docs/ADR_nli_llm_judge_over_mdeberta.md`](./docs/ADR_nli_llm_judge_over_mdeberta.md)) |
| `LABELER_DID` | `did:plc:placeholder-…` | Labeler service DID (set after going live) |
| `LABELER_HANDLE` | _(unset)_ | Optional Bluesky handle (no `@`, must look like a domain). Enables plain-text mention fallback when post `facets` are missing. Word-boundary matched — `email@<handle>` and `<handle>.suffix` do **not** false-match. |
| `REPLY_TO_MENTIONS` | `false` | Post a Bluesky reply to the mention author after a mention-triggered label is accepted. See [docs/TRIGGER_MENTIONS.md](./docs/TRIGGER_MENTIONS.md) § Reply-to-mention |
| `LABELER_BSKY_SERVICE` | `https://bsky.social` | PDS URL the labeler account lives on |
| `LABELER_BSKY_IDENTIFIER` | — | Required when `REPLY_TO_MENTIONS=true`. Handle or DID of the labeler account |
| `LABELER_BSKY_APP_PASSWORD` | — | Required when `REPLY_TO_MENTIONS=true`. App password from bsky.app (never the main password) |
| `LABELER_DETAIL_BASE_URL` | _(unset → `LABELER_HOSTNAME`)_ | Public URL of the labeler's detail page, used as deep-link in mention replies |
| `LABELER_REPLY_DEFAULT_LANG` | `en` | Fallback language (`en` or `de`) used for mention replies when the mention post has no `langs` field or uses an unsupported language |
| `LABELER_SIGNING_KEY` | _(auto-generated on first run)_ | Persist after first start |
| `LABELER_PORT` | `14831` | `subscribeLabels` / `queryLabels` **and** the detail HTTP page |
| `LABELER_HOSTNAME` | `http://localhost:14831` | Public hostname for the labeler |
| `JETSTREAM_URL` | `wss://jetstream2.us-east.bsky.network/subscribe` | Live firehose |
| `JETSTREAM_FIXTURE` | _(unset)_ | Path to JSONL fixture (offline replay) |
| `TRIGGER_FIREHOSE` | `false` | Fact-check **every** post — opt-in, LLM-heavy |
| `TRIGGER_MENTIONS` | `true` | Fact-check posts that mention the labeler (parent on reply) |
| `TRIGGER_REPORTS` | `true` | Mount `com.atproto.moderation.createReport` and dispatch every reported post |
| `TRIGGER_WATCHLIST` | _(empty)_ | Comma-separated DIDs **or handles** whose posts are always checked. Handles are resolved to DIDs at startup; failure to resolve aborts startup |
| `APPVIEW_URL` | `https://public.api.bsky.app` | Bluesky read-only AppView; used to fetch post text by URI (mention parents, report subjects). Unauthenticated. |
| `REQUIRE_REPORT_AUTH` | `true` | Validate an atproto service JWT on `createReport`. Real Bluesky clients always sign; flip to `false` only for local curl-based testing. |
| `PLC_DIRECTORY_URL` | `https://plc.directory` | DID directory used to resolve report-issuer signing keys. |
| `HITL_MODE` | `stdin` | `stdin` · `telegram` · `auto` |
| `TG_BOT_TOKEN`, `TG_REVIEWER_CHAT_ID` | — | Required when `HITL_MODE=telegram` |
| `SQLITE_PATH` | `data/labeler.sqlite` | Index + labeler state DB |
| `CLAIMREVIEW_FEED_PATH` | `data.json` | Path to the Data Commons dump |
| `LOG_LEVEL` | `info` | pino log level |

## Usage

### Triggers

Which posts trigger an LLM extraction? Four mechanisms, freely combined.
**Defaults are conservative** so a single local LLM endpoint is not
overwhelmed.

| Trigger | Env | Default | Source | Volume | Per-trigger doc |
| --- | --- | --- | --- | --- | --- |
| **Mentions** | `TRIGGER_MENTIONS=true` | on | A Bluesky user `@mentions` the labeler — facet preferred, plain-text fallback via `LABELER_HANDLE`. In a reply, the **parent post** is fact-checked; in a quote-post, the **quoted record** is fact-checked. Optional: post a Bluesky reply to the mention author with `REPLY_TO_MENTIONS=true`. | low | [docs/TRIGGER_MENTIONS.md](./docs/TRIGGER_MENTIONS.md) |
| **Reports** | `TRIGGER_REPORTS=true` | on | A Bluesky client calls `com.atproto.moderation.createReport` against the labeler. The reported post is fact-checked. | low–medium | [docs/TRIGGER_REPORTS.md](./docs/TRIGGER_REPORTS.md) |
| **Watchlist** | `TRIGGER_WATCHLIST=did:plc:a,did:plc:b` | empty | The post's author DID is in the list. Useful for proactively monitoring politicians, news outlets, known repeat spreaders. | controllable | [docs/TRIGGER_WATCHLIST.md](./docs/TRIGGER_WATCHLIST.md) |
| **Firehose** | `TRIGGER_FIREHOSE=true` | off | Every post. Volume is realistically ~hundreds per second after pre-filtering. Only enable with a high-throughput LLM endpoint. | very high | [docs/TRIGGER_FIREHOSE.md](./docs/TRIGGER_FIREHOSE.md) |

Jetstream stays connected as long as any of `TRIGGER_FIREHOSE`,
`TRIGGER_MENTIONS`, or `TRIGGER_WATCHLIST` is set, because mentions /
watchlist need to scan the stream. With all three off, the service runs
**report-only** — the labeler endpoint stays up to answer
`subscribeLabels` and `createReport`, but no Jetstream connection is held.

#### How a mention is detected

1. Authoritative path — structured facet: a feature inside
   `record.facets[*].features[*]` with `$type = app.bsky.richtext.facet#mention`
   and `did = LABELER_DID`. Bluesky clients always emit facets for
   mentions, so this is the normal case.
2. Fallback path — plain-text substring: only used when no facets are
   present. Requires `LABELER_HANDLE`. Matches `@<handle>`,
   case-insensitive.

#### How a report is dispatched

`POST /xrpc/com.atproto.moderation.createReport` is mounted on the
labeler's HTTP port (`LABELER_PORT`). Body shape:

```jsonc
{
  "reasonType": "com.atproto.moderation.defs#reasonOther",
  "reason":     "please fact-check",
  "subject":    { "$type": "com.atproto.repo.strongRef",
                  "uri":   "at://did:plc:.../app.bsky.feed.post/3kx",
                  "cid":   "bafy..." }
}
```

The handler fetches the post via the AppView (`APPVIEW_URL`), persists it,
and runs the pipeline. The HTTP response follows
`com.atproto.moderation.defs#createReportOutput`.

### HITL modes

- **`stdin`** (default) — Each proposal prints in your terminal. Press
  `a`/`y` to accept, `r`/`n` to reject, `d` to defer, `q` to quit.
- **`telegram`** — Set `TG_BOT_TOKEN` and `TG_REVIEWER_CHAT_ID`, then
  `HITL_MODE=telegram`. The bot DMs you each proposal with inline
  `✅/❌/↻` buttons.
- **`auto`** — Decide automatically without a human. Used for smoke
  tests; accept iff aggregated confidence ≥ 0.8 and votes ≥ 1.

### Detail HTTP page

Served from the same port as the labeler. For any post the service has touched:

```
http://localhost:14831/posts?uri=at://did:plc:.../app.bsky.feed.post/3kx
http://localhost:14831/posts?uri=at://did:plc:.../app.bsky.feed.post/3kx&format=json
```

HTML for humans, JSON via `format=json` or `Accept: application/json`.
Liveness: `GET /healthz`.

### Building the dense-retrieval index — `cli:embed-rebuild`

After the first ClaimReview ingest (or after changing `EMBEDDING_MODEL`),
embed every row in the local index:

```bash
pnpm cli:embed-rebuild              # only rows missing or stale
pnpm cli:embed-rebuild --force      # re-embed every row
pnpm cli:embed-rebuild --limit 500  # smoke-test on a slice
```

This is the prerequisite for Stage 1 retrieval — without it the pipeline
returns zero candidates and the labeler is effectively offline.
Throughput against LM Studio + granite-278m on M3 Max is ~130 emb/s
(~12 min for a 92k-row corpus). The CLI is model-aware: rows tagged with
a stale `embedding_model` get re-embedded on the next run.

### Stamping languages — `cli:lang-rebuild`

Stage 1 retrieval restricts to same-language candidates. The original
ingester used URL/TLD heuristics that left ~70 % of rows untagged and
mis-labeled the rest. After upgrading from an older index, walk every
row with the on-device detector:

```bash
pnpm cli:lang-rebuild --dry-run     # preview the new distribution
pnpm cli:lang-rebuild --null-only   # touch only rows where lang IS NULL
pnpm cli:lang-rebuild               # rewrite every row (default)
```

Idempotent. New ingests already use the detector — `lang-rebuild` is
only needed once per pre-existing index. Full rationale, library
comparison, and operator workflow:
[docs/LANGUAGE_DETECTION.md](./docs/LANGUAGE_DETECTION.md).

### One-shot labeling — `cli:label`

Label a single Bluesky post manually, without standing up the Jetstream
worker or the HTTP server:

```bash
pnpm cli:label at://did:plc:alice/app.bsky.feed.post/3kxabc
pnpm cli:label at://did:plc:alice/app.bsky.feed.post/3kxabc --dry-run
pnpm cli:label at://did:plc:alice/app.bsky.feed.post/3kxabc --reply
```

The command fetches the post via the AppView, runs the pipeline,
auto-accepts the top proposal (the operator is the human reviewer when
the command runs), emits the signed label, and prints the verdict +
sources. `--dry-run` prints without emitting. `--reply` additionally
posts a Bluesky reply on the target post (requires `REPLY_TO_MENTIONS`
configured with credentials). The self-guard still applies — posts
authored by the labeler itself are refused.

### Lifecycle status

```bash
pnpm run lifecycle:status
```

Prints identity, on-wire counts, per-value live/retired counts, and a list
of recommended next steps. Safe to run any time.

## Further reading

- **[docs/DEPLOY.md](./docs/DEPLOY.md)** — production deploy via Coolify,
  Caddy, Traefik, or any reverse-proxy host. DNS, custom handle setup,
  persistent storage, going-live checklist.
- **[docs/LIFECYCLE.md](./docs/LIFECYCLE.md)** — Bluesky-side lifecycle:
  registering the labeler with skyware, pausing emissions, retiring
  labels, clearing the declaration.
- **[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)** — offline dev with
  fixtures, smoke test, running the test suite, commit conventions,
  source layout.
- **[docs/LICENSING.md](./docs/LICENSING.md)** — what you may and may not
  do with the data the labeler ingests.

## Acknowledgements

Built on top of [`@skyware/labeler`](https://github.com/skyware-js/labeler),
the lightweight atproto labeler SDK that lets you skip Ozone for solo / lean
deployments.
