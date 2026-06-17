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
Bluesky / Jetstream
        │
        ▼
   ingest worker
        │
        ▼
 LLM extraction (LM Studio @ 127.0.0.1:1234)
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

The pipeline is **lookup-first**: most claims are answered by an existing
fact-check entry. Running our own retrieval-augmented LLM verification is a
fallback for novel claims and is stubbed in this v0 — see the `S4` notes in
`src/pipeline/orchestrator.ts`.

## Requirements

- **Node ≥ 22** and **pnpm ≥ 9** (or Docker, see below).
- **LM Studio** running an OpenAI-compatible API at
  `http://127.0.0.1:1234/v1`. A small model like `google/gemma-4-e2b`
  works for extraction.
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
detail HTTP server listening on http://127.0.0.1:14832
starting Jetstream ingest
```

The service is now consuming `app.bsky.feed.post` events from the Bluesky
Jetstream, extracting atomic claims via LM Studio, matching them against
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
  -p 14832:14832 \
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
| `OPENAI_API_KEY` | — (required) | LM Studio API key |
| `OPENAI_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible endpoint |
| `OPENAI_MODEL` | `google/gemma-4-e2b` | Extraction model |
| `LABELER_DID` | `did:plc:placeholder-…` | Labeler service DID (set after going live) |
| `LABELER_SIGNING_KEY` | _(auto-generated on first run)_ | Persist after first start |
| `LABELER_PORT` | `14831` | `subscribeLabels` / `queryLabels` |
| `LABELER_HOSTNAME` | `http://localhost:14831` | Public hostname for the labeler |
| `DETAIL_PORT` | `14832` | HTTP "why?" page |
| `JETSTREAM_URL` | `wss://jetstream2.us-east.bsky.network/subscribe` | Live firehose |
| `JETSTREAM_FIXTURE` | _(unset)_ | Path to JSONL fixture (offline replay) |
| `HITL_MODE` | `stdin` | `stdin` · `telegram` · `auto` |
| `TG_BOT_TOKEN`, `TG_REVIEWER_CHAT_ID` | — | Required when `HITL_MODE=telegram` |
| `SQLITE_PATH` | `data/labeler.sqlite` | Index + labeler state DB |
| `CLAIMREVIEW_FEED_PATH` | `data.json` | Path to the Data Commons dump |
| `LOG_LEVEL` | `info` | pino log level |

## Usage

### HITL modes

- **`stdin`** (default) — Each proposal prints in your terminal. Press
  `a`/`y` to accept, `r`/`n` to reject, `d` to defer, `q` to quit.
- **`telegram`** — Set `TG_BOT_TOKEN` and `TG_REVIEWER_CHAT_ID`, then
  `HITL_MODE=telegram`. The bot DMs you each proposal with inline
  `✅/❌/↻` buttons.
- **`auto`** — Decide automatically without a human. Used for smoke
  tests; accept iff aggregated confidence ≥ 0.8 and votes ≥ 1.

### Detail HTTP page

For any post the service has touched:

```
http://localhost:14832/posts?uri=at://did:plc:.../app.bsky.feed.post/3kx
http://localhost:14832/posts?uri=at://did:plc:.../app.bsky.feed.post/3kx&format=json
```

HTML for humans, JSON via `format=json` or `Accept: application/json`.

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
