# Path 4 — atproto-native ClaimReview records

Fact-checkers who already operate on atproto can publish their
reviews as **first-class atproto records** under
`app.kiesel.facts.claimReview` on their own PDS instead of (or
alongside) JSON-LD on a website. Records are discovered via
[Constellation](https://constellation.microcosm.blue/) backlinks on
the subject Bluesky post.

This is *additional* to the other three intake paths, not a
replacement. Path 1 (`own-claimreviews.md`) is the right path for
publishers who already have ClaimReview-tagged articles; this path
is the right one when the publisher wants atproto-native record
control (correct, supersede, retire) and cross-labeler
discoverability without going through Google.

## Status

**In progress.** The lexicon schema is defined and published; the
labeler reads them when present. Few fact-checkers publish records
to atproto yet, so this path's effective coverage is small today and
grows as adopters appear.

Lexicons + design rationale live in the spec repo
[`kiesel-app/facts`](https://github.com/kiesel-app/facts) (separate
from the labeler so that other producers and consumers don't take a
labeler dependency).

## Why this path exists

- **Publishers get full record control** — correct, supersede,
  retire, all under their own DID. No JSON-LD-on-website round-trip
  required.
- **Discoverable by other labelers, not just this one.**
  Constellation indexes the records by subject URI, so any labeler
  can query *"which fact-checkers have reviewed this post?"* without
  going through us as a hub.
- **The detail page renders federated reviews.** When other
  labelers publish their own `claimVerdict` records, our detail
  page surfaces them under a *Federated reviews* heading via
  Constellation backlinks.

## How to publish

See the spec repo's docs. The short version: write
`com.atproto.repo.createRecord` against
`collection=app.kiesel.facts.claimReview`. One record per claim,
with a `subject` strongRef to the Bluesky post the claim originally
appeared on.

The labeler's own producer side (`claimVerdict` records, written on
every accepted verdict) is the reference implementation — see
[`src/labels/publish-claim-verdict.ts`](../../src/labels/publish-claim-verdict.ts)
and [`src/labels/atproto-verdict.ts`](../../src/labels/atproto-verdict.ts).

## See also

- [`kiesel-app/facts`](https://github.com/kiesel-app/facts) — the
  schema repo (lexicon JSON, design doc, publish CLI).
- [`../adr/data-sources.md`](../adr/data-sources.md) — the four
  intake paths and what each one solves.
- [`./own-claimreviews.md`](./own-claimreviews.md) — Path 1, the
  JSON-LD-on-website alternative for publishers not on atproto.
