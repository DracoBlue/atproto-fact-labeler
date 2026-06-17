# Development

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

Unit tests cover the pure-function paths: rating normalisation, lookup
tokenisation, extraction-response parsing, attribution shape, label-value
regex compliance.

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
├── pipeline/
│   ├── extract.ts           S1  OpenAI-compatible LLM extraction
│   ├── lookup.ts            S2  FTS5 over ClaimReview index
│   ├── normalise-rating.ts  S3  publisher rating → internal verdict
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
