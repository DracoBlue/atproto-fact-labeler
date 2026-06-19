# Claim Matching Pipeline

> **Status: Stages 1 + 3 + 4 implemented and wired.** The old FTS-only lookup
> (`src/pipeline/lookup.ts`) is deleted. `pnpm cli:label <url>` now runs the
> retrieve → NLI → aggregate chain end-to-end. Stage 2 (dedicated cross-encoder
> reranker) is **not** implemented — see § "Current state vs. ideal" — and the
> Stage 3 NLI is implemented as LLM-as-judge (qwen3) rather than a dedicated
> NLI model. Both decisions are revisitable; both keep the deployment shape to
> "one LM Studio instance, no Python."

## What runs in code today

- `src/embedding/client.ts` — OpenAI-compatible `/v1/embeddings` client
  (forces `encoding_format: 'float'` to work around LM Studio + openai-node
  base64 incompatibility).
- `src/pipeline/retrieve.ts` — Stage 1 dense retrieval. Cosine top-K with
  `minCosine` floor 0.55.
- `src/pipeline/rerank.ts` — Stage 2 LLM-as-relevance-judge. Single
  batched call rates all retrieved candidates 0..1, keeps top
  `RERANK_KEEP` above `RERANK_THRESHOLD`. Drops irrelevant candidates
  before Stage 3 NLI pays the per-pair cost.
- `src/pipeline/entail.ts` — Stage 3 NLI gate via LLM-as-judge. Strict JSON
  Schema response. **Why not a dedicated NLI head** like mDeBERTa:
  see [`ADR_nli_llm_judge_over_mdeberta.md`](./ADR_nli_llm_judge_over_mdeberta.md).
- `src/pipeline/matching.ts` — Stage 4 polarity-aware aggregation; flips
  publisher verdict on `contradiction`, drops `neutral`, returns null if 0
  candidates survive.
- `src/cli/embed-rebuild.ts` — `pnpm cli:embed-rebuild` backfills embeddings
  for all ClaimReview rows. Model-aware: re-embeds rows tagged with an
  outdated `embedding_model`.
- DB columns: `claim_review.embedding BLOB`, `embedding_dim`, `embedding_model`.

## Verified outcomes (2026-06-17)

The two posts that previously walked the FTS-only pipeline into the
classic failure mode now produce the correct labels:

| Post text | Old FTS verdict | New pipeline verdict | Emitted label |
| --- | --- | --- | --- |
| "the earth is not flat." | `false` conf 1.0 | **`true`** conf 0.871 (5 votes) | `fact-supported` |
| "the earth is round." | `false` conf 1.0 | **`true`** conf 0.479 (7 votes) | `fact-supported` |

Both cases work because Stage 3 (NLI) correctly classifies the retrieved
fact-checks as *contradictions* of the negated user claim, and Stage 4
flips the publisher's `false` verdict to `true`.

## Why the old FTS lookup was wrong

The previous `src/pipeline/lookup.ts` (deleted) did a single SQLite FTS5
`OR`-query over the ClaimReview table and aggregated the top-5 publisher
native ratings. Two real test posts on Bluesky walked it into the
classic failure modes:

| Post | Truth | Labeler verdict | What actually happened |
| --- | --- | --- | --- |
| "the earth is not flat" | true | `fact-refuted` (conf 0.879) | FTS matched 5 unrelated false-claim articles via `earth*` or `flat*` prefix; aggregator passed through 5× "False". |
| "the earth is round"    | true | `fact-refuted` (conf 1.0)   | FTS matched articles about Japan earthquakes, AOC tweets, COVID stimulus — none about Earth shape; aggregator returned conf 1.0 anyway. |

Three failure modes are baked into the current design:

1. **Single-stage keyword retrieval.** `earth* OR round*` matches every
   document containing either prefix. Cross-stem hits (e.g.
   "Earth**quake**") flood the result set on common words.
2. **No quality gate before aggregation.** We take the top-k regardless of
   relevance score. If the top-k are all spurious, aggregation still produces
   "5/5 publishers say False, confidence 1.0."
