# Development

For the matching architecture itself see [PIPELINE.md](./PIPELINE.md) and
its companion [RESEARCH-MATCHING.md](./RESEARCH-MATCHING.md). This file
covers the dev workflow only.

## Matching fixtures — `pnpm test:matching`

The polarity-matrix + regression test set referenced in
[PIPELINE.md § Test-set / CI gate](./PIPELINE.md#test-set--ci-gate)
lives at `test/fixtures/matching-cases.json`. Run it against your
locally-configured LLM + embedding endpoint:

```bash
pnpm test:matching
pnpm test:matching --filter earth        # only earth-shape cases
pnpm test:matching --filter polarity     # filter by category
pnpm test:matching --json > report.json  # machine-readable
```

Each case asserts `expected_verdict` and an optional `min_confidence`.
Exit code is non-zero on any failure. Wall-clock is ~13 cases × ~1 min on
M3 Max with qwen3.6-27b as NLI judge — **not** part of the default
`pnpm test` suite. Re-run before any change to retrieval thresholds, NLI
prompts, or the flip table. Treat a regression here as a release blocker.

## Embedding index rebuild

The dense-retrieval stage needs every ClaimReview row in `data/labeler.sqlite`
to have a stored embedding before it can return useful candidates. After
a fresh ingest (or after changing `EMBEDDING_MODEL`):

```bash
pnpm cli:embed-rebuild              # only rows missing an embedding
pnpm cli:embed-rebuild --force      # re-embed every row
pnpm cli:embed-rebuild --limit 500  # smoke-test on a slice
```

The CLI is model-aware: rows tagged with a stale `embedding_model` are
re-embedded automatically. Throughput against LM Studio + granite-278m on
M3 Max is ~130 emb/s — a 92k-row corpus rebuild takes ~12 min.

## Local development without internet

To run the pipeline offline against local fixture posts:

```bash
echo 'JETSTREAM_FIXTURE=fixtures/posts.jsonl' >> .env
pnpm run start
```

There is also a deterministic offline smoke test that bypasses the LLM
endpoint entirely (stubs the extraction with a known claim) and proves the
rest of the pipeline end-to-end:

```bash
pnpm tsx src/cli/smoke-test.ts
```

The fixture file has one JSON post per line. `fixtures/posts.jsonl` ships
with five sample posts (German + English).

## Tests

```bash
pnpm test              # one shot
pnpm run test:watch    # watch mode
pnpm run typecheck     # tsc --noEmit
```

Unit tests cover the pure-function paths: rating normalisation, polarity
flip, embedding helpers, extraction-response parsing, attribution shape,
label-value regex compliance.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/).
Releases (version bump, changelog, Docker image push to GHCR) are driven by
[release-please](https://github.com/googleapis/release-please) based on
commit messages on `main`:

- `feat: …` → minor version bump
- `fix: …` → patch version bump
- `feat!: …` or `BREAKING CHANGE:` footer → major version bump
- `chore: …`, `docs: …`, `refactor: …`, `test: …`, `ci: …` → no version bump

release-please opens a Release PR on `main` that collects pending changes.
Merging that PR creates the tag and triggers the Docker publish job.

## Source layout

```
src/
├── config/                env + zod validation
├── store/                 SQLite + schema migrations
├── ingest/
│   ├── claimreview-feed.ts  Google Data Commons → SQLite
│   ├── jetstream.ts         live atproto firehose (JSON)
│   └── fixture.ts           local JSONL replay for tests/dev
├── embedding/
│   └── client.ts            OpenAI-compatible /v1/embeddings client
├── pipeline/
│   ├── extract.ts           S1  OpenAI-compatible LLM extraction
│   ├── retrieve.ts          S2  dense embedding cosine top-K
│   ├── entail.ts            S3  NLI polarity gate (LLM-judge)
│   ├── matching.ts          S4  drop neutral, flip on contradiction, aggregate
│   ├── normalise-rating.ts      publisher rating → internal verdict
│   └── orchestrator.ts      glue S0 → S5
├── hitl/
│   ├── stdin.ts             terminal HITL
│   ├── telegram.ts          grammy bot
│   ├── auto.ts              policy-only HITL
│   └── format.ts            proposal renderers
├── labels/
│   ├── server.ts            @skyware/labeler wrapper + key gen
│   └── vocabulary.ts        verdict → fact-* label value
├── detail/
│   └── server.ts            per-post HTTP "why?" page
└── index.ts                 main entrypoint
test/                        vitest unit tests
fixtures/posts.jsonl         sample posts for offline dev
```
