# Stage 4 — NLI polarity gate

**Code**: [`src/pipeline/entail.ts`](../../src/pipeline/entail.ts).
**Purpose**: ask how the user's claim relates to each surviving
publisher's claim. The answer drives the most important decision in
the pipeline — *flip / pass-through / drop*.

## The three NLI labels

| NLI label | Meaning | Action on the publisher's verdict |
|---|---|---|
| `entailment` | user's claim implies publisher's claim | **pass through** |
| `contradiction` | user's claim implies the *negation* of publisher's claim | **flip** (`false` ↔ `true`, `mixed` unchanged, `outdated` → `unknown`) |
| `neutral` | claims are about different things | **ignore** — do not aggregate |

The publisher's verdict is about *the claim the publisher reviewed*.
To re-use it for the user's claim, we have to know how the user's
claim relates to the publisher's. Without this gate, "the earth is
not flat" inherits `false` from "the earth is flat" — double-wrong.

## Implementation — LLM-as-judge

LLM-as-judge via `OPENAI_MODEL` (qwen3.6-27b in the all-local
deployment, gemini-2.5-flash on Vercel). 3-class strict-JSON-Schema
response. Measured 4–9 s per pair on the smoke test. Reasons given
by the judge are persisted in `verdict.rationale` for operator
audit.

Smoke test (qwen3.6-27b) — all 4 pairs hit expected label:

- "earth flat" vs "earth round" → contradiction (conf 1.0)
- Biden 2020 vs Trump 2016 → neutral (conf 0.95)
- "vaccines contain microchips" vs negation → contradiction (conf 1.0)
- Hindu mythology *portrayal* vs "earth is round" → neutral (conf 0.95)

The Hindu-mythology case is the load-bearing one: the LLM correctly
distinguishes *"X is portrayed as Y"* from *"X is Y"*. A dedicated
NLI model can fail this if it's not trained on such meta-claims —
see [`../adr/nli-judge-llm-not-mdeberta.md`](../adr/nli-judge-llm-not-mdeberta.md)
for the empirical probe behind this choice.

## Honest caveat

Contradiction detection is the weakest of the three NLI classes.
FACT-GPT reports F1 ~0.46 on contradiction vs ~0.83 on entailment
even with fine-tuned LLMs. We will likely mis-classify some negated
claims as `neutral` and abstain rather than flip. **That is the
correct failure mode** — labelling nothing is better than labelling
true claims as refuted.