3. **Publisher-verdict pass-through ignores polarity.** A fact-check that
   refutes "earth is flat" gets normalised to `false`. We then apply that to
   "earth is not flat" — the *negation* — without flipping. Verdict is
   double-wrong.

The peer-reviewed literature has solved all three. Reviewed in
[`docs/RESEARCH-MATCHING.md`](./RESEARCH-MATCHING.md) (auto-generated from the
deep-research pass that produced this design); summary below.

## Architecture

```
   atomic claim from extraction (S1)
              │
              ▼
   ┌──────────────────────────────────┐
   │ STAGE 1 — Dense retrieval        │
   │   BGE-M3 multilingual embedding  │
   │   cosine top-50 from index       │
   └──────────────┬───────────────────┘
                  │
                  ▼
   ┌──────────────────────────────────┐
   │ STAGE 2 — Cross-encoder rerank   │
   │   bge-reranker-v2-m3             │
   │   top-5 with score ≥ τ_rerank    │
   └──────────────┬───────────────────┘
                  │
                  ▼
   ┌──────────────────────────────────┐
   │ STAGE 3 — NLI polarity gate      │
   │   mDeBERTa-v3-base-mnli-xnli     │
   │   3-class: entail / neutral /    │
   │             contradict           │
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
   │ STAGE 4 — Aggregate              │
   │   only over entail + flipped     │
   │   contradict matches             │
   │   if none → uncovered            │
   └──────────────────────────────────┘
```

Three off-the-shelf models. No training. No 7B+ LLMs in the hot path. Total
on-disk: about 1.4 GB of model weights plus ~600 MB of cached embeddings for
a 200k-entry ClaimReview corpus.

## Current state vs. ideal

The architecture diagram above shows four stages. All four are now shipped:

| Stage | Status | Note |
| --- | --- | --- |
| 1 Retrieve (dense) | **shipped** | granite-278m-multilingual via LM Studio |
| 2 LLM relevance rerank | **shipped** | single batched LLM call rates top-K → keeps RERANK_KEEP above RERANK_THRESHOLD |
| 3 NLI polarity gate | **shipped** | LLM-as-judge via qwen3.6-27b (see [ADR](./ADR_nli_llm_judge_over_mdeberta.md)) |
| 4 Aggregate w/ polarity | **shipped** | drops `neutral`, flips on `contradiction` |

**Why LLM-as-reranker instead of a dedicated cross-encoder
(`bge-reranker-v2-m3` etc.)?** Same Transformers.js / ONNX risk analysis
that drove the NLI decision: we already have a working, accurate LLM
endpoint, and Stage 2 only needs to ask the simpler question "is this
candidate even on-topic?" — not the harder NLI relationship question.
One batched call (~5–8 s on qwen3-27B) replaces 5 of the 10 Stage-3
NLI calls (~7 s each), so net wall-clock per claim drops from ~70 s to
~35-45 s on the full polarity-matrix fixture.

For *uncovered* claims (`my dog is brown`, `Mick Jagger is dead`),
Stage 2 typically drops every retrieved candidate to score 0 and
Stage 3 is skipped entirely. Empirically measured: "my dog is brown"
went from 34 s → 11 s wall-clock — **−66 %**.

A future dedicated cross-encoder path remains documented in §
"Future extensions" — would help if firehose-mode volume grows enough
to make the rerank LLM call itself the bottleneck.

## Stage 1 — Dense retrieval

**Replaces** the FTS5 keyword search. Whole-claim semantic similarity instead
of token overlap kills the "earth* matches earthquake" class of false
positives.

