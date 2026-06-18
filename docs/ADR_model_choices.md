# ADR: Model choices — local vs. Vercel AI Gateway

**Status**: accepted · 2026-06-18

**Context**

The pipeline has three OpenAI-compatible model slots:

1. **`OPENAI_MODEL`** — extraction (S1), reranker (S2), NLI judge (S3).
   All three currently share the same model; see
   [`ADR_nli_llm_judge_over_mdeberta.md`](./ADR_nli_llm_judge_over_mdeberta.md)
   for why we did not split NLI off.
2. **`EMBEDDING_MODEL`** — dense retrieval (S1).
3. Optional separate base-URL + key per slot, so embedding can live on
   a different server from the LLM (e.g. local LM Studio for embeddings
   + Vercel for the LLM).

[`test/fixtures/matching-cases.json`](../test/fixtures/matching-cases.json)
is the binding correctness gate: the 13-case fixture must remain green
on whichever model the operator picks. Each model swap we evaluate is
benchmarked against it.

This ADR records the picks and the alternatives we evaluated.

**Decision**

| Slot | Default | Endpoint | Why |
| --- | --- | --- | --- |
| **Embedding (S1) — recommended** | `text-embedding-granite-embedding-278m-multilingual` | local LM Studio | EN↔DE crosslingual cosine 0.81, 768 dim, ships with LM Studio, ~13 ms / query, no external dep |
| **Embedding (S1) — pure-Vercel alternative** | `google/text-multilingual-embedding-002` | Vercel AI Gateway | EN↔DE crosslingual cosine 0.75, 768 dim, $0.025/M tokens. Trades −7 % retrieval quality for an LM-Studio-free deploy. |
| **LLM — local default** | `qwen3.6-27b` | local LM Studio | 13/13 fixture pass, fully offline, reliable strict json_schema, ~62s/case |
| **LLM — Vercel default** | `google/gemini-2.5-flash` | Vercel AI Gateway | 13/13 fixture pass, 2.6× faster than local qwen3, cheap, fixture-exact |

Two valid deployment shapes:

- **All-local / offline** → `qwen3.6-27b` + granite, both on LM Studio.
- **Hybrid (recommended for Coolify-style hosts)** →
  `google/gemini-2.5-flash` on Vercel + granite on local LM Studio.
  Best retrieval quality, LLM cost-controlled.
- **Pure-Vercel (no LM Studio process at all)** →
  `google/gemini-2.5-flash` + `google/text-multilingual-embedding-002`,
  both on Vercel. Slightly worse retrieval (−7 % crosslingual), but
  zero local-process dependency.

The embedding crosslingual penalty in pure-Vercel mode is accepted on
the basis that **Stage 2 (rerank) and Stage 3 (NLI) are the real quality
gates** — they filter retrieved candidates aggressively, so a moderate
Stage 1 quality drop does not propagate to the final verdict. The
matching pipeline was specifically designed so retrieval is allowed to
be permissive.

**Evidence**

Full 13-case fixture (`pnpm test:matching`) on M3 Max, 2026-06-17/18.
LM Studio + qwen3.6-27b is the reference run.

| Model | Endpoint | Score | Wall-clock | Median/case | Notes |
| --- | --- | --- | --- | --- | --- |
| `qwen3.6-27b` | LM Studio (local) | **13/13** | 826 s | ~62 s | Reference. Cost: electricity only. |
| `google/gemini-2.5-flash` | Vercel | **13/13** | 321 s | ~25 s | 2.6× faster than local. 3 rerank parse-fails tolerated by fallback. Est. ~$0.05/full-suite. |
| `anthropic/claude-haiku-4-5` | Vercel | 11/13 | 143 s | ~11 s | Polarity-matrix 4/4 ✓. Two edge-case fails: Bill Gates → `false` (fixture says `unknown`), Trump 2020 → `disputed` (NLI over-classified contradictions). |
| `openai/gpt-4o-mini` | Vercel | 2/4 polarity | (partial) | ~10 s | Polarity matrix only; too small for adversarial NLI. Negation cases mis-flipped. |
| `alibaba/qwen3.6-27b` | Vercel | 0/4 polarity | ~575 s | ~144 s | Strict json_schema not honoured through gateway; even tolerant-parser cannot recover all cases. Markedly slower than local qwen3. |
| `google/gemma-4-26b-a4b` | Vercel | 0/1 manual | — | — | NLI judge emits incomplete JSON: `{"label":"contradiction"<whitespace loop>` until max_tokens. Pipeline returns "no proposal." |
| `google/gemma-4-26b-a4b-it-mlx` | LM Studio (local) | — | — | — | LM Studio refuses to load model metadata — `Failed to resolve model metadata`. Same family fails on Vercel anyway. |

