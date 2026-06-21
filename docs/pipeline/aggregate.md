# Stage 4 — Aggregate

**Code**:
[`src/pipeline/matching.ts`](../../src/pipeline/matching.ts)
calling
[`src/pipeline/normalise-rating.ts`](../../src/pipeline/normalise-rating.ts).
**Purpose**: collapse the surviving (entail + flipped contradict)
candidates into one of the six verdict labels.

## Procedure

After Stage 3 we have at most 5 candidates, each tagged
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