**Model (deployed)**:
[`text-embedding-granite-embedding-278m-multilingual`](https://huggingface.co/ibm-granite/granite-embedding-278m-multilingual)
— IBM Granite, Apache-2.0, 303 MB, 768 dims, multilingual primary focus.
Picked over BGE-M3 / Multilingual-E5-Large for three reasons measured on
our test set:

1. Ships with LM Studio (`text-embedding-granite-embedding-278m-multilingual`)
   — no separate runtime needed.
2. **Crosslingual EN↔DE works**: "the earth is round" vs.
   "Die Erde ist keine Scheibe" cosine 0.81 (vs 0.52 for mxbai-large-v1
   which is en-centric).
3. **75 emb/s** on M3 Max — 92k corpus rebuild in ~20 min on `pnpm cli:embed-rebuild`.

**Alternative if Granite isn't installed locally**:
[`BAAI/bge-m3`](https://huggingface.co/BAAI/bge-m3) — 568 MB, 1024 dims, same
multilingual property; needs Transformers.js or an Infinity server.
[`intfloat/multilingual-e5-large`](https://huggingface.co/intfloat/multilingual-e5-large)
— Success@10 = 0.87, MAP = 0.75 on AMC-16K
([Pikuliak et al. 2024](https://arxiv.org/html/2503.02737)).

**Storage**: pre-compute one dense vector per ClaimReview row (currently
92,245). At 768 dimensions × float32 that's ~280 MB total. Persisted as
raw float32 BLOBs in three new columns on the existing `claim_review`
table — no `sqlite-vec` dep needed; the scan is in-process and a single
linear pass takes ~10 ms for the whole corpus on M3 Max.

**Output**: top-K candidates (default 10) sorted by cosine. `minCosine`
floor 0.55 deliberately *low* — empirical measurement on our test set
showed legitimate Earth-spherical fact-checks at 0.70 and the worst
unrelated false-positives at 0.84 (Trump-2016 confused with Trump-2020).
A single cosine threshold cannot separate the two; Stage 3 NLI does.

### Why a single cosine threshold doesn't work

Measured on our calibration set (`docs/RESEARCH-MATCHING.md`):

| Class | min | median | max |
| --- | --- | --- | --- |
| legitimate match | 0.696 | 0.778 | 0.856 |
| true negation (must reach Stage 3) | 0.721 | 0.853 | 0.935 |
| unrelated | 0.417 | 0.595 | **0.840** |

The max-unrelated **exceeds** the min-match. The "Trump won 2020" vs.
"Trump won 2016" pair scores cosine 0.84 — embedding sees same entity +
same action + same domain, different year. Truth-condition-wise these are
independent propositions. **Only NLI can disambiguate** — which is the
research finding (Full Fact `t(v) = t(u)`) made concrete in our data.

## Stage 2 — Relevance rerank

**Why a reranker.** Bi-encoder retrieval (Stage 1) maps claim and candidate
into the same vector space independently. That's fast but loses pairwise
interaction. A cross-encoder takes both texts together and reads them
jointly, which is materially more accurate at small k.

> SK_DU at FEVER 2024 measured Hu-METEOR top-10:
> Cross-Encoder **0.1913** > Bi-Encoder 0.1787 > BM25 0.1452.
> ([SK_DU paper](https://aclanthology.org/2024.fever-1.11.pdf))

**Implementation (deployed)**: LLM-as-relevance-judge via the same
`OPENAI_MODEL` we use for extraction and NLI. One **single batched
call** rates every retrieved candidate 0..1 against the user's claim
in one round-trip. We keep the top `RERANK_KEEP` (default 5) whose
score ≥ `RERANK_THRESHOLD` (default 0.5) and discard the rest before
Stage 3 NLI runs.

The rerank prompt asks a much simpler question than NLI does — just
"is this candidate even on-topic?". The model returns a strict JSON
schema with one `{idx, score}` per candidate. On parse failure the
stage degrades to a no-op (passes the top `keep` Stage 1 results
through with `rerankScore = cosine`), so a transient LLM hiccup never
loses the pipeline.

**Why not `BAAI/bge-reranker-v2-m3` via Transformers.js**: same ONNX
ergonomics concern documented in
[`ADR_nli_llm_judge_over_mdeberta.md`](./ADR_nli_llm_judge_over_mdeberta.md).
Worth revisiting if the Stage 2 LLM call itself becomes the bottleneck
(it currently doesn't).

**Measured impact** on `pnpm test:matching` (M3 Max, qwen3.6-27B):

| Case | Before rerank | After rerank | Delta |
| --- | --- | --- | --- |
| the earth is round | 45 s | 33 s | −27 % |
| My dog is brown (uncovered) | 34 s | 11 s | **−66 %** — Stage 2 drops all candidates, Stage 3 never runs |
| (full 13-case fixture) | 826 s | see verified outcomes table | — |

The big uncovered-case wins come from Stage 2 zeroing out every
candidate — Stage 3 sees an empty list and `uncovered` is returned
without paying for any NLI calls.

**If 0 candidates pass `RERANK_THRESHOLD` → label is `uncovered`.** No
aggregation, no fallback to lower-quality matches. This is the
principled answer to failure mode B (no quality gate).

## Stage 3 — NLI polarity gate

**This is the answer to failure mode C** and the most important stage. The
publisher's verdict is about the claim the publisher reviewed. To re-use it
for the user's claim, we have to know how the user's claim relates to the
publisher's claim:

| NLI label | Meaning | Action on the publisher's verdict |
| --- | --- | --- |
| `entailment` | user's claim implies publisher's claim | **pass through** |
| `contradiction` | user's claim implies the *negation* of publisher's claim | **flip** (false→true, true→false, mixed→mixed) |
| `neutral` | claims are about different things | **ignore** — do not aggregate |

**Deployed**: LLM-as-judge via `OPENAI_MODEL` (qwen3.6-27b in our setup).
3-class strict-JSON-Schema response. Measured 4–9 s per pair on the
smoke test. Reasons given by the judge are persisted in
`verdict.rationale` for operator audit.

> Smoke test on qwen3.6-27b — all 4 pairs hit expected label:
> - "earth flat" vs "earth round" → contradiction (conf 1.0)
> - Biden 2020 vs Trump 2016 → neutral (conf 0.95)
> - "vaccines contain microchips" vs negation → contradiction (conf 1.0)
> - Hindu mythology *portrayal* vs "earth is round" → neutral (conf 0.95)
>
> The Hindu-mythology case is the important one: the LLM correctly
> distinguishes *"X is portrayed as Y"* from *"X is Y"*. A dedicated NLI
> model can fail this if it's not trained on such meta-claims.

**Alternative (not yet implemented)**:
[`MoritzLaurer/mDeBERTa-v3-base-mnli-xnli`](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-mnli-xnli),
280 MB, multilingual NLI cross-encoder. Faster (~30 ms per pair) but lacks
the world-knowledge an LLM uses to handle the Hindu-mythology case.
`NLI_MODE=dedicated` is reserved for this.

LLM-as-judge has reached 80%+ macro F1 on this task ([Vykopal et al.
2024](https://arxiv.org/html/2503.02737)).

**Honest caveat.** Contradiction detection is the weakest of the three NLI
classes. FACT-GPT reports F1 ~0.46 on contradiction vs ~0.83 on entailment
even with fine-tuned LLMs. We will likely mis-classify some negated claims
as `neutral` and abstain rather than flip. **That is the correct failure
mode** — labelling nothing is better than labelling true claims as
refuted.

## Stage 4 — Aggregate

After Stage 3 we have at most 5 candidates, each tagged `entailment`,
`contradiction`, or `neutral`.

1. Drop all `neutral` candidates.
2. For each `entailment` candidate: use the publisher's normalised verdict
   as-is.
3. For each `contradiction` candidate: flip the publisher's verdict
   (`false` ↔ `true`, `mixed` unchanged, `outdated` → `unknown`).
4. If 0 candidates remain → `uncovered`, no label emitted.
5. If 1+ candidates remain: aggregate exactly as today
   (`src/pipeline/normalise-rating.ts:aggregateVerdicts`), but only over
   the surviving set.

The `verdict_id → evidence` provenance still records the original publisher
URL and the original native rating. The `verdict.rationale` field will note
the NLI decision so an operator can audit why a flip happened.

## Frame of reference — what production fact-checkers call this

The architecture above is not a quirky choice. It mirrors the consensus
operational framing of the two organisations whose pipelines are most
publicly documented:

- **Meedan (Alegre + Check)**: matching answers *"can the claims in these
  two posts be served with one fact-check?"* — a clustering question, not a
  verdict pass-through. See
  [Meedan claim-matching post](https://meedan.org/post/claim-matching-global-fact-checks-at-meedan)
  and [Alegre repo](https://github.com/meedan/alegre).
- **Full Fact**: two claims match iff they have *identical truth conditions
  — t(v) = t(u)*. There is no possible world in which one is true and the
  other false. By construction, this rules out flipping polarity by
  accident. See
  [Full Fact post on claim matching definition](https://fullfact.org/blog/2021/oct/towards-common-definition-claim-matching/).

Our current FTS-and-aggregate code does verdict pass-through, which neither
framing endorses. The new pipeline does clustering + polarity check, which
both endorse.

## Integration into the existing pipeline

The current orchestrator (`src/pipeline/orchestrator.ts`) runs five stages
(S0 ingest → S1 extract → S2 lookup → S3 normalise → S5 propose). The new
work fits inside S2 and S3:

| Old | New |
| --- | --- |
| `S2: lookup` — single FTS query | `S2a: retrieve` (BGE-M3 top-50) → `S2b: rerank` (bge-reranker-v2-m3 top-5) → `S2c: entail` (mDeBERTa NLI) |
| `S3: normalise` — pass-through | `S3: normalise + apply NLI polarity` (flip on contradiction, drop on neutral) |

`src/pipeline/extract.ts` and `src/pipeline/orchestrator.ts` keep their
shapes. The orchestrator's return type already carries
`{ extractedClaims, falsifiableClaims, claimsWithMatches }` which is enough
to drive the diagnostic-reply paths
([`docs/TRIGGER_MENTIONS.md`](./TRIGGER_MENTIONS.md) §
"Reply behaviour by outcome") — `claimsWithMatches` now means "claims with
at least one entailment- or contradiction-class candidate above
τ_rerank."

## File layout (planned)

```
src/pipeline/
  retrieve.ts        # Stage 1 — BGE-M3 dense top-k
  rerank.ts          # Stage 2 — bge-reranker-v2-m3 cross-encoder + τ_rerank
  entail.ts          # Stage 3 — mDeBERTa NLI 3-class judge
  matching.ts        # Stage 4 — combine + aggregate (replaces lookup.ts)
  normalise-rating.ts  # unchanged
  orchestrator.ts    # rewire S2 to retrieve→rerank→entail→matching

src/embedding/
  index.ts           # Transformers.js model loader; shared by retrieve + entail
  store.ts           # sqlite-vec wrapper, embed-on-ingest, load-on-query

src/cli/
  index-rebuild.ts   # one-off: compute embeddings for every ClaimReview row
```

The old `src/pipeline/lookup.ts` and `test/lookup.test.ts` are deleted.

## Runtime cost

| Component | Model | Disk | RAM | Latency / query (CPU) | Latency / query (GPU/Metal) |
| --- | --- | --- | --- | --- | --- |
| Embedding (Stage 1) | BGE-M3 | 568 MB | ~1 GB | ~50 ms | ~5 ms |
| Reranker (Stage 2) | bge-reranker-v2-m3 | 568 MB | ~1 GB | ~80 ms over top-50 | ~10 ms |
| NLI (Stage 3) | mDeBERTa-v3-base-mnli-xnli | 280 MB | ~600 MB | ~30 ms × top-5 = 150 ms | ~20 ms |
| Storage (vectors) | — | ~360 MB | — | — | — |

Total: ~1.4 GB on disk, ~2.5 GB peak RAM, ~280 ms per claim on CPU,
~35 ms on Apple Silicon Metal or CUDA.

The current LLM extraction stage (S1) dominates wall-clock today (~3 s per
post for qwen3.6-27b's reasoning pass). Adding ~300 ms for matching is
negligible against that.

## Runtime
We run these models on the same OpenAI-compatible endpoint as the LLM (LM
Studio, vLLM, etc.). Embeddings and reranker exposed via the
[OpenAI `embeddings` API](https://platform.openai.com/docs/api-reference/embeddings);
NLI exposed as a chat-completions call with a structured-output schema. No
Python runtime needed in our codebase.

LM Studio already lists embedding models (`qwen3-embedding-4b-dwq`,
`qwen3-embedding-0.6b-dwq`, `nomicai-modernbert-embed-base`) — we'd need to
load `bge-m3`, `bge-reranker-v2-m3`, and the NLI model alongside.
Alternatively `bge-reranker` + `nli` can be served via
[Transformers.js](https://huggingface.co/docs/transformers.js) inside the
Node process for a single-process deployment; trade-off is bigger
node-process RSS vs. one fewer service to run.

## Test-set / CI gate

The labelled test set lives at
[`test/fixtures/matching-cases.json`](../test/fixtures/matching-cases.json).
13 cases at the time of writing, grouped into six categories:

- **`polarity-matrix`** — earth round/flat × is/isn't (4 cases). Property:
  *true claims and their negations get opposite verdicts*. This is the
  property the FTS pipeline failed and the whole rewrite exists to fix.
- **`classic-conspiracy`** — Vaccines+microchips, 5G+COVID. Property:
  publishers' false ratings pass through via entailment.
- **`true-supported`** — "COVID vaccines are safe and effective".
  Property: contradiction-flip recovers true from false-rated
  anti-vax reviews.
- **`temporal-entity`** — Trump-vs-Biden 2020. Property: Stage 3 NLI
  correctly disambiguates same-topic claims with different truth values.
- **`publisher-uncertainty`** — Bill Gates microchip implants.
  Property: when publishers themselves are uncertain, the system does
  not over-commit (verdict = `unknown`).
- **`uncovered`** / **`uncovered-entity-disambiguation`** /
  **`uncovered-number-disambiguation`** — my dog, Mick Jagger (vs Mugabe
  / Jackie Chan death hoaxes), German unemployment (vs Italian
  unemployment). Property: high-cosine topical neighbours with
  *different* entities or numbers must drop as `neutral`, not flow
  through as `entailment`.

Runner: `pnpm test:matching`. Exit code is non-zero on regression.
**Not** part of `pnpm test` — needs LM Studio running, a populated index,
and ~15 min wall clock for the full set on M3 Max. Treat a regression
here as a release blocker.

```bash
pnpm test:matching                       # full set
pnpm test:matching --filter polarity     # by category
pnpm test:matching --filter uncovered    # by category
pnpm test:matching --json > report.json  # machine-readable
```

Each case asserts:

- `expected_verdict` — one of `true | false | mixed | unknown |
  disputed | outdated | uncovered`.
- optional `min_confidence` — pipeline confidence floor on hits.

Add a case whenever a new failure mode is identified in production.
The fixture is small and curated, not random — adding noise weakens the
gate. If a real-world post produces a wrong label, the fix lands in two
parts: (a) the pipeline change, (b) the case that proves it stays
fixed.

## Open questions (from the research pass)

1. **Concrete cosine and reranker thresholds.** Papers tune per dataset.
   We will calibrate τ_rerank on the test set above before declaring the
   pipeline stable.
2. **Is polarity flip on contradiction actually deployed anywhere?**
   The research found it principled (FACT-GPT, ProoFVer) but not widely
   documented as a deployed production pattern. We'd be early — but on the
   correct side of the correctness frontier.
3. **BGE-M3 quality on German short claims.** Multilingual benchmarks
   under-report German specifically. We will measure on the test set.
4. **NLI: dedicated mDeBERTa vs. local LLM as judge.** Both viable.
   Decision driven by the test set, not by code aesthetics.

## What this design does *not* do

- **It does not invent verdicts when no fact-check matches.** That path
  (AVeriTeC-style RAG verification) remains explicitly out of scope. We
  stay lookup-only; non-matching posts are `uncovered`.
- **It does not try to be perfect on contradiction detection.** F1 ~0.46
  is the published ceiling for the unsupervised setting. We accept some
  contradictions getting classified as `neutral` and silently abstaining.
  Abstain is safe; flip is consequential; never-flip is wrong.
- **It does not change the trigger surface or the reply surface.**
  Mentions, reports, watchlist, firehose, mention-replies, no-claim /
  no-match / no-target replies — all unchanged. Only the matching engine
  is replaced.

## Future extensions

The shipped pipeline is the **minimum sensible first version**. The list
below is what we would add next, in rough order of impact-per-effort, if
volume or precision needs grow.

### 1. Dedicated cross-encoder reranker (Stage 2)

**Why**: today we retrieve top-10 and run NLI on all 10 (~40–90 s wall
clock per claim because qwen3 is large). A reranker would drop top-10 →
top-5 in ~50 ms and halve NLI cost. At scale (firehose mode = every
Bluesky post), Stage 2 stops being optional.

**Concrete options**:
- `BAAI/bge-reranker-v2-m3` via Transformers.js in-process (~570 MB,
  no extra service).
- Same model via an Infinity / text-embeddings-inference sidecar
  exposing `/v1/rerank` — gives a clean HTTP boundary.
- LM Studio does not currently host rerankers; this is the constraint
  that pushed us to skip Stage 2 for now.

Add reranker thresholds (~0.6 on the bge-reranker-v2-m3 sigmoid logit)
as the second quality gate before NLI.

### 2. Dedicated NLI model instead of LLM-as-judge

**Why**: qwen3.6-27b as judge takes 4–9 s per pair. `mDeBERTa-v3-base-mnli-xnli`
runs the same 3-class entailment in ~30 ms via Transformers.js. ~100×
speedup. The trade-off is world-knowledge: mDeBERTa correctly handles
direct negation pairs but fails on meta-claims like *"Hindu mythology
*portrayed* the earth as spherical"* vs *"the earth is round"* — qwen3
gets this right (see § Stage 3 smoke test).

Realistic compromise: use mDeBERTa as the fast path, **escalate to
LLM-judge only when mDeBERTa is uncertain** (confidence < 0.7). Most
posts get the 30 ms path; edge cases get the 5 s path.

`NLI_MODE=dedicated` is the env knob already reserved for this.

### 3. AVeriTeC-style fallback for `uncovered` claims

**Why**: today, posts with no entailment- or contradiction-class match
return `uncovered`. That's the safe failure mode, but a labeler that
*only* labels what's already in someone else's fact-check database can
never address novel claims.

Add a Stage 5 that runs a retrieval-augmented LLM verification when
Stage 4 returns null: web-search for evidence, prompt qwen3 with the
gathered snippets, ask for a verdict + supporting URLs. Mark the
resulting verdict as `verifier_kind='rag-llm'` (different from `feed`)
so operators can tune trust separately.

This is conceptually a much bigger commitment — moving from "claim
matcher" to "claim verifier" — and worth a separate design doc.

### 4. Threshold calibration

τ_retrieve is currently 0.55 (low, by design). τ_rerank, τ_nli_confidence
are not exposed. We should:

- Build the labelled test set described in § "Test-set / CI gate" — about
  20 polarity-matrix pairs (`earth round`/`earth flat`, `vaccines
  microchips yes`/`no`, German pendants).
- Sweep thresholds against it; pick the operating point that maximises
  the polarity-matrix property (true claims and their negations get
  opposite verdicts).
- Wire a `pnpm test:matching-fixtures` CI gate so future pipeline
  changes can't regress this.

### 5. Index-build performance

`pnpm cli:embed-rebuild` currently does ~130 emb/s sequentially against
LM Studio (~12 min for 92k rows). Possible speedups:

- Parallel batches against multiple LM Studio model instances
  (granite-278m is small enough that 2-3 fit on Metal).
- Switch the embedding model to Transformers.js in-process to remove the
  HTTP round-trip overhead — would give ~300 emb/s on Apple Silicon at
  the cost of a Python-free Node dep.
- Persist via `sqlite-vec` instead of raw BLOB once the corpus grows
  past ~500k rows where linear scan starts to matter.

### 6. Multi-language extraction prompt

Extraction (Stage S1) currently uses a single English prompt. Posts in
DE/FR/ES still work because qwen3 is multilingual, but a per-language
prompt would likely improve atomic claim quality on non-English
content. The reply layer already i18ns; the extraction layer should
match.