Smaller / older models considered but not benchmarked because they were
already disqualified by the same failure modes as the runs above.

**Vercel embedding probe** (2026-06-18). Same EN↔DE crosslingual pair
used in the granite calibration, against three multilingual candidates
on the Vercel Gateway. Higher crosslingual cosine = better recall on
DE-pendant fact-checks for an EN claim.

| Model | Dim | EN→DE crosslingual | Negation-pair (high=ok) | Unrelated (low=ok) | Cost/M tokens |
| --- | --- | --- | --- | --- | --- |
| `granite-278m-multilingual` (local) | 768 | **0.81** | 0.93 | 0.50 | 0 |
| **`google/text-multilingual-embedding-002`** | 768 | **0.75** | 0.88 | 0.40 | $0.025 |
| `openai/text-embedding-3-small` | 1536 | 0.56 ❌ | 0.78 | 0.12 | $0.02 |
| `cohere/embed-v4.0` | 1536 | 0.59 ❌ | 0.78 | 0.17 | ~$0.10 |

`google/text-multilingual-embedding-002` is the only Vercel-hosted
embedding that keeps EN↔DE crosslingual above the operational floor
needed for the matching pipeline (we use `minCosine=0.55`). OpenAI's
and Cohere's general-purpose embeddings are English-centric and would
silently drop DE-pendant fact-checks from retrieval.

**Vercel embedding cost** (measured on real ClaimReview data):

- Full corpus rebuild: 92,245 rows × ~30 tokens/row = ~2.7M tokens →
  **~$0.07 one-time** at $0.025/M tokens. Wall-clock ~50–80 min via the
  Vercel HTTP round-trip (~19 emb/s) vs ~13 min via local granite.
- Per query (one cli:label call): ~30 tokens → ~$0.0000007, i.e. about
  $1 per 1.4M calls. Negligible vs the LLM cost of the same call.
- The accepted -7 percentage point crosslingual cosine drop is offset
  by Stage 2 + Stage 3 doing the real filtering work; not benchmarked
  on `pnpm test:matching` directly but treated as load-bearing
  architectural property of the pipeline (Stage 1 is the recall stage,
  not the precision stage).

**Why granite-278m-multilingual for embedding**

