# Stage 1 — Claim extraction

**Code**:
[`src/pipeline/extract.ts`](../../src/pipeline/extract.ts).
**Purpose**: take a Bluesky post's text and return zero or more
**atomic, falsifiable** claims, each with a *decontextualised*
standalone version that downstream stages can match against
publisher ClaimReview entries.

This is the only stage that adds new content (the decontextualised
text); every later stage operates on what extraction emitted. A bad
extraction silently propagates into the verdict.

## What an extracted claim looks like

```ts
{
  atomic_text: 'Vaccines contain microchips.',
  decontextualized_text: 'COVID vaccines contain microchips that track recipients.',
  span_start: 12,
  span_end: 42,
  is_falsifiable: true,
  lang: 'en',
  entities: ['vaccines', 'microchips'],
  confidence: 0.92,
}
```

Strict JSON-Schema response from the LLM. Validated by
[zod](https://github.com/colinhacks/zod) at the call site so a
malformed response throws before it can corrupt the pipeline state.

## Three editorial choices baked into extraction

### 1. Atomic claims

One assertion per claim. A post like "vaccines contain microchips
and Bill Gates is behind it" produces *two* claims, each matched
separately. Aggregating them into one fact-check candidate would
force the downstream NLI judge to reason over a compound proposition
— a task it does measurably worse on than over single propositions
([FACT-GPT](https://arxiv.org/html/2407.06058v1) finds compound-claim
F1 drops ~12 points vs atomic).

### 2. Falsifiability gate

`is_falsifiable: false` claims are dropped *at extraction time* —
they never reach retrieval. Opinions ("I love this"), feelings,
hypotheticals ("if X then Y"), rhetorical questions, jokes, and
pure name-calling all fall into this category. There is no
fact-checker who could meaningfully review them, so the safe
behaviour is silence.

The labeler is a router, not a critic. Surfacing
`fact-unknown` on opinions would mis-frame the service as
"refused to take a position" rather than "this isn't the kind of
statement the service operates on."

### 3. Decontextualisation

The decontextualised version rewrites the claim so it stands alone
outside the post's surrounding context. Example:

- Post: *"this is why kids shouldn't get them"* (replying to a
  vaccines thread)
- Atomic: *"kids shouldn't get them"*
- Decontextualised: *"Children should not receive COVID-19 vaccines."*

Without decontextualisation the cosine similarity in
[Stage 2](./retrieve.md) misses the topical anchor and the candidate
pool fills with unrelated "shouldn't" statements. Decontextualisation
is the cheapest improvement to matching recall measured on the
fixture (+0.18 hits-per-claim on the polarity-matrix cases).

## Confidence: claim-ness, not truth

`confidence ∈ [0, 1]` reflects *how sure the model is that this is a
real factual assertion* — **not** how sure the model is the claim is
true. The pipeline drops claims with `confidence < 0.45` because at
that point the LLM itself is unsure whether the post contains a
checkable claim at all, and silence is safer than a low-quality
match.

The aggregation stage is the only stage that takes a position on
truth. Extraction stays neutral by construction.

## Model choice

Same `OPENAI_MODEL` env as Stages 2 and 3 — qwen3.6-27b on the
all-local deployment, gemini-2.5-flash on the Vercel-hosted shape.
See [`../ADR_model_choices.md`](../adr/model-choices.md) for the
head-to-head and the reasons. Both produced 14/14 on
`pnpm test:matching` and agreed on every extracted-claim text on the
fixture posts.

Strict structured-output is required. The prompt asks for JSON
matching a specific schema; the OpenAI-compatible client passes that
schema as `response_format: { type: 'json_schema', json_schema: ... }`
where the provider supports it (OpenAI, qwen3 via LM Studio,
gemini-2.5-flash all do).

For models with reasoning channels (qwen3, gemini): set
`OPENAI_MAX_TOKENS ≥ 4096`. The reasoning trace can otherwise
truncate the JSON output as `finish_reason=length`. The extract
client tolerates this and retries once with a larger budget, but
configuring the budget right is cheaper than the retry.

## Research backing

- **FEVEROUS (FEVER 2021)** — the modern fact-extraction-and-verify
  shared task. Their baseline pipeline extracts claims as a first
  stage and treats it as the source of truth for everything
  downstream. Extraction quality dominates downstream F1.
  ([Aly et al. 2021](https://aclanthology.org/2021.fever-1.1/))
- **AVeriTeC** (2023) — the larger successor task. Their guidelines
  for what counts as a "claim" map closely to our `atomic +
  falsifiable + decontextualised` triple.
  ([Schlichtkrull et al. 2023](https://arxiv.org/abs/2305.13117))
- **ClaimBuster** — the seminal claim-detection work. Defines a
  three-class taxonomy (non-factual / unimportant-factual /
  check-worthy-factual). Our `is_falsifiable + confidence` pair
  collapses that to a single decision the LLM can make per claim.
  ([Hassan et al. 2017](https://dl.acm.org/doi/10.14778/3137765.3137815))
- **FACT-GPT** — the empirical finding that LLM claim-decomposition
  + atomicity is materially more accurate than treating posts as
  monolithic input.
  ([Choi et al. 2024](https://arxiv.org/html/2407.06058v1))

## Honest caveats

- **Single-language prompt.** The extraction prompt is English-only.
  Posts in DE/FR/ES still work because both deployment models are
  multilingual, but extraction quality on those languages is
  systematically slightly behind English. A per-language prompt is
  documented as a future improvement in
  [`README.md` § Future extensions](./README.md#6-multi-language-extraction-prompt).
- **Irony / sarcasm.** Posts written ironically ("yeah right, the
  vaccines really do contain microchips 🙄") may extract as if the
  irony weren't there. The fixture catches the obvious cases but
  not subtle ones. The HITL layer is the safety net.
- **Compound-claim atomicity is imperfect.** "X and Y" usually
  splits cleanly; "X because Y" sometimes flattens into a single
  claim. The pipeline accepts the loss because re-prompting the
  model to re-split rarely helps.
- **Quote attribution.** Quoted text from third parties extracts as
  the quoted speaker's claim, not the poster's. This matches
  fact-checker practice (publishers rate the claim, not who
  repeated it).
