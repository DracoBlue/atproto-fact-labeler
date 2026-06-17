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
 ClaimReview lookup (local SQLite index, built from Google Data Commons feed)
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

The pipeline is **lookup-first**: a claim is only labeled when there's a
matching fact-check entry from a third-party publisher in the local index.
Claims without a match are dropped — this labeler does not generate
verdicts of its own.

**Triggers are user-initiated by default.** Running an LLM extraction on
every Bluesky post (~30 M/day) is impractical for any single-LLM setup, so
the default trigger set is **mentions + reports**. Firehose mode (every
post) and watchlist (named accounts) are opt-in. See
[Triggers](#triggers).

## Requirements

- **Node ≥ 22** and **pnpm ≥ 9** (or Docker, see below).
- An **OpenAI-compatible chat-completions endpoint**. Anything that speaks
  the OpenAI API works — OpenAI itself, [LM Studio](https://lmstudio.ai/),
  [Ollama](https://ollama.com/blog/openai-compatibility),
  [vLLM](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html),
  llama.cpp's server, Together, Groq, Mistral, etc. Configure it via
  `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `OPENAI_MODEL`. A small model is
  enough for extraction (e.g. `google/gemma-4-e2b` on LM Studio).
- A copy of the **Google Data Commons Fact Check feed**:
  ```bash
  curl -L \
    https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json \
    -o data.json
  ```
  (Compilation is CC BY 4.0; per-entry text remains under each publisher's
  copyright — see [docs/LICENSING.md](./docs/LICENSING.md).)

## Quick Start

```bash
# Clone
git clone https://github.com/DracoBlue/atproto-fact-labeler.git
cd atproto-fact-labeler

# Install
pnpm install
cp .env.example .env
# Edit .env — at minimum set OPENAI_API_KEY

# Build the local fact-check index
pnpm run ingest                    # uses CLAIMREVIEW_FEED_PATH from .env
# or: pnpm run ingest path/to/data.json

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
see [docs/LIFECYCLE.md](./docs/LIFECYCLE.md) for going live.

## Docker (GHCR)

Pre-built images are published to GitHub Container Registry on each release:

```bash
docker pull ghcr.io/dracoblue/atproto-fact-labeler:latest
```

```bash
docker run -d \
  -p 14831:14831 \
  -v fact-labeler-data:/data \
  -v "$PWD/data.json:/feed/data.json:ro" \
  -e OPENAI_API_KEY=sk-lm-... \
  -e OPENAI_BASE_URL=http://host.docker.internal:1234/v1 \
  -e CLAIMREVIEW_FEED_PATH=/feed/data.json \
  -e HITL_MODE=auto \
  ghcr.io/dracoblue/atproto-fact-labeler:latest
```

The image defaults `SQLITE_PATH=/data/labeler.sqlite`. Mount a named volume
at `/data` to persist the fact-check index and labeler key between runs.

Build from source:

```bash
docker build -t atproto-fact-labeler .
```

## Configuration

All configuration is via environment variables (`.env` for local runs, `-e`
flags for Docker). Source of truth: `src/config/index.ts`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — (required) | API key for the OpenAI-compatible endpoint (any non-empty value if the server doesn't check) |
| `OPENAI_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible chat-completions base URL |
| `OPENAI_MODEL` | `google/gemma-4-e2b` | Extraction model name (must be one the endpoint serves) |
| `LABELER_DID` | `did:plc:placeholder-…` | Labeler service DID (set after going live) |
| `LABELER_HANDLE` | _(unset)_ | Optional Bluesky handle (no `@`); enables plain-text mention fallback when post `facets` are missing |
| `LABELER_SIGNING_KEY` | _(auto-generated on first run)_ | Persist after first start |
| `LABELER_PORT` | `14831` | `subscribeLabels` / `queryLabels` **and** the detail HTTP page |
| `LABELER_HOSTNAME` | `http://localhost:14831` | Public hostname for the labeler |
| `JETSTREAM_URL` | `wss://jetstream2.us-east.bsky.network/subscribe` | Live firehose |
| `JETSTREAM_FIXTURE` | _(unset)_ | Path to JSONL fixture (offline replay) |
| `TRIGGER_FIREHOSE` | `false` | Fact-check **every** post — opt-in, LLM-heavy |
| `TRIGGER_MENTIONS` | `true` | Fact-check posts that mention the labeler (parent on reply) |
| `TRIGGER_REPORTS` | `true` | Mount `com.atproto.moderation.createReport` and dispatch every reported post |
| `TRIGGER_WATCHLIST` | _(empty)_ | Comma-separated DIDs whose posts are always checked |
| `APPVIEW_URL` | `https://api.bsky.app` | Used to fetch post text by URI (mention parents, report subjects) |
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

| Trigger | Env | Default | Source | Volume |
| --- | --- | --- | --- | --- |
| **Mentions** | `TRIGGER_MENTIONS=true` | on | A Bluesky user `@mentions` the labeler — facet preferred, plain-text fallback via `LABELER_HANDLE`. In a reply, the **parent post** is fact-checked. | low |
| **Reports** | `TRIGGER_REPORTS=true` | on | A Bluesky client calls `com.atproto.moderation.createReport` against the labeler. The reported post is fact-checked. | low–medium |
| **Watchlist** | `TRIGGER_WATCHLIST=did:plc:a,did:plc:b` | empty | The post's author DID is in the list. Useful for proactively monitoring politicians, news outlets, known repeat spreaders. | controllable |
| **Firehose** | `TRIGGER_FIREHOSE=true` | off | Every post. Volume is realistically ~hundreds per second after pre-filtering. Only enable with a high-throughput LLM endpoint. | very high |

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

### Lifecycle status

```bash
pnpm run lifecycle:status
```

Prints identity, on-wire counts, per-value live/retired counts, and a list
of recommended next steps. Safe to run any time.

## Further reading

- **[docs/LIFECYCLE.md](./docs/LIFECYCLE.md)** — going live on Bluesky,
  pausing, retiring labels, clearing the declaration. Required reading
  before running this in production.
- **[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)** — offline dev with
  fixtures, smoke test, running the test suite, commit conventions,
  source layout.
- **[docs/LICENSING.md](./docs/LICENSING.md)** — what you may and may not
  do with the data the labeler ingests.

## Acknowledgements

Built on top of [`@skyware/labeler`](https://github.com/skyware-js/labeler),
the lightweight atproto labeler SDK that lets you skip Ozone for solo / lean
deployments.
