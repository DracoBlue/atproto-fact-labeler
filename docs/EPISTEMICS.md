# Epistemics: Who Verifies What, On What Basis

> Sister doc to [`COMPONENTS.md`](./COMPONENTS.md) and
> [`PRIOR_ART.md`](./PRIOR_ART.md). Where the others answer "how do we build
> it," this one answers "**what is the system actually claiming, and on whose
> authority?**" — the question a thoughtful end user or partner organisation
> will ask first.

## 0. The headline

**We do not decide what is true.** We decide **who claimed what, when, on
what basis** — and we project that as transparent atproto labels. Every
emitted label is traceable to a (verifier, evidence, time) triple, and
end-users opt in to the labeler like any other moderation service on
atproto.

There are **two separate verification questions**, and conflating them is
the most common epistemic error in this space:

| Question | About | Grounding |
| --- | --- | --- |
| **A. Is the claim correctly extracted from the post?** | Fidelity to the source post | The post text itself |
| **B. Is the claim true?** | Correspondence to the world | External evidence + time |

We treat them as **independent epistemic questions** answered by two
distinct pipeline stages (extraction → verification) in the
[internal data model](./COMPONENTS.md). On the wire they are unified —
**one labeler, one `fact-*` vocabulary** — because end users only care
about the verdict, not the intermediate "was this a checkable claim"
signal. See [`ARCHITECTURE.md §1`](./ARCHITECTURE.md) for the
single-labeler rationale.

---

## 1. Level 1 — Verifying the *extraction* (Question A)

Not about truth. About: **"does the post really claim what we extracted, or
is the LLM hallucinating a claim that isn't there?"**

### 1.1 Verifiers

1. **LLM extractor** (gemma via LM Studio) — emits atomic + decontextualised
   claims with span back to the post text and a confidence score.
2. **Confidence gate** — high → auto-accept; low → reviewer queue.
3. **Human reviewer** in Argilla UI — accepts, edits, or rejects.
4. **Cross-annotator agreement** — Krippendorff's α tracked between
   reviewers; disagreement triggers guideline revision.

### 1.2 Basis

The post text itself, plus the **span anchor** in the claim record. Nothing
external. If the post says "X is dead" with a `?` we mark
`is_falsifiable=false`. If the post quotes someone else, the extracted claim
records that the *quoted source* makes the assertion, not the post author.

### 1.3 What this level cannot tell you

Whether the claim is true. That's Level 2.

---

## 2. Level 2 — Verifying the *verdict* (Question B)

Truth is **time-dependent**, **source-dependent**, and sometimes **disputed**
between credible sources. The system reflects that — it doesn't paper over
it.

### 2.1 Verifier categories

#### 2.1.1 Automatic — RAG-LLM against an evidence corpus

