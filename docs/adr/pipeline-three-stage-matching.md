# ADR: Three-stage matching (dense retrieve + rerank + NLI) instead of FTS pass-through

**Status**: accepted · 2026-06-15 · supersedes the original FTS-only
matching design.

## Context

The first matching implementation was a single SQLite FTS5 `OR`-query
over the ClaimReview table that aggregated the top-5 publisher native
ratings. Two real Bluesky posts walked it into the classic failure
modes:

| Post | Truth | Labeler verdict | What actually happened |
|---|---|---|---|
| "the earth is not flat" | true | `fact-refuted` (conf 0.879) | FTS matched 5 unrelated false-claim articles via `earth*` or `flat*` prefix; aggregator passed through 5× "False". |
| "the earth is round" | true | `fact-refuted` (conf 1.0) | FTS matched articles about Japan earthquakes, AOC tweets, COVID stimulus — none about Earth shape; aggregator returned conf 1.0 anyway. |

Three failure modes were baked into that design:

1. **Single-stage keyword retrieval.** `earth* OR round*` matches every
   document containing either prefix. Cross-stem hits (e.g.
   "Earth**quake**") flood the result set on common words.
2. **No quality gate before aggregation.** Top-k was taken regardless
   of relevance score. If the top-k were all spurious, aggregation
   still produced "5/5 publishers say False, confidence 1.0."
3. **Publisher-verdict pass-through ignored polarity.** A fact-check
   that refutes "earth is flat" gets normalised to `false`. We then
   applied that to "earth is not flat" — the *negation* — without
   flipping. Verdict was double-wrong.

## Decision

Three-stage matching: dense retrieve → LLM relevance rerank → NLI
polarity gate, followed by polarity-aware aggregation.

- Dense retrieval kills keyword-stem false positives (failure mode 1).
- A relevance gate before aggregation kills "all candidates spurious
  but confident" (failure mode 2).
- NLI polarity classification kills the negation problem (failure
  mode 3).

The architecture is documented stage-by-stage at
[`pipeline/`](../pipeline/README.md). The literature consensus
(Meedan Alegre, Full Fact's `t(v) = t(u)`, FEVER 2024 cross-encoder
benchmarks, FACT-GPT polarity-aware NLI) endorses this shape.

## Consequences

- The matching test fixture
  ([`test/fixtures/matching-cases.json`](../../test/fixtures/matching-cases.json))
  was built around the three failure modes above as
  `polarity-matrix`, `uncovered-*`, and `temporal-entity` categories.
  Treat regressions on these as release blockers.
- The deployment shape constrained Stage 3 (rerank) and Stage 4 (NLI)
  to LLM-as-judge rather than dedicated cross-encoders, captured in
  [`pipeline/nli-judge.md` § Why an LLM judge, not a dedicated mDeBERTa head`](../pipeline/nli-judge.md#why-an-llm-judge-not-a-dedicated-mdeberta-head).
  Those sub-decisions can be revisited independently.
- Per-claim wall-clock went from ~0.3 s (FTS) to ~25 s (qwen3 LLM
  judge × top-K). The latency budget is now LLM-bound. Mitigation
  options listed in
  [`pipeline/README.md` § Future extensions](../pipeline/README.md#future-extensions).
