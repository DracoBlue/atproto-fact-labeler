# ADR: Stage 3 NLI stays as LLM-as-judge, not a dedicated mDeBERTa head

**Status**: accepted · 2026-06-17

**Context**

[`PIPELINE.md`](./PIPELINE.md) § Future extensions named a dedicated NLI
model — specifically `MoritzLaurer/mDeBERTa-v3-base-mnli-xnli` — as the
canonical next step to replace the qwen3.6-27B LLM-as-judge in Stage 3.
The motivation was latency: each NLI judgement on qwen3 takes 4–9 s,
which dominates the ~1 min wall-clock per `pnpm cli:label` call. A
dedicated mDeBERTa cross-encoder claims ~30 ms per pair via ONNX in
[Transformers.js](https://huggingface.co/docs/transformers.js) — a
~100× speedup on paper.

The labeler exists *because* the FTS pipeline could not handle polarity
("the earth is not flat" → `fact-refuted`). The hard requirement on any
Stage 3 swap is therefore: **the polarity-matrix fixture in
[`test/fixtures/matching-cases.json`](../test/fixtures/matching-cases.json)
must remain 13/13 green.**

**Decision**

Keep `NLI_MODE=llm-judge` (qwen3.6-27B or equivalent OPENAI_MODEL) as
the **only** supported NLI backend for the foreseeable future. Reserve
the env var slot for future replacements but do not implement
`NLI_MODE=dedicated`.

**Evidence**

Direct ONNX-runtime probe via `@huggingface/transformers@4.2.0` on
M3 Max, 2026-06-17. Sentence-pair tokenisation verified via
`input_ids` + `token_type_ids` inspection: `[CLS] premise [SEP]
hypothesis [SEP]` is correctly produced with `token_type_ids` segments
0 and 1.

Six adversarial pairs probed against three candidate models. Results:

| Pair | Expected | mDeBERTa-base (fp32) | mDeBERTa-base (q8) | nli-deberta-v3-xsmall |
| --- | --- | --- | --- | --- |
| "earth is flat" → "earth is round" | contradiction | **entailment 0.98** ❌ | **entailment 0.85** ❌ | **entailment 0.68** ❌ |
| "Biden 2020" → "Trump 2016" | neutral | contradiction 0.99 ❌ | contradiction 0.79 ❌ | neutral 0.51 ✓ |
| "vaccines microchips" → "vaccines do NOT" | contradiction | contradiction 1.00 ✓ | contradiction 1.00 ✓ | contradiction 1.00 ✓ |
| "Hindu mythology *portrayed* earth spherical" → "earth round" | neutral | entailment 0.96 ❌ | neutral 0.73 ✓ | entailment 0.81 ❌ |
| "5G causes COVID" → "5G technology causes COVID-19" | entailment | neutral 0.97 ❌ | neutral 0.97 ❌ | entailment 0.82 ✓ |
| "earth round" → "NASA confirms earth spherical" | entailment | neutral 1.00 ❌ | neutral 1.00 ❌ | neutral 1.00 ❌ |
| **Pass rate** | | **2 / 6** | **3 / 6** | **3 / 6** |

For comparison: qwen3.6-27B as LLM-as-judge on the same six pairs hit
**6 / 6** correct (smoke test in earlier session). On the full
13-case fixture in `pnpm test:matching`: **13 / 13** correct, including
all four polarity-matrix cases.

The systematic failure mode is the literature-documented one. As
captured in [`RESEARCH-MATCHING.md`](./RESEARCH-MATCHING.md) § FACT-GPT:
contradiction-class F1 on small / base NLI models is around 0.46 versus
0.83 on entailment, even with fine-tuning. The probe data is concrete
evidence of that gap in our setup, not a tokeniser or quantisation
mistake.

**Consequences**

- **Polarity safety preserved.** The polarity-matrix test set stays the
  binding correctness gate; we do not ship a Stage 3 that would
  silently relabel "the earth is not flat" as `fact-refuted`.
- **Latency remains qwen3-bound.** Per-claim wall-clock stays ~1 min on
  M3 Max; firehose mode is impractical without further work. The
  documented mitigation is **Stage 2 cross-encoder rerank** — it cuts
  Stage 3 input from top-10 to top-5 and roughly halves NLI cost. That
  work is decoupled from this ADR and tracked separately as a Stage 2
  implementation task.
- **`NLI_MODE=dedicated` is now load-bearing as a deliberate
  not-implemented sentinel.** `src/pipeline/entail.ts` throws if
  someone enables it. Anyone wanting to revisit this ADR must (a) find
  an NLI model whose Transformers.js ONNX export passes the 13-case
  fixture, (b) prove it on `pnpm test:matching`, (c) update or
  supersede this ADR with the new evidence.
- **Future revisit triggers.** Reconsider when one of:
  - A multilingual NLI model with ≥ 0.7 contradiction F1 on adversarial
    pairs ships an ONNX-compatible release (e.g., `mDeBERTa-v3-large`
    fine-tuned for adversarial NLI).
  - Hybrid NLI (small model as cheap pre-filter + LLM judge on
    uncertain cases) becomes worth the engineering — currently the
    polarity-matrix cases dominate wall-clock, so a pre-filter cannot
    skip the expensive path.
  - qwen3-class models become cheap enough on local hardware that the
    1-minute latency stops being a complaint.

**Alternatives considered**

- **mDeBERTa as Stage 3-only judge** — rejected by this ADR.
- **mDeBERTa as Stage 2 cheap pre-filter, qwen3 as Stage 3 judge** —
  considered, deferred. The pre-filter only helps the uncovered class
  (where all candidates are neutral); the polarity-matrix cases still
  pay full qwen3 cost. Net latency saving on the full fixture is
  modest (~30 % on the easy cases, ~0 % on the hard ones). Worth doing
  only after a proper Stage 2 reranker is in place.
- **Larger ONNX NLI models** (DeBERTa-v3-large, RoBERTa-large-mnli) —
  the Xenova mirrors examined had broken `tokenizer_config.json` files
  in Transformers.js v4. Could be fixed, but the cost-benefit only
  improves marginally vs. the LLM-as-judge baseline once you account
  for ~1.4 GB model files and ~100 ms per pair runtime.
- **Server-side NLI sidecar** (HuggingFace text-embeddings-inference) —
  adds operational complexity. Not justified until LLM-as-judge cost
  becomes the actual production bottleneck rather than an optimisation
  opportunity.
