# Stage 2 — Dense retrieval

**Code**: [`src/pipeline/retrieve.ts`](../../src/pipeline/retrieve.ts).
**Purpose**: pull up to top-K semantically similar ClaimReview entries
for a given claim, using whole-claim cosine similarity over
pre-computed multilingual embeddings.

**Output**: top-K candidates (default 10) sorted by cosine.
`MIN_COSINE` floor 0.55 deliberately *low* — empirical measurement
showed legitimate Earth-spherical fact-checks at 0.70 and the worst
unrelated false-positives at 0.84 (Trump-2016 confused with Trump-2020).
A single cosine threshold cannot separate the two; Stage 4 NLI does.

## Same-language filter

The query filters `claim_review.lang = ? OR lang IS NULL`. Cross-lingual
NLI judges flip polarity more often than they should — same-language
candidates produce markedly more reliable verdicts. Untagged rows
(`lang IS NULL`) stay reachable from every language so they aren't
silently lost when the detector can't make a confident call. Full
detection pipeline and operator rebuild flow:
[`language-detection.md`](./language-detection.md).

## Embedding model

Default:
[`text-embedding-granite-embedding-278m-multilingual`](https://huggingface.co/ibm-granite/granite-embedding-278m-multilingual)
— 303 MB, 768 dims, Apache-2.0. Configurable via `EMBEDDING_MODEL`
plus an OpenAI-compatible `/v1/embeddings` endpoint at
`EMBEDDING_BASE_URL`. The selection rationale, alternatives, and
head-to-head measurement live in
[`../adr/model-choices.md`](../adr/model-choices.md).

## Storage

Pre-compute one dense vector per `claim_review` row (currently 88k+).
At 768 dimensions × float32 that's ~270 MB total. Persisted as raw
float32 BLOBs in three columns on the existing `claim_review` table:

- `embedding BLOB`
- `embedding_dim INTEGER`
- `embedding_model TEXT`

No `sqlite-vec` dep needed; the scan is in-process and a single
linear pass takes ~10 ms for the whole corpus on M3 Max.

`pnpm cli:embed-rebuild` backfills embeddings, is model-aware
(re-embeds rows tagged with an outdated `embedding_model`), and is
the right CLI to run after a model swap or a fresh ingest.

## Why a single cosine threshold doesn't work

Measured on the calibration set
([`../RESEARCH-MATCHING.md`](../RESEARCH-MATCHING.md)):

| Class | min | median | max |
|---|---|---|---|
| legitimate match | 0.696 | 0.778 | 0.856 |
| true negation (must reach Stage 4) | 0.721 | 0.853 | 0.935 |
| unrelated | 0.417 | 0.595 | **0.840** |

The max-unrelated **exceeds** the min-match. The "Trump won 2020"
vs. "Trump won 2016" pair scores cosine 0.84 — embedding sees same
entity + same action + same domain, different year. Truth-condition-wise
these are independent propositions. **Only NLI can disambiguate** —
which is the research finding (Full Fact `t(v) = t(u)`) made concrete
in our data.
