# Known limitations

Given a post arriving at the labeler, what *won't* the labeler do —
and which guardrail produces that behaviour. Framed from the operator
perspective: "if my user reports / mentions this kind of post, what
should I expect?"

The deliberate non-actions below are how the labeler stays honest. A
fact-checker that lies confidently is worse than one that stays
silent.

---

## 1. No same-language fact-check exists → no label

**Input.** A post in language X, where no allowlisted publisher has
reviewed a matching claim in language X.

**Behaviour.** Verdict `uncovered`. No label on the wire. The detail
page (if visited) shows `No fact-check entries match this post (yet).`

**Guardrail.** [`src/pipeline/retrieve.ts`](../src/pipeline/retrieve.ts)
restricts dense-retrieval candidates to:

```sql
WHERE embedding_model = ?
  AND (lang IN (?, ?) OR lang IS NULL)
```

The two `lang` slots are the post's declared language and the
detected language of the claim text. A French dpa-Faktencheck of
"the earth is flat" is *not* offered as evidence for an English post,
because gemini-class judges flip polarity on translated input far
more often than on same-language pairs (see
[`LANGUAGE_DETECTION.md`](./pipeline/language-detection.md)).

**What to do about it as an operator.** Enable
[`FACTCHECK_API_KEY`](./sources/factcheck-api.md) — the Google Fact Check Tools
API supplements the local pool with live results keyed on the post's
language and frequently closes this gap (Lead Stories, USA Today,
Snopes, AAP and similar English-language publishers are reached via
this path even when they're missing from the bulk feed).

---

## 2. No publisher has reviewed the claim → no label

**Input.** A post making a claim that no allowlisted publisher has
addressed — anywhere, in any language.

**Behaviour.** Verdict `uncovered`. No label on the wire.

**Guardrail.** This is the central design promise: the labeler is a
router, not a judge. It does **not** invent verdicts. The
[`src/pipeline/orchestrator.ts`](../src/pipeline/orchestrator.ts)
path bails out cleanly when retrieval returns zero candidates or
when every candidate is dropped by Stage 3 (rerank) or Stage 4 (NLI).

**What to do about it as an operator.** Nothing — this is the
correct behaviour. If you operate a newsroom that wants to publish
its own verdict, host your own ClaimReview articles and ingest them
via [`OWN_FACT_CHECKS.md`](./sources/own-claimreviews.md); they then become part
of the labeler's pool the same way bulk-feed entries are.

---

## 3. Only one publisher agrees → label is deferred, not auto-emitted

**Input.** A post whose claim matches exactly one allowlisted
publisher's fact-check, with the NLI judge classifying it as
entailing or contradicting (after polarity flip).

**Behaviour.** Verdict computed at confidence ≥ 0.6, but defers to
the operator. With `HITL_MODE=auto` (default policy) or
`HITL_MODE=auto-telegram`, the proposal sits in `decision='defer'`
until the operator hits accept.

**Guardrail.** `HITL_AUTO_MIN_VOTES=2` (default).
[`src/hitl/auto.ts`](../src/hitl/auto.ts) refuses to auto-accept on
fewer than two surviving NLI votes regardless of how confident any
one of them is. A single-source verdict — even from a strong
publisher — gets human attention before it goes on-wire.

**What to do about it as an operator.**

- For unattended deployment: set `HITL_MODE=auto-telegram`. The
  proposal lands in your chat with Accept/Reject/Defer buttons; you
  decide per-claim.
- For a more permissive policy: set `HITL_AUTO_MIN_VOTES=1`. Single-
  source verdicts then auto-emit. Only reasonable on a tightly-
  curated allowlist where each publisher is trusted to make a
  responsible call alone.
- Either way, `pnpm proposal:accept --id=N` is the manual override
  for a single deferred proposal (see
  [`LIFECYCLE.md § Phase 3.5`](LIFECYCLE.md#phase-35--manually-accepting-a-deferred-proposal)).

---

## 4. Publishers disagree → `fact-disputed`, not a guess

**Input.** A post whose claim matches multiple allowlisted publishers
with **conflicting** verdicts (some entailing, some contradicting,
after polarity flips).

**Behaviour.** Verdict `disputed`, label `fact-disputed`. The
underlying disagreement is preserved as the rationale on the detail
page: e.g. *"NLI: 2 entail, 1 contradict, 2 neutral (dropped)"*.

**Guardrail.** [`src/pipeline/normalise-rating.ts`](../src/pipeline/normalise-rating.ts)
treats a publisher split as evidence of genuine disagreement, not as
a signal to pick the majority. The aggregator never silently drops a
publisher's dissenting verdict.

**What to do about it as an operator.** Nothing — `disputed` is the
honest answer. Don't tune the aggregator to "decide" disagreements;
that's the publishers' job.

---

## 5. The post is in a language the labeler hasn't been validated against

**Input.** A post in a language the operator hasn't run the
[`pnpm test:matching`](../src/cli/test-matching.ts) fixture against.

**Behaviour.** The pipeline will still process it (the on-device
language detector covers ~60 languages via [`eld`](./pipeline/language-detection.md)),
but the NLI judge's polarity handling is unverified for that
language. A subtle bug (e.g. an entail/contradict flip on "is not"
constructions) could ship without notice.

**Guardrail.** None automatic — this is a deliberate operator
checkpoint, not a runtime gate. The default
[`LABELER_REPLY_DEFAULT_LANG`](DEPLOY.md#11-configuration-reference)
is `en`; widening it to `de` was preceded by adding cases #13 / #14
to the fixture so regressions are caught.

**What to do about it as an operator.** Before going live in a new
locale: add a handful of fixture cases in that language (one
high-confidence true, one high-confidence false, one direct
negation, one uncovered). Run `pnpm test:matching` until they pass.
Open a PR to upstream them so other deployments inherit the
regression coverage.

---

## If you hit a *different* limitation

If you're seeing the labeler refuse to label something it
*should* label, or label something it *shouldn't*, open an issue
using the [Bug template](../.github/ISSUE_TEMPLATE/bug.yml) with:

- the exact post URI
- the verdict you expected and why
- the verdict the labeler produced (from
  `/posts?uri=...&format=json`)
- the NLI vote split (visible in the same JSON)

The 14-case fixture in
[`test/fixtures/matching-cases.json`](../test/fixtures/matching-cases.json)
is the regression contract; reproducible issues land there as new
cases.
