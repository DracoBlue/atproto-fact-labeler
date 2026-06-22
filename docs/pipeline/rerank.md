# Stage 3 — Relevance rerank

**Code**: [`src/pipeline/rerank.ts`](../../src/pipeline/rerank.ts).
**Purpose**: ask the simpler question *"is this candidate even on-topic?"*
before paying the per-pair NLI cost in Stage 4.

## Why a reranker

Bi-encoder retrieval (Stage 2) maps claim and candidate into the same
vector space *independently*. That's fast but loses pairwise
interaction. A cross-encoder takes both texts together and reads them
jointly, which is materially more accurate at small k.

> SK_DU at FEVER 2024 measured Hu-METEOR top-10:
> Cross-Encoder **0.1913** > Bi-Encoder 0.1787 > BM25 0.1452.
> ([SK_DU paper](https://aclanthology.org/2024.fever-1.11.pdf))

## Implementation — LLM-as-relevance-judge

One **single batched call** rates every retrieved candidate 0..1
against the user's claim in one round-trip. We keep the top
`RERANK_KEEP` (default 5) whose score ≥ `RERANK_THRESHOLD` (default
0.5) and discard the rest before Stage 4 NLI runs.

The rerank prompt asks a much simpler question than NLI does — just
"is this candidate even on-topic?". The model returns a strict
JSON-schema response with one `{idx, score}` per candidate. On parse
failure the stage degrades to a no-op (passes the top `keep` Stage 2
results through with `rerankScore = cosine`), so a transient LLM
hiccup never loses the pipeline.

Reranking shares the same `OPENAI_MODEL` as extract and NLI. Why
LLM-as-judge rather than a dedicated cross-encoder like
`bge-reranker-v2-m3`:
[`../adr/nli-judge-llm-not-mdeberta.md`](../adr/nli-judge-llm-not-mdeberta.md)
(same ONNX-ergonomics decision, same trade-off).

## Measured impact

`pnpm test:matching` on M3 Max, qwen3.6-27B:

| Case | Before rerank | After rerank | Delta |
|---|---|---|---|
| the earth is round | 45 s | 33 s | −27 % |
| My dog is brown (uncovered) | 34 s | 11 s | **−66 %** — Stage 3 drops all candidates, Stage 4 never runs |
| (full 14-case fixture) | 826 s | see [`README.md` § Test gate](./README.md#test-gate) | — |

The big uncovered-case wins come from Stage 3 zeroing out every
candidate — Stage 4 sees an empty list and `uncovered` is returned
without paying for any NLI calls.

## Failure mode handled here

**If 0 candidates pass `RERANK_THRESHOLD` → label is `uncovered`.**
No aggregation, no fallback to lower-quality matches. The "no
quality gate before aggregation" failure mode of the prior FTS
pipeline is documented in
[`../adr/pipeline-three-stage-matching.md`](../adr/pipeline-three-stage-matching.md).
