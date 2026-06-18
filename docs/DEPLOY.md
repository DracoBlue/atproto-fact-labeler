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

## 4. Container env — production values

Copy `.env.example` to a per-deploy env file and override the values
below. The keys not listed here keep their `.env.example` defaults.

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
LABELER_BSKY_IDENTIFIER=facts.example.org
LABELER_BSKY_APP_PASSWORD=<app-password-from-bsky.app>
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

# 2. Compute dense-retrieval embeddings for every row
pnpm cli:embed-rebuild
# (~12 min for 92 k rows on M3 Max; longer or shorter depending on host)

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
- [ ] Bluesky service-account credentials in `LABELER_BSKY_IDENTIFIER`
      + `LABELER_BSKY_APP_PASSWORD` are valid (test by sending one
      `pnpm cli:label --reply`)
- [ ] Backup of `/data` is automated
