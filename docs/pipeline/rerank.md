# Stage 2 — Relevance rerank

**Code**: [`src/pipeline/rerank.ts`](../../src/pipeline/rerank.ts).
**Purpose**: ask the simpler question *"is this candidate even on-topic?"*
before paying the per-pair NLI cost in Stage 3.

## Why a reranker

Bi-encoder retrieval (Stage 1) maps claim and candidate into the same
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
0.5) and discard the rest before Stage 3 NLI runs.

The rerank prompt asks a much simpler question than NLI does — just
"is this candidate even on-topic?". The model returns a strict
JSON-schema response with one `{idx, score}` per candidate. On parse
failure the stage degrades to a no-op (passes the top `keep` Stage 1
results through with `rerankScore = cosine`), so a transient LLM
hiccup never loses the pipeline.

## Why LLM-as-judge instead of `bge-reranker-v2-m3`

Same ONNX ergonomics concern documented in
[`nli-judge.md`](./nli-judge.md). The reranker LLM call is currently
not the bottleneck (NLI dominates), and using the same OpenAI-compatible
endpoint as extract / NLI keeps the deployment to "one LM Studio
instance, no Python." Worth revisiting if Stage 2 itself becomes the
bottleneck.

## Measured impact

`pnpm test:matching` on M3 Max, qwen3.6-27B:

| Case | Before rerank | After rerank | Delta |
|---|---|---|---|
| the earth is round | 45 s | 33 s | −27 % |
| My dog is brown (uncovered) | 34 s | 11 s | **−66 %** — Stage 2 drops all candidates, Stage 3 never runs |
| (full 13-case fixture) | 826 s | see [`README.md` § Test gate](./README.md#test-gate) | — |

The big uncovered-case wins come from Stage 2 zeroing out every
candidate — Stage 3 sees an empty list and `uncovered` is returned
without paying for any NLI calls.

## Failure mode handled here

**If 0 candidates pass `RERANK_THRESHOLD` → label is `uncovered`.**
No aggregation, no fallback to lower-quality matches. This is the
principled answer to failure mode B in the
[`README.md`](./README.md#why-this-shape-and-not-the-old-fts-pass-through)
— no quality gate before aggregation.
