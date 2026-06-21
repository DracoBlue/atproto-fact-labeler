# Hosting

Self-host an atproto-fact-labeler that signs labels under your own
Bluesky service account. This is the operator handbook — everything
you need from "I want to run this" through "labels are flowing to
Bluesky subscribers".

## Prerequisites

Things you bring before the setup starts. None of this is "running
a command" — it's identity, hardware, and external accounts.

- **A dedicated Bluesky account.** Distinct from any personal
  account; the labeler signs every label under this account's DID.
  Create it at [bsky.app](https://bsky.app) or any other PDS
  (Eurosky, self-hosted). It's just an account at this point — the
  labeler stuff happens in *Setup* below.
- **A server with ~1 GB RAM, ~1 GB disk** that runs Node 24 + pnpm
  11. Docker is supported (`ghcr.io/dracoblue/atproto-fact-labeler:latest`
  with the bundled `docker-compose.yml`) but not required.
- **An OpenAI-compatible LLM endpoint.** Stages 1, 3, 4 of the
  matching pipeline call out to it. Default points at
  [Vercel AI Gateway](https://vercel.com/ai-gateway);
  [LM Studio](https://lmstudio.ai/), [Ollama](https://ollama.ai/),
  vLLM, OpenAI itself all work — same OpenAI shape, different
  `OPENAI_BASE_URL`. Model rationale: [`adr/model-choices.md`](./adr/model-choices.md).
- **A domain you control** *(optional)* if you want a custom handle
  like `facts.example.org`. Skip if `facts.bsky.social` is fine.
  DNS specifics under *Going to production* below.
- **A Google Cloud API key** *(optional)* — enables the live Fact
  Check Tools API which closes the English-publisher gap.
  Setup: [`sources/factcheck-api.md`](./sources/factcheck-api.md).
- **A Telegram bot** *(optional)* — for `HITL_MODE=telegram` /
  `auto-telegram`. Bot token from [`@BotFather`](https://t.me/BotFather),
  chat ID from [`@userinfobot`](https://t.me/userinfobot).

## Setup

Pick one path. Each line below works as-is bare-metal; prefix with
`docker compose run --rm fact-labeler` to run inside the bundled
image. The compose file already points at
`ghcr.io/dracoblue/atproto-fact-labeler:latest` — no source build
needed.

```bash
# 1. Get the code + configure
git clone https://github.com/DracoBlue/atproto-fact-labeler.git
cd atproto-fact-labeler
cp .env.example .env
$EDITOR .env                  # OPENAI_API_KEY at minimum
pnpm install                  # skip this if you're using Docker

# 2. Pull the bulk fact-check feed (~60 MB)
#    (sources/data-commons.md explains what's in it + how to refresh)
curl -L https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json \
  -o data.json

# 3. Build the local index
pnpm ingest                   # import allow-listed rows into SQLite
pnpm cli:lang-rebuild         # populate language column
pnpm cli:embed-rebuild        # compute embeddings (~15 min cold)

# 4. Turn the Bluesky account into a labeler
#    Step a — update the DID document to declare the labeler endpoint
#    and signing key. Skyware asks for the account creds and a PLC
#    token mailed to the address.
#    PERSIST THE SIGNING KEY — losing it invalidates every emitted
#    label.
pnpm dlx @skyware/labeler setup

#    Step b — declare the six fact-* label values in the account's
#    app.bsky.labeler.service record. Reads config/labels.json
#    directly; no editor paste.
pnpm labeler:declare

# 5. Start the service
pnpm start                    # or: docker compose up -d
```

Skyware's [getting-started guide](https://skyware.js.org/guides/labeler/introduction/getting-started/)
has the DID / PLC-token detail for step 4a. Step 4b is idempotent —
re-run after editing `config/labels.json` to push the new
definitions; the Bluesky AppView picks them up within a minute.

## First label

You're going to subscribe to your own labeler on Bluesky, then
mention it on a post that contains a factual claim. The label
appears on the post within ~30 s.

1. Open the [moderation settings page on Bluesky](https://bsky.app/moderation),
   search for your labeler's handle, and tap *Subscribe to labeler*.
2. On Bluesky, find a post that makes a falsifiable claim ("the
   earth is flat", "vaccines contain microchips" — pick whatever
   you'd actually want a fact-check on). Reply to it and mention
   `@<your-labeler-handle>` in the reply.
3. Within ~30 seconds the post should sprout a `fact-*` badge in
   your Bluesky timeline.
4. Click the badge → the labeler's detail page opens at
   `https://<your-host>/posts?uri=<at-uri>` and shows the extracted
   claim, the NLI vote breakdown, and every cited publisher's
   article URL.

If nothing shows up after a minute, check `pnpm run lifecycle:status`
and the labeler logs. The `pnpm cli:label <url>` CLI runs the same
pipeline directly and is useful when the on-wire path isn't
behaving — it prints the verdict and evidence to stdout without
emitting on the wire.

The 14-case fixture is the calibrated correctness gate:

```bash
pnpm test:matching            # 14/14 is the going-live bar
```

Anything below that, fix before exposing the labeler to real
traffic.

## Configuration reference

Every env var the labeler honours, grouped by purpose. Source of
truth: `src/config/index.ts` (zod schema) and
[`.env.example`](../.env.example).

### LLM endpoint (Stages 1, 3, 4)

The chat-completions endpoint used for claim extraction, rerank
scoring, and NLI judging. Anything OpenAI-compatible works.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — *(required)* | API key for the chat endpoint. Any non-empty value if the server doesn't check. |
| `OPENAI_BASE_URL` | `https://ai-gateway.vercel.sh/v1` | Chat-completions base URL. |
| `OPENAI_MODEL` | `google/gemini-2.5-flash` | Model name. All-local alternative: `qwen3.6-27b`. Selection rationale + head-to-head benchmark: [`adr/model-choices.md`](./adr/model-choices.md). |
| `OPENAI_MAX_TOKENS` | `8192` | Per-request `max_tokens`. Reasoning models burn tokens on internal thinking — too small a budget truncates the JSON. `0` lets the server pick. |

### Embedding endpoint (Stage 2)

Separate slot so embeddings can live on a different server from the
LLM. Leaving these blank falls back to the `OPENAI_*` slot.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBEDDING_API_KEY` | *(falls back to `OPENAI_API_KEY`)* | API key for the embedding endpoint. |
| `EMBEDDING_BASE_URL` | *(falls back to `OPENAI_BASE_URL`)* | `/v1/embeddings` base URL. |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Embedding model. All-local recommendation: `text-embedding-granite-embedding-278m-multilingual` via LM Studio. Trade-offs: [`adr/model-choices.md`](./adr/model-choices.md). |

### Rerank (Stage 3)

Single batched LLM call rating retrieved candidates 0–1; only
candidates above threshold survive into NLI.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RERANK_MODE` | `llm` | `llm` runs the rerank call; `off` skips Stage 3. |
| `RERANK_KEEP` | `5` | Max candidates kept after rerank. |
| `RERANK_THRESHOLD` | `0.5` | Drop candidates below this rerank score. |

### NLI (Stage 4)

| Variable | Default | Purpose |
| --- | --- | --- |
| `NLI_MODE` | `llm-judge` | `llm-judge` reuses `OPENAI_MODEL` as a 3-class entailment judge. `dedicated` is reserved but [not implemented](./adr/nli-judge-llm-not-mdeberta.md). |

### Labeler identity

| Variable | Default | Purpose |
| --- | --- | --- |
| `LABELER_DID` | `did:plc:placeholder-…` | The labeler service DID. Stays placeholder until *Setup step 4* (`@skyware/labeler setup`) writes it. |
| `LABELER_HANDLE` | *(empty)* | Optional Bluesky handle (no `@`, must look like a domain). Enables plain-text mention fallback when post `facets` are missing. |
| `LABELER_SIGNING_KEY` | *(auto on first run)* | secp256k1 signing key for label records. Auto-generated and persisted to `.env` on first run. **Back it up** — losing it invalidates every emitted label. |
| `LABELER_PORT` | `14831` | Internal port serving `subscribeLabels` / `queryLabels` **and** the detail page. |
| `LABELER_HOSTNAME` | `http://localhost:14831` | Public HTTPS URL the reverse proxy terminates at. |
| `LABELER_DETAIL_BASE_URL` | *(falls back to `LABELER_HOSTNAME`)* | Public URL of the detail page. Used as a deep-link in mention replies and quote-posts. |
| `LABELER_ROOT_REDIRECT` | *(derived)* | Where `GET /` 302-redirects to. **Unset** → derived from `LABELER_DID`: `https://bsky.app/profile/<DID>`. **Explicit URL** → that URL. **Empty string** → no redirect (root returns 404). |
| `ATPROTO_RETIRE_MODE` | `delete` | What happens to the atproto `claimVerdict` record when `pnpm retire` retracts a verdict. `delete` removes the record from the PDS; `tombstone` keeps it visible with a `retiredAt` field. The on-wire bsky label is always negated regardless. |

### Triggers

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRIGGER_MENTIONS` | `true` | Fact-check posts that mention the labeler (parent on reply, quoted record on quote-post). [`triggers/mentions.md`](./triggers/mentions.md). |
| `TRIGGER_REPORTS` | `true` | Mount `com.atproto.moderation.createReport` and dispatch every reported post. [`triggers/reports.md`](./triggers/reports.md). |
| `TRIGGER_FIREHOSE` | `false` | Fact-check **every** post on the firehose. Volume-heavy; only enable with a high-throughput LLM. [`triggers/firehose.md`](./triggers/firehose.md). |
| `TRIGGER_WATCHLIST` | *(empty)* | Comma-separated DIDs **or handles** whose posts are always checked. Handles resolve at startup. [`triggers/watchlist.md`](./triggers/watchlist.md). |
| `JETSTREAM_URL` | `wss://jetstream2.us-east.bsky.network/subscribe` | Bluesky live firehose. US-east is fine from EU. |
| `JETSTREAM_FIXTURE` | *(empty)* | Path to a JSONL fixture for offline replay (development). |
| `APPVIEW_URL` | `https://public.api.bsky.app` | Bluesky read-only AppView; used to fetch post text by URI. |
| `APPVIEW_AUTHED_URL` | `https://api.bsky.app` | Authed fallback used when the public AppView returns 429/5xx and `REPLY_TO_MENTIONS=true`. |
| `REQUIRE_REPORT_AUTH` | `true` | Validate an atproto service JWT on the `createReport` endpoint. Real Bluesky clients always sign; flip to `false` only for local `curl` testing. |
| `PLC_DIRECTORY_URL` | `https://plc.directory` | DID directory used to resolve report-issuer signing keys. |

### Bluesky service account (replies + posting)

Required when `REPLY_TO_MENTIONS` or `REPLY_TO_REPORTS` is `true`.
Same creds, two surfaces.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LABELER_BSKY_SERVICE` | `https://bsky.social` | PDS URL the service account lives on. Verify via PLC: `service[type='AtprotoPersonalDataServer'].serviceEndpoint`. Eurosky / self-hosted PDSes need the explicit URL. |
| `LABELER_BSKY_IDENTIFIER` | *(empty)* | Handle or DID of the labeler account. |
| `LABELER_BSKY_APP_PASSWORD` | *(empty)* | App password from your PDS — *never* the main account password. |
| `REPLY_TO_MENTIONS` | `false` | Post a threaded reply under the mention post after a mention-triggered label is accepted. |
| `REPLY_TO_REPORTS` | `false` | Quote-post the reported post on the labeler's own feed after a report-triggered label is accepted. The author's postgate is honoured. |
| `LABELER_REPLY_DEFAULT_LANG` | `en` | Fallback reply language when the post has no `langs` field or uses an unsupported language. Currently `en` or `de`. |

### HITL (decision review)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HITL_MODE` | `stdin` | `stdin` (interactive terminal) · `telegram` (every proposal to a chat with buttons) · `auto` (unattended) · `auto-telegram` (auto-accept above the bar, push the rest to Telegram). |
| `TG_BOT_TOKEN` | *(empty)* | Required for `telegram` / `auto-telegram`. From `@BotFather`. |
| `TG_REVIEWER_CHAT_ID` | *(empty)* | Required for `telegram` / `auto-telegram`. Numeric chat ID (see `@userinfobot`). |
| `HITL_AUTO_MIN_CONFIDENCE` | `0.6` | Auto-accept when aggregated confidence ≥ this. Otherwise defer (or push to Telegram). |
| `HITL_AUTO_MIN_VOTES` | `2` | Auto-accept when vote count ≥ this. Single-publisher verdicts go through human review by default. |

### Fact-check sources

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAIMREVIEW_FEED_PATH` | `data.json` | Path to a Google Data Commons (or own single-item) `DataFeed` JSON. [`sources/own-claimreviews.md`](./sources/own-claimreviews.md) · [`sources/data-commons.md`](./sources/data-commons.md). |
| `CLAIMREVIEW_PUBLISHER_ALLOWLIST` | `config/claimreview-publishers-allowlist.txt` | Allowlist filtering bulk ingest AND live API responses. [`sources/allowlist.md`](./sources/allowlist.md). |
| `FACTCHECK_API_KEY` | *(empty)* | Google Fact Check Tools API key. When set, every `matchClaim()` also queries `claims:search` live and merges hits into the candidate pool. [`sources/factcheck-api.md`](./sources/factcheck-api.md). |
| `FACTCHECK_API_PAGE_SIZE` | `10` | Results per `claims:search` call. |
| `FACTCHECK_API_TIMEOUT_MS` | `5000` | Per-call timeout for the live API. On timeout, the pipeline falls back to the local pool. |

### Storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `SQLITE_PATH` | `data/labeler.sqlite` | Index + verdict state DB. Set to `/data/labeler.sqlite` in Docker so it lands on the persistent volume. |

### Logging

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `trace` · `debug` · `info` · `warn` · `error` · `fatal`. |

## Going to production

### Custom-domain DNS

For a handle like `facts.example.org`, Bluesky resolves either of:

**DNS TXT record** — add a `TXT` at `_atproto.facts.example.org`
whose value is the DID:

```
_atproto.facts.example.org. 3600 IN TXT "did=did:plc:abcde123..."
```

Caveat: create the account *first* (as
`facts.example.org.bsky.social`), read the DID, then add the TXT.

**`.well-known/atproto-did` over HTTPS** — serve a plain-text file
at `https://facts.example.org/.well-known/atproto-did` containing
the DID. Coolify / Caddy / Traefik make this trivial.

After either, set the handle in Bluesky settings → Handle → "I have
my own domain", click verify.

### Reverse proxy

What the labeler exposes:

| Path | Purpose | Auth |
| --- | --- | --- |
| `GET /xrpc/com.atproto.label.subscribeLabels` | Long-lived WebSocket. AppViews attach here. **Required.** | none |
| `GET /xrpc/com.atproto.label.queryLabels` | Point-in-time label lookup. | none |
| `POST /xrpc/com.atproto.moderation.createReport` | Operators / end users report posts. | atproto JWT (`REQUIRE_REPORT_AUTH=true` default) |
| `GET /posts?uri=<at-uri>` | Detail HTML page per post. Linked from mention-replies. | none |
| `GET /healthz` | Liveness probe — returns `{"ok":true}`. | none |

All listen on `LABELER_PORT` (default 14831). The reverse proxy
forwards `https://facts.example.org:443` → container `:14831`,
terminates TLS, and proxies WebSockets (this matters for
`subscribeLabels`).

**Coolify:** Build source = GitHub → this repo. Health check
`/healthz` 200 every 30s. Mount a named volume at `/data` (the
fact-check feed + SQLite + signing key all live in it — one mount,
one backup target). Enable WebSocket upgrade. Mark env-var secrets
so they don't appear in build logs.

**Caddy:**

```caddy
facts.example.org {
    encode gzip
    reverse_proxy localhost:14831
}
```

Caddy auto-acquires Let's Encrypt and proxies WebSockets by default.

**Traefik** (container labels):

```yaml
- traefik.enable=true
- traefik.http.routers.facts.rule=Host(`facts.example.org`)
- traefik.http.routers.facts.entrypoints=websecure
- traefik.http.routers.facts.tls.certresolver=le
- traefik.http.services.facts.loadbalancer.server.port=14831
```

### Periodic re-ingest

The Google Data Commons feed updates daily. To stay current:

```bash
# Cron — weekly is fine for most use-cases
0 4 * * 1   /usr/local/bin/refresh-facts.sh
```

`refresh-facts.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/atproto-fact-labeler

# Atomic download via tmp + mv. node:24-alpine ships wget, not curl.
docker compose run --rm fact-labeler sh -c '
  set -e
  wget -O /data/data.json.new https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json
  mv /data/data.json.new /data/data.json
'

docker compose run --rm fact-labeler pnpm ingest
docker compose run --rm fact-labeler pnpm cli:embed-rebuild
```

If you edited the allowlist since the last refresh — for example
to drop a previously-trusted publisher — also run
`pnpm cleanup:claims` to delete the now-disallowed rows from the
existing index. See [`sources/allowlist.md`](./sources/allowlist.md).

The `cli:embed-rebuild` is model-aware: only newly-ingested rows or
rows tagged with an outdated `EMBEDDING_MODEL` get re-embedded.
Refresh is cheap once the initial index is built.

### Backups

The persistent volume at `/data` carries the labeler signing key
and the full label history. Two things to back up routinely:

1. **`/data/labeler.sqlite`** — every emitted label, every claim,
   every verdict, every retire. The canonical historical record.
2. **`.env`'s `LABELER_SIGNING_KEY`** — losing this means losing the
   ability to sign new labels under the existing DID. Replacing the
   key requires running `pnpm dlx @skyware/labeler setup` again and
   invalidates every cached label signed with the old key.

The fact-check index can be rebuilt from `data.json` + a re-run of
`pnpm ingest` + `pnpm cli:embed-rebuild`, so it doesn't strictly
need backups — rebuilding takes ~15 min.

## Operational lifecycle

You must understand the **full lifecycle** before running this in
production: online, paused, retired, cleared. Atproto labels are
durable signed objects — turning the service off does **not** make
them go away.

### Status at any time

```bash
pnpm run lifecycle:status
```

Prints identity, on-wire counts, per-value live/retired counts, and
a list of recommended next steps based on current state. Safe to
run any time.

### Pausing emissions (temporary)

**Variant A — server reboot, deploy, brief maintenance.** Just
stop the process. The WebSocket breaks, AppViews reconnect with
exponential backoff, and the cursor lets them resume without gaps
when you restart. Existing labels stay visible the whole time —
they live in the AppView's cache, not on your server.

**Variant B — longer pause, server stays up.** Stop the *pipeline*
but keep `subscribeLabels` / `queryLabels` answering:

```bash
HITL_MODE=auto JETSTREAM_FIXTURE=/dev/null pnpm run start
```

Subscribers see no new labels; existing ones are untouched.

### Retiring labels (variant C)

When labels were emitted in error, or to take them off the wire
without removing the labeler entirely:

```bash
# 1. Preview what would be negated (server can stay running for this)
docker compose exec fact-labeler pnpm retire --dry-run

# 2. Stop the live labeler — retire signs + emits through its own
#    LabelerServer instance, which needs the same port and writes to
#    the same labels.db. Two processes on labels.db would race.
docker compose stop fact-labeler

# 3. Apply (signs and emits a neg=true companion for every live label).
docker compose run --rm fact-labeler pnpm retire

# 4. Bring the labeler back up.
docker compose start fact-labeler

# Filters work in both --dry-run and apply forms:
docker compose run --rm fact-labeler pnpm retire --val=fact-refuted
docker compose run --rm fact-labeler pnpm retire --uri=at://did:plc:.../app.bsky.feed.post/3kx
```

Each negation is a real, signed atproto label with `neg=true`.
AppViews stop hydrating the original on next sync. End users stop
seeing the badge. The original signed label is **not** deleted —
the negation overrides it on read.

Re-running after a partial crash is safe — `retire` is idempotent
and skips already-negated labels.

**Local side-effects:** `retire` also stamps `verdict.retired_at`
on the matching local row, which hides the verdict from the detail
page. The original verdict row is not deleted; `retired_at` is a
timestamp column you can query for the audit trail.

### Manually accepting a deferred proposal

`HITL_MODE=auto` defers proposals whose aggregated confidence is
below `HITL_AUTO_MIN_CONFIDENCE` or whose vote count is below
`HITL_AUTO_MIN_VOTES`. To ship the label anyway after manual review:

```bash
# Show pending deferred proposals (read-only — server can stay up)
docker compose exec fact-labeler pnpm proposal:accept --list

# Stop the labeler so its port + labels.db are free, accept one, restart.
docker compose stop fact-labeler
docker compose run --rm fact-labeler pnpm proposal:accept --id=6
docker compose start fact-labeler
```

Use sparingly — every manual accept is a decision the auto-policy
wanted to defer. If you find yourself doing it often, lower
`HITL_AUTO_MIN_CONFIDENCE` or switch to `HITL_MODE=telegram`.

### Clearing the labeler declaration (permanent)

When you want to retire the labeler **permanently** — the account
becomes a normal Bluesky user again. **Run the retire flow first**
so existing labels stop being shown; clearing the declaration on
its own does *not* invalidate labels that AppViews have already
cached.

```bash
# 1. Make sure no labels are still live on the wire
pnpm run lifecycle:status
# Expected: "currently live = 0"

# 2. Remove #atproto_label and #atproto_labeler from the DID document
#    and delete app.bsky.labeler.service:
pnpm dlx @skyware/labeler clear
```

Skyware asks for credentials and a PLC token; the operation is
reversible by re-running `pnpm dlx @skyware/labeler setup`.

After clearing:

- The DID still exists; the account is no longer recognised as a
  labeler.
- Cached labels in AppViews may persist for a while, but new label
  signatures from your old key are no longer trusted.
- New subscribers can no longer discover you.

## Going-live checklist

When all of the below are true, you're ready to flip the labeler
visible to real Bluesky users:

- [ ] DNS resolves `facts.example.org` to your reverse proxy
- [ ] `https://facts.example.org/healthz` returns `{"ok":true}` from
      the public internet
- [ ] `https://facts.example.org/.well-known/atproto-did` returns
      your DID (or the equivalent `_atproto.` TXT record is live)
- [ ] `pnpm ingest` and `pnpm cli:embed-rebuild` have run inside
      the container
- [ ] `pnpm test:matching` is **14/14 green** against your
      configured LLM
- [ ] `LABELER_SIGNING_KEY` is persisted somewhere outside the
      container
- [ ] `LABELER_DID`, `LABELER_HANDLE`, `LABELER_HOSTNAME`,
      `LABELER_DETAIL_BASE_URL` all point at the public production
      URL
- [ ] `LABELER_BSKY_SERVICE` points at **the PDS that hosts the
      service account** (not assumed to be bsky.social)
- [ ] Bluesky service-account credentials are valid (test by sending
      one `pnpm cli:label --reply`)
- [ ] `pnpm labeler:declare` has run successfully — the six
      `fact-*` label values are present in the account's
      `app.bsky.labeler.service` record
- [ ] Backup of `/data` is automated

## Cheat sheet

| Goal | Command |
| --- | --- |
| Healthcheck | `curl http://localhost:14831/healthz` |
| Manually label one post | `pnpm cli:label https://bsky.app/profile/<author>/post/<rkey>` |
| Test matching pipeline | `pnpm test:matching --filter polarity` |
| Pause emissions, keep serving | start with `HITL_MODE=auto JETSTREAM_FIXTURE=/dev/null` |
| Preview a retire | `pnpm retire --dry-run` |
| Retire all live labels | stop labeler, `docker compose run --rm fact-labeler pnpm retire`, start labeler |
| Retire one label value | `pnpm retire --val=fact-refuted` |
| Retire labels on one post | `pnpm retire --uri=at://…` |
| See current state | `pnpm run lifecycle:status` |
| Permanently retire labeler | retire first, then `pnpm dlx @skyware/labeler clear` |
| Manually accept a deferred proposal | stop labeler, `pnpm proposal:accept --id=N`, start labeler |
