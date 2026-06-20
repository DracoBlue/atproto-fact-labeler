# atproto-fact-labeler

A self-hostable [atproto](https://atproto.com) labeler that surfaces
**existing fact-check verdicts** on Bluesky posts. Six descriptive
labels — `fact-supported`, `fact-refuted`, `fact-disputed`,
`fact-mixed`, `fact-outdated`, `fact-unknown` — each one linked back
to the publisher's original article.

**The labeler does not decide what is true.** It looks up what
independent fact-checkers have already published and surfaces their
verdict on matching posts. When no publisher has reviewed a claim the
labeler returns nothing.

License: MIT.

---

## Where the verdicts come from

The labeler can pull fact-checks from three independent sources — use
any one, or combine them. Each entry in the local index keeps its
provenance so the detail page can show "Sourced via …" alongside the
publisher name.

1. **Your own ClaimReview articles**
   Self-hosting a newsroom or NGO that already publishes
   ClaimReview-tagged fact-checks? Drop a single-item
   [schema.org `DataFeed`](https://schema.org/DataFeed) JSON into
   `pnpm ingest` and your fact-checks become labels. See
   [docs/OWN_FACT_CHECKS.md](./docs/OWN_FACT_CHECKS.md).

2. **The Google Data Commons bulk feed** — the daily 60 MB
   [public dump](https://datacommons.org/factcheck/). Strong on
   non-English fact-checks (dpa, AFP, Univision El Detector, factly.in,
   …); thin on Lead Stories, USA Today, Snopes, AAP. Filtered through
   a [curated publisher allowlist](./docs/FEED_QUALITY.md) to drop
   the SEO spam and injection attempts the open feed ships alongside
   real fact-checkers.

3. **Google Fact Check Tools API (live)** — query
   [`claims:search`](https://developers.google.com/fact-check/tools/api)
   per claim. Closes the bulk-feed gap: Lead Stories, USA Today,
   Snopes, AAP and similar publishers ship ClaimReview on their own
   pages without submitting to the bulk feed. Setup is one API key.
   See [docs/FACTCHECK_API.md](./docs/FACTCHECK_API.md).

---

## Should I self-host this?

You need:

- **A server** with ~1 GB RAM, ~1 GB disk for the SQLite index, and a
  domain you control (`facts.example.org`). Coolify / Caddy / Traefik
  / a tiny VPS — all fine.
- **An OpenAI-compatible LLM endpoint** for extraction, rerank, and
  NLI judgement. Works with OpenAI itself, the
  [Vercel AI Gateway](https://vercel.com/ai-gateway) (recommended),
  [LM Studio](https://lmstudio.ai/) (all-local), Ollama, vLLM,
  Together, Groq, Mistral, etc.
- **A Bluesky service account** for signing labels — distinct from
  your personal account. See [docs/LIFECYCLE.md](./docs/LIFECYCLE.md).

You probably also want:

- **A Google Cloud API key** for the live Fact Check Tools lookup.
  Free at this volume, three `gcloud` commands.
- **Telegram bot creds** if you want
  Defer-to-human review on uncertain verdicts
  (`HITL_MODE=auto-telegram`).

---

## Quick start (Docker, recommended path)

```bash
# 1. Get the bulk ClaimReview feed
curl -L https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json \
  -o data.json

# 2. Configure
cp .env.example .env
$EDITOR .env   # at minimum: OPENAI_API_KEY, LABELER_HOSTNAME

# 3. One-off: import + embed
docker compose run --rm fact-labeler pnpm ingest
docker compose run --rm fact-labeler pnpm cli:lang-rebuild
docker compose run --rm fact-labeler pnpm cli:embed-rebuild

# 4. Start
docker compose up -d

# Liveness:  curl http://localhost:14831/healthz   →  ok
# Detail UI: http://localhost:14831/posts?uri=at://...
```

The published image is `ghcr.io/dracoblue/atproto-fact-labeler:latest`.
Going-live walkthrough (DNS, reverse proxy, persistent volumes,
PLC/Bluesky registration) in [docs/DEPLOY.md](./docs/DEPLOY.md) and
[docs/LIFECYCLE.md](./docs/LIFECYCLE.md).

For all-local / no-Docker setup, see [`pnpm` Quick start in
docs/DEPLOY.md § Bare-metal](./docs/DEPLOY.md).

---

## How a label gets emitted

```
post → extract atomic claim → retrieve candidates → rerank → NLI judge →
       aggregate → HITL → signed label
```

Each stage is a small file under `src/pipeline/`. The full architecture
including the polarity-flip logic ("the earth is *not* flat" inheriting
from `Earth is flat → False`), the same-language retrieval filter, and
the publisher-rating normaliser lives in
[docs/PIPELINE.md](./docs/PIPELINE.md). The research it was built on:
[docs/RESEARCH-MATCHING.md](./docs/RESEARCH-MATCHING.md).

What the labeler currently does **not** handle is documented with
evidence in [docs/KNOWN_LIMITATIONS.md](./docs/KNOWN_LIMITATIONS.md).
The regression contract is the 14-case fixture in
[`test/fixtures/matching-cases.json`](./test/fixtures/matching-cases.json);
`pnpm test:matching` reproduces every number cited in the docs.

---

## When does the labeler run?

Four trigger sources, freely combined. Defaults are conservative so a
single local LLM endpoint isn't overwhelmed:

| Trigger | Default | Source |
| --- | --- | --- |
| **Mentions** | on | A user `@mentions` the labeler. The parent / quoted post is fact-checked. |
| **Reports** | on | A Bluesky client calls `com.atproto.moderation.createReport` against the labeler. |
| **Watchlist** | off | The post's author DID is on an operator-curated list (politicians, repeat spreaders, …). |
| **Firehose** | off | Every Bluesky post. Realistic only with a high-throughput LLM endpoint. |

Per-trigger docs:
[mentions](./docs/TRIGGER_MENTIONS.md),
[reports](./docs/TRIGGER_REPORTS.md),
[watchlist](./docs/TRIGGER_WATCHLIST.md),
[firehose](./docs/TRIGGER_FIREHOSE.md).

---

## Public surface

- **`subscribeLabels` / `queryLabels`** — the on-wire atproto labeler
  endpoints. Signed records served by
  [`@skyware/labeler`](https://github.com/skyware-js/labeler).
- **`/posts?uri=at://…`** — a per-post detail page (HTML or
  `?format=json`) showing the verdict, the rationale, and every
  source with its publisher attribution and link.
- **`/healthz`** — liveness probe.
- **`com.atproto.moderation.createReport`** — when
  `TRIGGER_REPORTS=true`, the labeler accepts atproto-signed reports
  and dispatches them through the pipeline.
- **Optional: a Bluesky reply or quote-post on accepted verdicts.**
  Set `REPLY_TO_MENTIONS=true` for a threaded reply under mentions,
  `REPLY_TO_REPORTS=true` for a quote-post on the labeler's own feed
  embedding the reported post. The author's
  [postgate](https://docs.bsky.app/blog/postgate) is honoured.

---

## Configuration

Every knob lives in `src/config/index.ts` with a corresponding line
in [`.env.example`](./.env.example) — the env file is the canonical
reference, with the rationale for each non-obvious default written
out as a comment.

Key choices:
- **LLM endpoint** — `OPENAI_BASE_URL` + `OPENAI_API_KEY` +
  `OPENAI_MODEL`. Default is the Vercel AI Gateway. ADR with the
  benchmark and per-deployment-shape trade-offs:
  [docs/ADR_model_choices.md](./docs/ADR_model_choices.md).
- **Embedding endpoint** — same shape, separate `EMBEDDING_*` vars
  so an operator can serve embeddings locally and chat via Vercel.
- **HITL** — `stdin` (default, interactive), `telegram`,
  `auto` (unattended, decides per
  `HITL_AUTO_MIN_CONFIDENCE` / `HITL_AUTO_MIN_VOTES`),
  `auto-telegram` (auto-accept above the bar, push the rest to
  Telegram for manual review).
- **Live Fact Check API** — `FACTCHECK_API_KEY`. See
  [docs/FACTCHECK_API.md](./docs/FACTCHECK_API.md).

---

## Should I contribute?

Welcome. Areas where help is especially valuable:

- **Adding a publisher to the allowlist** —
  [`docs/FEED_QUALITY.md`](./docs/FEED_QUALITY.md) explains the
  editorial bar; use the [Publisher addition Issue
  template](./.github/ISSUE_TEMPLATE/publisher-add.yml) so reviewers
  can verify without back-and-forth.
- **Reply-language coverage** — currently English and German.
  Pattern is in `src/replier/format.ts`; a third locale is one
  translation file plus an enum widening.
- **PDS compatibility** — reports of running against Eurosky, a
  self-hosted PDS, or other major providers.
- **NLI / rerank prompt tuning** — `pnpm test:matching` is the
  regression harness.

[CONTRIBUTING.md](./CONTRIBUTING.md) covers the local setup, PR
conventions, and the scope of what gets accepted vs. declined.

Security reports go to the maintainer privately, **not** as public
GitHub Issues — see [SECURITY.md](./SECURITY.md).

---

## Further reading

- [docs/DEPLOY.md](./docs/DEPLOY.md) — production deploy walkthrough.
- [docs/LIFECYCLE.md](./docs/LIFECYCLE.md) — registering with
  Bluesky, pausing emissions, retiring labels, clearing the
  declaration.
- [docs/PIPELINE.md](./docs/PIPELINE.md) — Stage 1–4 architecture.
- [docs/KNOWN_LIMITATIONS.md](./docs/KNOWN_LIMITATIONS.md) — what
  the system measurably doesn't do yet, with evidence.
- [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) — offline dev,
  fixtures, smoke test, commit conventions.
- [docs/LICENSING.md](./docs/LICENSING.md) — what you may and may
  not do with the data the labeler ingests.

Built on
[`@skyware/labeler`](https://github.com/skyware-js/labeler).