Already justified in detail in
[`PIPELINE.md` § Stage 1](./PIPELINE.md#stage-1--dense-retrieval) and
[`RESEARCH-MATCHING.md`](./RESEARCH-MATCHING.md). Summary: measured
EN↔DE crosslingual cosine 0.81 vs ~0.52 for English-centric alternatives
(mxbai-large-v1), 75 emb/s on M3 Max, 280 MB index for 92 k rows. Ships
with LM Studio. No serious competitor at this size found on Vercel.

**Why qwen3.6-27b for local**

Measured on the fixture. Reliable strict json_schema. Multilingual
extraction works EN + DE. Reasoning model — needs
`OPENAI_MAX_TOKENS ≥ 4096` to avoid `finish_reason=length` truncating
JSON output via the `reasoning_content` channel. The pipeline already
handles this fallback.

**Why gemini-2.5-flash for Vercel**

Won head-to-head against four alternatives on the same fixture:

1. Hit the entire polarity matrix (the property the pipeline rewrite
   exists to fix).
2. Hit the harder Trump-2020 case where haiku-4-5 split the verdict.
3. Hit the Bill-Gates uncertainty case where haiku-4-5 mis-classified.
4. Three rerank parse-fails were caught by our tolerant-parser
   fallback (cosine-ordered passthrough) — verdict correctness was
   preserved. Worth tightening the rerank prompt for Gemini-class
   reasoning models, but not a blocker.
5. 2.6× faster wall-clock than the local qwen3 baseline, at <$0.10
   per full-suite run.

**Consequences**

- **Two deployment shapes documented and verified.** Anyone running the
  labeler can pick "all-local" or "Vercel-hosted" and reach the same
  correctness gate.
- **Embedding stays local in both shapes.** Operators do not need to
  shop for a Vercel-hosted embedding model that matches our test set.
- **The `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` split is load-bearing**
  for the Vercel shape. Without explicit values, embedding requests
  fall through to `OPENAI_BASE_URL` (Vercel) which does not host
  granite. See [`.env.example`](../.env.example) for the canonical
  three-line Vercel-side override:

  ```ini
  EMBEDDING_BASE_URL=http://127.0.0.1:1234/v1
  EMBEDDING_API_KEY=lm-studio
  EMBEDDING_MODEL=text-embedding-granite-embedding-278m-multilingual
  ```

- **Reviewing this ADR**: a model swap must (a) hit 13/13 on
  `pnpm test:matching`, (b) be cost-justified vs. the incumbent,
  (c) update or supersede this ADR with the new evidence table.

**Alternatives considered**

- **`alibaba/qwen3.6-27b` on Vercel as the cloud default** — same model
  name as our local reference, attractive on paper. Rejected: strict
  json_schema is not enforced through Vercel for qwen3, structured
  outputs are unreliable, and per-case latency was ~144 s (slower than
  local!). Whatever Vercel routes the canonical slug to behaves
  differently from local LM Studio's qwen3-27b.
- **`anthropic/claude-haiku-4-5` as Vercel default** — fastest model
  tested (~11 s/case), polarity matrix passes, and we initially leaned
  this way. Rejected on two edge-case fails: Bill-Gates and Trump-2020.
  These are *defensible* model choices (haiku is being more decisive
  than the fixture expects) but they mean a labeler on haiku diverges
  from the qwen3 reference on contested political claims — exactly
  where false positives are most costly.
- **`openai/gpt-4o`** — would likely pass the fixture (OpenAI is the
  canonical strict-json_schema implementation), but at 3-5× the price
  of gemini-2.5-flash with no measurable accuracy advantage on our test
  set. Worth revisiting if Gemini's cost-quality ratio drifts.
- **`openai/gpt-4o-mini`** — confirmed too small for adversarial
  polarity NLI. 2/4 on the polarity-matrix subset.
- **`google/gemma-4-26b-a4b` (both via Vercel and via LM Studio MLX)**
  — reasoning models that fall into a whitespace-loop after emitting
  the start of the JSON, max_tokens kills the call before content is
  ever emitted. Documented as a real Gemma + structured-output
  interaction bug. Could be mitigated with a tolerant partial-JSON
  parser (we already added one for the entail stage) but the underlying
  model behaviour is wasteful.

**Future revisit triggers**

- Local: a smaller / faster local model passes 13/13 within
  current LM Studio capability — e.g. a future qwen3.7-12b or similar.
- Vercel: a materially cheaper or faster model passes 13/13, OR
  Gemini-2.5-flash's pricing or rate-limits change such that the
  cost-quality ratio against haiku flips.
- A pricing shift on the Vercel Gateway pushes any model into a
  different ranking — Vercel exposes per-call cost in the response
  metadata, so this is observable from `pnpm test:matching` logs.
- An NLI prompt-hardening that fixes the haiku Bill-Gates / Trump-2020
  failures might make haiku competitive again. Worth re-running this
  fixture if the prompt changes.
