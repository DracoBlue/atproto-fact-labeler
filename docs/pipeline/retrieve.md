# Stage 1 — Dense retrieval

**Code**: [`src/pipeline/retrieve.ts`](../../src/pipeline/retrieve.ts).
**Purpose**: pull up to top-K semantically similar ClaimReview entries
for a given claim, using whole-claim cosine similarity over
pre-computed multilingual embeddings.

**Output**: top-K candidates (default 10) sorted by cosine.
`MIN_COSINE` floor 0.55 deliberately *low* — empirical measurement
showed legitimate Earth-spherical fact-checks at 0.70 and the worst
unrelated false-positives at 0.84 (Trump-2016 confused with Trump-2020).
A single cosine threshold cannot separate the two; Stage 3 NLI does.

## Same-language filter

The query filters `claim_review.lang = ? OR lang IS NULL`. Cross-lingual
NLI judges flip polarity more often than they should — same-language
candidates produce markedly more reliable verdicts. Untagged rows
(`lang IS NULL`) stay reachable from every language so they aren't
silently lost when the detector can't make a confident call. Full
detection pipeline and operator rebuild flow:
[`language-detection.md`](./language-detection.md).

## Embedding model

Deployed:
[`text-embedding-granite-embedding-278m-multilingual`](https://huggingface.co/ibm-granite/granite-embedding-278m-multilingual)
— IBM Granite, Apache-2.0, 303 MB, 768 dims, multilingual primary focus.
Picked over BGE-M3 / Multilingual-E5-Large for three reasons measured
on the fixture:

1. Ships with LM Studio (`text-embedding-granite-embedding-278m-multilingual`)
   — no separate runtime needed.
2. **Crosslingual EN↔DE works**: "the earth is round" vs.
   "Die Erde ist keine Scheibe" cosine 0.81 (vs 0.52 for
   `mxbai-large-v1` which is en-centric).
3. **75 emb/s** on M3 Max — 92k corpus rebuild in ~20 min on
   `pnpm cli:embed-rebuild`.

Alternatives if Granite isn't installed locally:

- [`BAAI/bge-m3`](https://huggingface.co/BAAI/bge-m3) — 568 MB,
  1024 dims, same multilingual property; needs Transformers.js or
  an Infinity server.
- [`intfloat/multilingual-e5-large`](https://huggingface.co/intfloat/multilingual-e5-large)
  — Success@10 = 0.87, MAP = 0.75 on AMC-16K
  ([Pikuliak et al. 2024](https://arxiv.org/html/2503.02737)).

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
| true negation (must reach Stage 3) | 0.721 | 0.853 | 0.935 |
| unrelated | 0.417 | 0.595 | **0.840** |

The max-unrelated **exceeds** the min-match. The "Trump won 2020"
vs. "Trump won 2016" pair scores cosine 0.84 — embedding sees same
entity + same action + same domain, different year. Truth-condition-wise
these are independent propositions. **Only NLI can disambiguate** —
which is the research finding (Full Fact `t(v) = t(u)`) made concrete
in our data.
