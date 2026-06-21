# Development

Mechanical reference for working in the codebase. Project policy
(what we accept, commit-message style, release process, where to
file issues) lives in [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

The matching architecture itself is in
[`pipeline/README.md`](./pipeline/README.md) and
[`research/matching.md`](./research/matching.md).

## Matching fixtures — `pnpm test:matching`

The polarity-matrix + regression test set referenced in
[`pipeline/README.md § Test gate`](./pipeline/README.md#test-gate)
lives at `test/fixtures/matching-cases.json`. Run it against your
locally-configured LLM + embedding endpoint:

```bash
pnpm test:matching
pnpm test:matching --filter earth        # only earth-shape cases
pnpm test:matching --filter polarity     # filter by category
pnpm test:matching --json > report.json  # machine-readable
```

Each case asserts `expected_verdict` and an optional
`min_confidence`. Exit code is non-zero on any failure. Wall-clock
is ~14 cases × ~1 min on M3 Max with qwen3.6-27b as NLI judge —
**not** part of the default `pnpm test` suite. Re-run before any
change to retrieval thresholds, NLI prompts, or the flip table.
Treat a regression here as a release blocker.

## Embedding index rebuild

The dense-retrieval stage needs every ClaimReview row in
`data/labeler.sqlite` to have a stored embedding before it can
return useful candidates:

```bash
pnpm cli:embed-rebuild              # only rows missing an embedding
pnpm cli:embed-rebuild --force      # re-embed every row
pnpm cli:embed-rebuild --limit 500  # smoke-test on a slice
```

The CLI is model-aware: rows tagged with a stale `embedding_model`
get re-embedded automatically. Throughput against LM Studio +
granite-278m on M3 Max is ~130 emb/s — a 92k-row corpus rebuild
takes ~12 min.

## Local development without internet

Run the pipeline offline against local fixture posts:

```bash
echo 'JETSTREAM_FIXTURE=fixtures/posts.jsonl' >> .env
pnpm run start
```

There is also a deterministic offline smoke test that bypasses the
LLM endpoint entirely (stubs the extraction with a known claim) and
proves the rest of the pipeline end-to-end:

```bash
pnpm tsx src/cli/smoke-test.ts
```

`fixtures/posts.jsonl` ships with five sample posts (German +
English), one JSON post per line.

## Watch mode

```bash
pnpm run test:watch
```

Unit tests cover the pure-function paths: rating normalisation,
polarity flip, embedding helpers, extraction-response parsing,
attribution shape, label-value regex compliance.
