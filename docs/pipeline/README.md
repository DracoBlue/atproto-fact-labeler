# Claim matching pipeline

How the labeler turns an incoming post into a verdict. Four stages,
all wired in code today, calibrated against the 14-case fixture in
[`test/fixtures/matching-cases.json`](../../test/fixtures/matching-cases.json).

Per-stage docs (what the code does + why this shape + research +
model choice + caveats):

- [`extract.md`](./extract.md) — Stage 1, LLM produces atomic falsifiable claims with decontextualised standalone text
- [`retrieve.md`](./retrieve.md) — Stage 2, dense cosine top-K
- [`rerank.md`](./rerank.md) — Stage 3, LLM relevance judge
- [`nli-judge.md`](./nli-judge.md) — Stage 4, LLM entail/contradict/neutral + polarity flip rationale
- [`aggregate.md`](./aggregate.md) — Stage 5, verdict aggregation
- [`language-detection.md`](./language-detection.md) — cross-cutting same-language filter

Why this matching architecture exists in this shape (vs alternatives
that were considered and rejected):
[`../adr/pipeline-three-stage-matching.md`](../adr/pipeline-three-stage-matching.md).

## Architecture

```
   post text
        │
        ▼
   ┌──────────────────────────────────┐
   │ STAGE 1 — Claim extraction       │
   │   LLM produces atomic falsifiable│
   │   claims + decontextualised text │
   └──────────────┬───────────────────┘
                  │
                  ▼
   ┌──────────────────────────────────┐
   │ STAGE 2 — Dense retrieval        │
   │   granite-278m multilingual      │
   │   cosine top-K from index        │
   │   same-language filter           │
   └──────────────┬───────────────────┘
                  │
                  ▼
   ┌──────────────────────────────────┐
   │ STAGE 3 — LLM relevance rerank   │
   │   single batched LLM call        │
   │   keeps top-K above threshold    │
   └──────────────┬───────────────────┘
                  │
                  ▼
   ┌──────────────────────────────────┐
   │ STAGE 4 — NLI polarity gate      │
   │   LLM-as-judge, 3-class          │
   │   entail / contradict / neutral  │
   └──────────────┬───────────────────┘
                  │
        ┌─────────┼─────────┐
        │         │         │
        ▼         ▼         ▼
   entailment  contradict  neutral
        │         │         │
        │ pass    │ flip    │ ignore
        │through  │verdict  │
        ▼         ▼         ▼
   ┌──────────────────────────────────┐
   │ STAGE 5 — Aggregate              │
   │   only over entail + flipped     │
   │   contradict matches             │
   │   if none → uncovered            │
   └──────────────────────────────────┘
```

## What runs in code today

All stages share one OpenAI-compatible endpoint (LM Studio locally,
the configured provider in production). No Python, no training, no
dedicated NLI model.

| Stage | File | Model role |
|---|---|---|
| 1 | `src/pipeline/extract.ts` | LLM produces atomic + falsifiable + decontextualised claims; strict JSON schema |
| 2 | `src/pipeline/retrieve.ts` | granite-278m-multilingual embeddings, cosine over `claim_review.embedding` BLOB |
| 3 | `src/pipeline/rerank.ts` | one batched LLM call rates top-K candidates 0..1 |
| 4 | `src/pipeline/entail.ts` | LLM-as-judge per surviving candidate; strict-JSON-Schema |
| 5 | `src/pipeline/matching.ts` | polarity-aware aggregate, returns null → `uncovered` |

`src/embedding/client.ts` forces `encoding_format: 'float'` to work
around the LM Studio + openai-node base64 incompatibility.

## Research backing

The pipeline shape mirrors the operational framings of Meedan
(Alegre + Check) and Full Fact (`t(v) = t(u)`), and follows the
FACT-GPT / FEVEROUS / AVeriTeC literature for the rerank + NLI
stages. Full citations + the side-by-side comparison live in
[`../research/matching.md`](../research/matching.md).

## Test gate

The labelled fixture lives at
[`test/fixtures/matching-cases.json`](../../test/fixtures/matching-cases.json) —
14 cases grouped into six categories:

- **`polarity-matrix`** — earth round/flat × is/isn't (4 cases).
  Property: *true claims and their negations get opposite verdicts*.
- **`classic-conspiracy`** — Vaccines+microchips, 5G+COVID. Property:
  publishers' false ratings pass through via entailment.
- **`true-supported`** — "COVID vaccines are safe and effective".
  Property: contradiction-flip recovers true from false-rated
  anti-vax reviews.
- **`temporal-entity`** — Trump-vs-Biden 2020. Property: Stage 4 NLI
  correctly disambiguates same-topic claims with different truth
  values.
- **`publisher-uncertainty`** — Bill Gates microchip implants.
  Property: when publishers themselves are uncertain, the system does
  not over-commit (verdict = `unknown`).