- **Knowledge bases** (see [`COMPONENTS.md` §2.2](./COMPONENTS.md#22-ai-support--retrieve-and-generate)):
  - **Wikidata** — stable entities, dates, deaths, offices held.
  - **Wikipedia snapshot** — general world knowledge.
  - **News corpus** (GDELT / licensed feed) — recent events.
  - **ClaimReview / Google Data Commons feed** — claims IFCN signatories
    have already fact-checked.
  - **Live web search** as gated fallback.
- The LLM reads claim + retrieved evidence → emits `verdict` + `rationale` +
  `valid_at` + `confidence`.
- **AVeriTeC gate**: a verdict only counts when retrieved evidence passes a
  quality threshold (Q+A METEOR ≥ 0.25). Bad evidence + confident LLM →
  the verdict is rejected at the gate, not promoted.

#### 2.1.2 External fact-check feeds (direct passthrough)

- If a **ClaimReview** record from an IFCN signatory (Snopes, PolitiFact,
  dpa-Faktencheck, AFP, Full Fact, etc.) already covers the same claim, the
  verdict is **imported with attribution**.
- We do **not** independently re-check IFCN signatories' work. We
  reference them.

#### 2.1.3 Human reviewer in the Ozone UI

- Reviewer sees: claim (atomic + decontextualised), ranked evidence with
  source links, suggested verdict + rationale.
- Actions: confirm, override verdict, edit `valid_at`, add evidence, reject
  with reason tag.
- Escalation rules push to HITL automatically when any of:
  - Verdict confidence below threshold.
  - Evidence-quality estimate below threshold (even if verdict is
    confident — see AVeriTeC pattern).
  - Evidence sources contradict each other.
  - Claim category is high-stakes (health, elections, named individuals).
  - `valid_at` is within the last N days (time-sensitive).

#### 2.1.4 Multi-reviewer quorum for high-stakes claims

- Default: 1 reviewer for low-stakes, **2-of-3 quorum** for high-stakes.
- Expert verifier roles per domain (medicine, law, finance) — domain
  routing in the queue.

### 2.2 What each verdict carries

Every `verdict` record persists, at minimum:

- `verifier_id` — which human user, which model build, or which external
  feed produced it.
- `verifier_kind` — `model` | `human` | `feed` | `quorum`.
- `verified_at` — when the verification happened.
- `valid_at` — the point in time the verdict applies to. Distinct from
  `verified_at`.
- `evidence_ids[]` — first-class persisted evidence records with source
  URLs, snippets, retrieval method, retrieval timestamp.
- `rationale` — text justification grounded in cited evidence (RAG
  pipelines require the rationale to quote retrieved evidence; rationales
  that reference text not in the evidence pool are rejected).
- `confidence` — and an `evidence_quality_estimate` — both tracked
  separately because the AVeriTeC pattern showed they cannot be collapsed.

### 2.3 Why `valid_at` and `verified_at` are separate

A claim like *"X is dead"* is true from a specific date onward. A reviewer
verifying it **today** is making a statement valid **as of today** — but if
they're reading a death announcement from yesterday, `valid_at = yesterday`.

If X actually died this morning between two verifications:

- The old verdict (`valid_at = T-1day`, `verdict = false`) **is not
  deleted**.
- A new verdict (`valid_at = today`, `verdict = true`) is appended.
- Label projection uses the most recent applicable verdict.

Old verdicts remain queryable. This is what makes auditability honest
rather than retrofitted.

---

## 3. Disagreement — what `disputed` means

Multiple competing verifiers can produce competing verdicts. The system
does not force consensus.

- **Aggregation rule** (v1, simple): if ≥ 2 verifiers of comparable kind
  disagree above a threshold, the emitted label becomes **`disputed`**
  rather than a hard `true` / `false`.
- The label projection points at *all* relevant verdicts, so a client can
  show "PolitiFact says X, our reviewer says Y" rather than picking a
  winner.
- (Future work — see [`PRIOR_ART.md §7.2`](./PRIOR_ART.md#72-community-notes-bridging-based-matrix-factorization):
  Community Notes' bridging-based matrix factorisation as a structured way
  to score reviewer disagreement. Not in v1.)

---

## 4. What we are explicitly **not** claiming

- We are **not the arbiter of truth.** atproto's stackable moderation
  model is designed so users opt into labelers they trust. We are one
  such labeler.
- We are **not replicating** IFCN signatories' editorial judgment. When we
  surface their verdicts, we attribute them.
- We are **not** publishing a verdict without a traceable basis. No
  verdict ships without `evidence_ids[]` populated.
- We are **not** emitting hard verdicts for inherently contested or
  opinion-laden claims. Such posts produce extracted claims with
  `is_falsifiable=false` at Level 1 and never enter Level 2.

---

## 5. What the end user sees

In a Bluesky client that subscribes to this labeler:

- A post may carry an inform-severity label like
  `fact-check:supported` / `:refuted` / `:disputed` / `:unknown`.
- Clicking the label reveals the **provenance card**: verifier, evidence
  links, `valid_at`, rationale.
- The user can unsubscribe at any time. atproto labels are opt-in.

This is the entire honesty mechanism: **transparency over authority.**

---

## 6. Failure modes we accept

- **Stale verdicts**: a fact changes faster than re-verification.
  Mitigated by `valid_at` + re-verification cadence, not eliminated.
- **Adversarial framing**: a post phrased to evade extraction (irony,
  rhetorical questions). Mitigated by conservative atomicity at Level 1,
  not eliminated.
- **Source bias**: knowledge bases (Wikidata, Wikipedia, IFCN signatories,
  news corpora) reflect their own selection biases. Mitigated by surfacing
  provenance, not eliminated.
- **Reviewer bias**: HITL reviewers bring their own biases. Mitigated by
  IAA tracking + (future) bridging-based aggregation, not eliminated.

We log all four, and we don't pretend otherwise.

---

## 7. One-paragraph summary for partners / press

> The atproto-claim-labeler does not decide what is true. It extracts
> falsifiable claims from Bluesky posts, retrieves evidence from open
> knowledge bases and existing fact-check feeds, proposes verdicts using
> a retrieval-augmented LLM under a strict evidence-quality gate, and
> routes uncertain or high-stakes cases to human reviewers. Every emitted
> label cites its verifier, its evidence, and its time of validity. End
> users opt in to the labeler on Bluesky like any other moderation
> service. When credible sources disagree, the label says **disputed** and
> shows both — instead of picking a winner.
