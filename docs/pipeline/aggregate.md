# Stage 5 — Aggregate

**Code**:
[`src/pipeline/matching.ts`](../../src/pipeline/matching.ts)
calling
[`src/pipeline/normalise-rating.ts`](../../src/pipeline/normalise-rating.ts).
**Purpose**: collapse the surviving (entail + flipped contradict)
candidates into one of the six verdict labels.

## Procedure

After Stage 4 we have at most 5 candidates, each tagged
`entailment`, `contradiction`, or `neutral`.

1. **Drop all `neutral` candidates.**
2. For each `entailment` candidate: use the publisher's normalised
   verdict as-is.
3. For each `contradiction` candidate: flip the publisher's verdict
   (`false` ↔ `true`, `mixed` unchanged, `outdated` → `unknown`).
4. **If 0 candidates remain → `uncovered`, no label emitted.**
5. If 1+ candidates remain: aggregate
   (`aggregateVerdicts` in `normalise-rating.ts`) over the surviving
   set.

The aggregator handles:

- **Consensus** — all surviving votes agree → high confidence
- **Split** — votes disagree → `disputed`
- **Mixed truth-value publisher ratings** (`mostly-true`, `half-true`)
  → `mixed`
- **Confidence reduction** when only 1 publisher backs the verdict
  (see `HITL_AUTO_MIN_VOTES` operator gate)

## Provenance

The `verdict_id → evidence` link still records:

- Original publisher URL
- Original native rating string (verbatim)
- The intake path the entry came from (own / bulk-feed / factcheck-api)

The `verdict.rationale` field notes the NLI decision so an operator
can audit *why* a flip happened — e.g. "Aggregated from 2 fact-checks;
agreement=0.5. NLI: 0 entail, 2 contradict, 3 neutral (dropped).
Both publishers contradict the symmetric flat-earth framing;
polarity-flip yields 'supported'."

## What aggregation does *not* invent

The aggregator never produces a verdict that no surviving publisher
backs. If only `contradiction` votes survive, the verdict comes from
flipping their publisher's rating; if only `entailment` votes
survive, the verdict mirrors theirs. The labeler's role ends here:
publish the result + the evidence, do not over-commit.

This is the boundary that distinguishes the labeler from a
fact-checker.

## Why this shape

Two design choices are load-bearing for aggregation:

### 1. Polarity flip on contradiction

When a publisher rates "the Earth is flat" as *False*, the
truth-value of *"the Earth is round"* is **True** — the publisher
has implicitly committed to the negation. Stage 3 detected the
contradiction; aggregation propagates it.

This matters because most publishers fact-check the *false* version
of a claim (the version that needs correcting), not the *true*
version. If aggregation only used pass-through, true claims like
"the Earth is round" would silently inherit `uncovered` even though
multiple publishers have addressed the topic. Polarity flip
recovers the signal.

The principle is formalised by **Full Fact's t(v) = t(u)** — two
claims match iff they have identical truth conditions. A
contradiction is the case where they have *opposite* truth
conditions; the publisher's verdict is reusable but the polarity is
inverted. ([Full Fact: Towards a common definition of claim matching](https://fullfact.org/blog/2021/oct/towards-common-definition-claim-matching/))

### 2. Disputed instead of majority vote

If publishers disagree (e.g. 2 *True*, 2 *False*), the aggregator
returns `disputed` — **not** the majority. Reasons:

- A 2-vs-2 split on a claim is editorially interesting in itself.
  Hiding it behind a majority verdict misrepresents the publisher
  consensus.
- The detail page can surface the conflict — multiple sources side
  by side — which is more useful to a reader than a single label
  that papers over the disagreement.
- Production fact-checkers don't aggregate other fact-checkers
  by majority vote either. The
  [Meedan Alegre](https://github.com/meedan/alegre) pipeline treats
  matched-but-disagreeing reviews as a routing question, not a
  voting question.

`HITL_AUTO_MIN_VOTES` adds a second guardrail at deployment time:
auto-accept only fires when at least N publishers backed the verdict.
Single-publisher verdicts go through human review by default.

## Research backing

- **Full Fact** — claim-matching definition (`t(v) = t(u)`) and the
  argument against verdict pass-through.
  ([blog post](https://fullfact.org/blog/2021/oct/towards-common-definition-claim-matching/))
- **Meedan Alegre + Check** — production claim-matching
  architecture. Treats publisher consensus as a clustering question,
  not a voting question.
  ([Meedan post](https://meedan.org/post/claim-matching-global-fact-checks-at-meedan),
   [Alegre repo](https://github.com/meedan/alegre))
- **AVeriTeC** — defines aggregation over multi-source evidence as a
  separate stage with its own evaluation. Confirms that aggregating
  *after* the polarity gate is the standard frame.
  ([Schlichtkrull et al. 2023](https://arxiv.org/abs/2305.13117))
