<!--
Drop-in text for an Issue / Discussion on
https://github.com/lexicon-community/lexicon

Copy from below "BEGIN ISSUE BODY" to the end into the GitHub form.
The title in `Issue title:` goes into the title field.
-->

Issue title: **Proposal: a community lexicon for fact-check claim reviews and labeler verdicts**

---

BEGIN ISSUE BODY

## Context

There's no atproto-native lexicon today for the things fact-checkers
and labelers produce, even though the schema.org world has had
`ClaimReview` for nearly a decade. I've been operating a fact-check
labeler on Bluesky for ~6 weeks ([code](https://github.com/DracoBlue/atproto-fact-labeler),
live at [facts.kiesel.app](https://bsky.app/profile/did:plc:7elfhdwxzvsqib4wmfn3zra7))
and currently route around the gap with two project-internal NSIDs:

- `app.kiesel.facts.claimReview` — a publisher's review of a claim
  (the atproto-native equivalent of [schema.org/ClaimReview](https://schema.org/ClaimReview)).
- `app.kiesel.facts.claimVerdict` — a labeler's aggregated verdict on
  a specific atproto record, citing one or more `claimReview`
  entries (or external publisher URLs when the publisher hasn't
  moved onto atproto).

This issue proposes graduating the same shape — or one improved by
discussion here — into the `community.lexicon.*` namespace so other
projects can adopt it without having to copy a project-private NSID.

## Why two records and not one

`schema.org/ClaimReview` conflates the publisher's review of a claim
with the consumer's aggregation of multiple such reviews. On atproto
the two are written by distinct actors and have different
post-conditions:

| Actor | Writes | Purpose |
|---|---|---|
| **Fact-checker** (CORRECTIV, dpa, Full Fact, Lead Stories, …) | `claimReview` | "I reviewed this claim and rated it X." |
| **Labeler** (this project, future others) | `claimVerdict` | "Given the reviews I found, my verdict on *this specific Bluesky post* is Y." |

Splitting the records lets a labeler cite a publisher's record by
URI (when the publisher is on atproto) or by web URL (when they
aren't), without conflating "primary review" and "downstream
aggregation".

## Why Constellation makes this concretely useful today

[Constellation](https://constellation.microcosm.blue/) indexes any
atproto record's backlinks by `(collection, json-path, target)`.
This means once the two records exist:

- **"Which fact-checkers have reviewed this Bluesky post?"** —
  `?target=at://post&collection=community.lexicon.factcheck.claimReview&path=.subject.uri`
- **"Which labelers have published a verdict on this Bluesky
  post?"** — `?target=at://post&collection=community.lexicon.factcheck.claimVerdict&path=.subject.uri`
- **"Which labelers cite this specific fact-check?"** —
  `?target=at://review&collection=community.lexicon.factcheck.claimVerdict&path=.evidence[].claimReview.uri`

A Bluesky client can fan these out and present a federated view
without a labeler-of-labelers in the middle. That's the discovery
property atproto was supposed to bring to this space; the missing
piece is just the agreed schema.

## Draft schemas

The two JSON files (linked below) implement what I currently use in
production. They are field-for-field comparable to
schema.org/ClaimReview with atproto-native additions:

- `subject` (a `strongRef`) on `claimReview` lets a publisher pin a
  review to the atproto record where the claim originally appeared
  (typically `app.bsky.feed.post`).
- `evidence[]` on `claimVerdict` is a union of `(strongRef to
  claimReview, externalSource web URL + metadata)` — the latter
  covers today's reality where most fact-checkers are still
  web-only.
- `voteBreakdown` captures the NLI-judge counts so consumers can
  apply stricter thresholds than the labeler.
- `polarity` per evidence item records "entail / contradict /
  neutral" — i.e. the labeler's interpretation of how the
  publisher's review relates to the claim being verdicted.

JSON sources:

- [`app.kiesel.facts.claimReview.json`](https://github.com/DracoBlue/atproto-fact-labeler/blob/main/lexicons/app/kiesel/facts/claimReview.json)
- [`app.kiesel.facts.claimVerdict.json`](https://github.com/DracoBlue/atproto-fact-labeler/blob/main/lexicons/app/kiesel/facts/claimVerdict.json)
- Design + rationale: [LEXICON_DESIGN.md](https://github.com/DracoBlue/atproto-fact-labeler/blob/main/docs/PROPOSAL_lexicons/LEXICON_DESIGN.md)

## Why I am not opening a PR yet

The schemas work for my project, but a community lexicon is the
*intersection* of what producers want, not just what one producer
ships. Three open questions where I want to hear how other people
would model this:

1. **Should `verdict` be an enum or a string with `knownValues`?**
   Lexicon supports both; the second is more forgiving for
   forward-compat. Current draft uses `knownValues`.
2. **Should `claimVerdict.subject` be limited to
   `app.bsky.feed.post`, or fully generic?** I have left it
   generic, but a hardened consumer might want a `subjectTypes`
   constraint.
3. **Tombstone vs delete on retire.** Should a retracted verdict
   be a `putRecord` with `retiredAt` (preserves audit-trail) or a
   `deleteRecord` (matches user-facing retract semantics)? My
   current implementation does the latter; happy to change if the
   group prefers the former.

If you've thought about modelling fact-checks or moderation
provenance on atproto, I'd love your read. If the response is
"please open a PR with the schemas as drafted," I'll do that — but
the discussion shape feels more productive given the design
questions.

Cross-references:

- atproto labeling already covers the *yes/no* signal
  (`com.atproto.label.defs#label`). This proposal is about the
  *structured evidence behind the signal*.
- [Discussion #3338 (3rd-party lexicon adoption)](https://github.com/bluesky-social/atproto/discussions/3338)
  argues this kind of cross-namespace work is exactly what the
  protocol was meant to enable.
- [Discussion #3074 (Lexicon Resolution RFC)](https://github.com/bluesky-social/atproto/discussions/3074)
  matters here because the schemas will need to be resolvable for
  cross-project consumption to work.

END ISSUE BODY