- **`uncovered`** — my dog, Mick Jagger (vs Mugabe / Jackie Chan
  death hoaxes), German unemployment (vs Italian unemployment).
  Property: high-cosine topical neighbours with *different* entities
  or numbers must drop as `neutral`, not flow through as `entailment`.

```bash
pnpm test:matching                       # full set
pnpm test:matching --filter polarity     # by category
pnpm test:matching --filter uncovered    # by category
pnpm test:matching --json > report.json  # machine-readable
```

**Not** part of `pnpm test` — needs LM Studio running, a populated
index, and ~15 min wall-clock for the full set on M3 Max. Treat a
regression here as a release blocker.

Each case asserts `expected_verdict` (one of `true | false | mixed |
unknown | disputed | outdated | uncovered`) and optionally
`min_confidence`. Add a case whenever a new failure mode is
identified in production. The fixture is small and curated; adding
noise weakens the gate. If a real-world post produces a wrong label,
the fix lands in two parts: (a) the pipeline change, (b) the case
that proves it stays fixed.

## What the pipeline deliberately does NOT do

- **Does not invent verdicts when no fact-check matches.** Out of
  scope. Non-matching posts are `uncovered`. The labeler routes
  existing fact-checks; it does not produce new ones.
- **Does not try to be perfect on contradiction detection.** F1 ~0.46
  is the published ceiling for unsupervised NLI. We accept some
  contradictions getting classified as `neutral` and silently
  abstaining. Abstain is safe; flip is consequential; never-flip is
  wrong.
- **Does not change the trigger or reply surfaces.** All mentions /
  reports / watchlist / firehose handling is unchanged; only the
  matching engine sits at this level.

## Open questions

1. **Concrete cosine and reranker thresholds.** Papers tune per
   dataset. We calibrate `RERANK_THRESHOLD` on the fixture above.
2. **Cross-lingual NLI** — closing the cases where the only matching
   fact-check is in a different language than the post. See
   [`language-detection.md`](./language-detection.md) for the current
   trade-off.

## Future extensions

The shipped pipeline is the **minimum sensible first version**. The
list below is what we would add next, in rough order of
impact-per-effort, if volume or precision needs grow.

### 1. Dedicated cross-encoder reranker (Stage 3)

Today Stage 3 is an LLM call (~5–8 s on qwen3-27B for a batched rate
of 10 candidates). A dedicated `BAAI/bge-reranker-v2-m3` in-process
would do the same in ~50 ms. The LLM-judge equivalence holds while
volume is low; at firehose scale this becomes the bottleneck.

### 2. Dedicated NLI model fast path

`MoritzLaurer/mDeBERTa-v3-base-mnli-xnli` runs the same 3-class
entailment in ~30 ms via Transformers.js — ~100× speedup vs the
LLM-judge. The trade-off is world-knowledge: mDeBERTa correctly
handles direct negation pairs but fails on meta-claims like *"Hindu
mythology *portrayed* the earth as spherical"* vs *"the earth is
round"* — qwen3 gets this right (see [`nli-judge.md`](./nli-judge.md)
§ Hindu mythology case).

Realistic compromise: use mDeBERTa as the fast path, **escalate to
LLM-judge only when mDeBERTa is uncertain** (confidence < 0.7).
`NLI_MODE=dedicated` is the env knob already reserved for this.

### 3. AVeriTeC-style fallback for `uncovered` claims

Today, posts with no entailment- or contradiction-class match return
`uncovered`. That's the safe failure mode, but a labeler that *only*
labels what's already in someone else's fact-check database can
never address novel claims.

Add an extra stage that runs retrieval-augmented LLM verification when
Stage 4 returns null: web-search for evidence, prompt qwen3 with
gathered snippets, ask for a verdict + supporting URLs. Mark the
resulting verdict as `verifier_kind='rag-llm'` (different from
`feed`) so operators can tune trust separately.

This is a much bigger commitment — moving from "claim matcher" to
"claim verifier" — and worth a separate design doc.

### 4. Threshold calibration

`MIN_COSINE` is currently 0.55 (low, by design). `RERANK_THRESHOLD`
and NLI confidence floors are not exposed. Sweep against the fixture;
pick the operating point that maximises the polarity-matrix
property. Wire as a CI gate so future pipeline changes can't regress.

### 5. Index-build performance

`pnpm cli:embed-rebuild` currently does ~75–130 emb/s against LM
Studio (~12–20 min for 92k rows). Possible speedups: parallel batches
against multiple LM Studio instances; in-process Transformers.js to
drop HTTP overhead; `sqlite-vec` once the corpus crosses ~500k rows.

### 6. Multi-language extraction prompt

Extraction currently uses a single English prompt. Posts in DE/FR/ES
still work because qwen3 is multilingual, but a per-language prompt
would likely improve atomic claim quality on non-English content.
