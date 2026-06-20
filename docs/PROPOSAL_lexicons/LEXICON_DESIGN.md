# Lexicon design — `app.kiesel.facts.*`

> **Status:** Draft / Proposal. Not yet implemented. Not yet served from
> any PDS. Reviewers welcome via GitHub issues on
> [atproto-fact-labeler](https://github.com/DracoBlue/atproto-fact-labeler).

This document proposes two atproto record types for publishing
fact-check data and labeler verdicts as first-class atproto records.
Both schemas live alongside this doc as JSON Lexicon files:

- [`lexicons/app/kiesel/facts/claimReview.json`](../../lexicons/app/kiesel/facts/claimReview.json)
- [`lexicons/app/kiesel/facts/claimVerdict.json`](../../lexicons/app/kiesel/facts/claimVerdict.json)

## Why two separate records

Today the project surfaces verdicts via two channels: an on-wire
Bluesky label (`com.atproto.label.defs#label` with `val=fact-*`) and
an HTML detail page (`/posts?uri=…`). The detail page is the only
machine-readable form of the structured evidence — and it lives in
our SQLite, not on atproto. Nothing in the ecosystem can discover
*our* verdicts without crawling our HTTP endpoint.

That gap matters because two distinct actors want to publish to
atproto and currently can't:

| Actor | What they publish | Schema.org analogue |
|---|---|---|
| **Fact-checker** (CORRECTIV, dpa, Full Fact, …) | "I reviewed this claim and rated it False." | [`ClaimReview`](https://schema.org/ClaimReview) |
| **Labeler** (this project, others) | "Given these N reviews from publishers, my aggregated verdict on this specific Bluesky post is X." | (no canonical schema.org equivalent) |

These are **not the same thing.** Conflating them as a single
`claimReview` record — as my first sketch did — leaves a reader
unable to distinguish a publisher's primary review of a claim from a
labeler's downstream aggregation of multiple reviews against one
specific record. So this proposal splits them:

- **`app.kiesel.facts.claimReview`** — a publisher record. Mirrors
  `schema.org/ClaimReview` field-for-field. Lets fact-checkers move
  their JSON-LD onto atproto without losing semantic structure.
- **`app.kiesel.facts.claimVerdict`** — a labeler record. References
  the labeled atproto record via `subject` (strongRef) and the
  evidence it relied on via `evidence[]`. Each evidence item either
  references an atproto `claimReview` (when the publisher is on
  atproto) or carries an inline `externalSource` (today's typical
  case — most publishers only publish to the web).

The two records can coexist on the same PDS or live on completely
different PDSes. A labeler can cite a publisher's atproto-hosted
claimReview by URI; the publisher and the labeler stay
organisationally separate.

## Field mapping vs schema.org/ClaimReview

| schema.org/ClaimReview | `app.kiesel.facts.claimReview` | Notes |
|---|---|---|
| `claimReviewed` | `claimReviewed` | 1:1 |
| `reviewRating.alternateName` | `reviewRating.alternateName` | 1:1, the free-text verdict |
| `reviewRating.ratingValue`, `bestRating`, `worstRating` | same | 1:1, numeric scale where present |
| `author.name`, `url` | `author.name`, `url` | 1:1 |
| `author` (when on atproto) | `author.did` | atproto extension, points at the publisher's DID |
| `datePublished` | `datePublished` | 1:1 |
| `inLanguage` | `inLanguage` | BCP-47 |
| `itemReviewed.author` | `itemReviewed.author` | claim provenance |
| `url` | `url` | The publisher's article URL |
| `sdLicense` | `sdLicense` | 1:1 |
| — | `subject` (strongRef) | atproto extension — optionally pin the claim to a specific atproto record where it appeared |

The `subject` field is the key atproto extension: when a publisher
reviews a claim that *originally appeared as a Bluesky post*, they
can pin the review to that post. Constellation then makes the
review discoverable by anyone querying "which fact-checks address
this post?" — without our labeler in the middle.

## What `claimVerdict.evidence[]` looks like in practice

Today, almost every cited fact-check is web-only:

```jsonc
{
  "$type": "app.kiesel.facts.claimVerdict",
  "subject": {
    "uri": "at://did:plc:7xlshkxpjrshetcx246a53yx/app.bsky.feed.post/3mois5vfgfk26",
    "cid": "bafy…"
  },
  "claimText": "the earth is round.",
  "decontextualizedText": "The Earth is round.",
  "verdict": "supported",
  "confidence": 0.826,
  "voteBreakdown": { "entail": 0, "contradict": 2, "neutral": 3 },
  "evidence": [
    {
      "polarity": "contradict",
      "intakePath": "factcheck-api",
      "attribution": "Fact-checked by Full Fact. Sourced via Google Fact Check Tools API.",
      "externalSource": {
        "publisherName": "Full Fact",
        "publisherSite": "fullfact.org",
        "publisherUrl": "https://fullfact.org/",
        "sourceUrl": "https://fullfact.org/online/earth-is-spherical-not-flat/",
        "claimReviewed": "The Earth is flat.",
        "ratingNative": "We have abundant evidence going back thousands of years that the Earth is roughly spherical.",
        "reviewDate": "2023-03-03T00:00:00Z",
        "lang": "en"
      }
    },
    {
      "polarity": "contradict",
      "intakePath": "factcheck-api",
      "attribution": "Fact-checked by USA Today. Sourced via Google Fact Check Tools API.",
      "externalSource": {
        "publisherName": "USA Today",
        "publisherSite": "usatoday.com",
        "sourceUrl": "https://www.usatoday.com/story/news/factcheck/2022/11/17/fact-check-ample-evidence-earth-round-and-rotating/8267678001/",
        "ratingNative": "False",
        "reviewDate": "2022-11-17T22:41:35Z",
        "lang": "en"
      }
    }
  ],
  "rationale": "Aggregated from 2 fact-check(s); agreement=0.5. NLI: 0 entail, 2 contradict, 3 neutral (dropped). Both publishers contradict the symmetric flat-earth framing; polarity-flip yields 'supported'.",
  "verifiedAt": "2026-06-19T19:49:50Z",
  "validAt": "2023-03-03T00:00:00Z",
  "emittedLabel": "fact-supported",
  "labelUri": "at://did:plc:7elfhdwxzvsqib4wmfn3zra7/com.atproto.label.defs/…"
}
```

When (or if) CORRECTIV starts publishing `app.kiesel.facts.claimReview`
records to their PDS, the `evidence[]` item would shift to:

```jsonc
{
  "polarity": "contradict",
  "intakePath": "self-published",
  "attribution": "Fact-checked by CORRECTIV.",
  "claimReview": {
    "uri": "at://did:plc:correctiv-org/app.kiesel.facts.claimReview/3kxx",
    "cid": "bafy…"
  }
}
```

No labeler change needed beyond the `intakePath` switch — the
labeler discovers the publisher's record via Constellation, looks it
up, and cites it by URI. The publisher controls the record (can
correct it, can supersede it); we just point.

## Discoverability via Constellation

[Constellation](https://constellation.microcosm.blue/) indexes
atproto records by `(collection, json-path, target)`. Two backlink
queries this proposal enables:

```
# All labeler verdicts on a specific Bluesky post:
GET /links?
  target=at://did:plc:.../app.bsky.feed.post/3mois5vfgfk26
  &collection=app.kiesel.facts.claimVerdict
  &path=.subject.uri

# All publisher reviews of a specific claim that pinned to that post:
GET /links?
  target=at://did:plc:.../app.bsky.feed.post/3mois5vfgfk26
  &collection=app.kiesel.facts.claimReview
  &path=.subject.uri

# All labeler verdicts that cite a specific publisher review:
GET /links?
  target=at://did:plc:correctiv-org/app.kiesel.facts.claimReview/3kxx
  &collection=app.kiesel.facts.claimVerdict
  &path=.evidence[].claimReview.uri
```

The federation pattern is concrete: another labeler organisation
(an IFCN signatory, an NGO, a newsroom's verification desk) can
publish under their own NSID (`app.example.facts.claimVerdict`)
with the same field layout. A consumer client can issue parallel
Constellation queries across `claimVerdict` collections and
present users with *all* labeler verdicts on a given post — no
central labeler-of-labelers needed.

## NSID choice

`app.kiesel.facts.*` is chosen because:

- `app.*` is the conventional prefix for user-facing applications
  in atproto. Matches `app.bsky.*`, `app.whtwnd.*` etc.
- `kiesel` is the operator's domain root (`kiesel.app`), the
  authority chain atproto NSIDs follow.
- `facts` is short and descriptive of the lexicon family.

This proposal **does not** plan to migrate to `community.lexicon.*`
later. As discussed in
[CONTRIBUTING § Areas where contributions will probably be declined](../../CONTRIBUTING.md),
record collections are effectively immutable once published; renaming
breaks existing records. The atproto convention has converged on
"keep your own NSID forever; community.lexicon.* is for designs that
land there from day one."

If the same semantics gain adoption beyond this project, the right
pattern is **other projects implementing the same shape under their
own NSIDs**, not us renaming. The lexicons in this repo are designed
to be *copyable* — fork the JSON, change the `id` field, run.

## Hosting & resolution

atproto **already specifies** how Lexicons are published and
resolved — see
[`atproto.com/specs/lexicon#lexicon-publication-and-resolution`](https://atproto.com/specs/lexicon#lexicon-publication-and-resolution).
The spec-canonical path has two pieces:

1. **The schema lives as a `com.atproto.lexicon.schema` record** in
   an atproto repository owned by the *authority* of the NSID. For
   `app.kiesel.facts.claimReview` the authority is `kiesel.app`, so
   the schema record lives in a repo we control.
2. **A DNS TXT record at `_lexicon.kiesel.app`** points at the DID
   that owns the schema record. Resolvers fetch the TXT, look up
   the DID's atproto repo, retrieve the
   `com.atproto.lexicon.schema` record with rkey matching the NSID.

That's the load-bearing path. Anyone with the NSID in hand can
reach the schema without depending on GitHub navigation or this
project's HTTPS endpoint going down.

In practice, three publication surfaces; we host all three because
they cost almost nothing once one of them works:

1. **Authoritative — DNS + atproto record.**
   - DNS TXT: `_lexicon.kiesel.app  IN TXT  "did=did:plc:7elfhdwxzvsqib4wmfn3zra7"`
     (the labeler's existing DID works; a dedicated authority DID
     is fine if separation matters later).
   - atproto record: `createRecord` with
     `collection=com.atproto.lexicon.schema`, `rkey=app.kiesel.facts.claimReview`
     (and one for `claimVerdict`), record body = the JSON files
     under [`lexicons/`](../../lexicons/).
2. **In this repo** at `lexicons/app/kiesel/facts/*.json` — the
   schemas as code, version-controlled, diffable in PRs. Matches
   the layout `@atproto/lex` and `bluesky-social/atproto` use, and
   is the source the atproto records are populated from.
3. **HTTP courtesy mirror** at
   `https://facts.kiesel.app/lexicons/<nsid>.json` — not part of
   the spec, just a convenience for humans browsing. Small
   read-only Fastify route alongside the existing `/posts` handler.

The DNS + atproto-record path is the only one downstream tools are
expected to use; the other two exist so humans reading docs / code
get to the same JSON.

## Architecture — atproto records are canonical

The atproto record is **not** a press-release export of an internal
canonical SQLite row. It **is** the canonical representation of an
accepted verdict. The labeler's own detail page reads it back via
`com.atproto.repo.getRecord` and renders from there — exactly what
every other consumer of our labeler does. We eat our own dog food.

This decision has concrete consequences for the storage layer:

### What stays in SQLite

| Table | Why it stays |
|---|---|
| `claim_review` | Source-of-truth library for retrieval (Stage 1). Holds embeddings + publisher metadata for ~88 k entries. Not a publication target — the *publishers* own this content, we cite it. |
| `post_cache` | Local cache of fetched Bluesky posts. Avoids hammering the AppView. |
| `claim` | Extracted atomic claims. Intermediate state between extract and publish. |
| `proposal` | Operator-internal workflow state: trigger reason, HITL decision, decided-by, decided-at. Plus the **`evidence_snapshot`** JSON column (new — see below). |
| `verdict` | **Shrinks.** Keeps `id`, `claim_id`, `post_uri`, `status`, `retired_at`, `supersedes`, `verifier_kind`, **`atproto_uri`**, **`atproto_cid`** (the last two new). The public content fields — `label`, `confidence`, `rationale`, `verified_at`, `valid_at` — migrate into the `claimVerdict` record. |
| `label_emit` | Wire-label audit. Needed by `pnpm retire`, `pnpm lifecycle:status`. |
| `feedback`, `mention_reply`, `reply_queue` | Operator-internal: appeals queue, sent replies, retry queue. |

### What goes away

| Table | Fate |
|---|---|
| `evidence` | **Dropped from the steady-state schema.** Evidence rows live inside the `claimVerdict.evidence[]` array on atproto. During the pipeline run, before HITL has decided, the evidence is held as a JSON blob in `proposal.evidence_snapshot` (Option C below). On accept, the snapshot becomes the record's `evidence[]`; on reject/retire, the snapshot is dropped along with the proposal. |

### Pre-decision evidence lives on the proposal (Option C)

Between *pipeline run* and *HITL decision*, evidence has to live
somewhere. Three options were considered:

- **A.** Keep the `evidence` table, populate during pipeline, migrate
  into the record on accept, `DELETE FROM evidence WHERE verdict_id=…`
  afterwards. Two writes per decision; legacy schema lingers.
- **B.** Hold evidence transient in JS memory until accept. No
  table at all. Vulnerable to crash mid-deferral — the proposal
  re-runs cold, costs an extra full pipeline.
- **C.** Persist evidence as a JSON column (`evidence_snapshot`) on
  the `proposal` row. Crash-safe (recovers after restart), no
  evidence table, one INSERT during pipeline + one DELETE on
  decision.

**Picked C.** Crash-safety matters more than the storage delta,
and the proposal row already carries the rest of the in-flight
state.

### What the detail server does

```ts
// Before:
const rows = db.prepare(`
  SELECT v.label, v.confidence, e.publisher, e.source_url, …
    FROM verdict v JOIN evidence e ON e.verdict_id = v.id
   WHERE v.post_uri = ? AND v.status = 'accepted' AND v.retired_at IS NULL
`).all(uri);
renderHtml(rows);

// After:
const row = db.prepare(`
  SELECT atproto_uri FROM verdict
   WHERE post_uri = ? AND status = 'accepted' AND retired_at IS NULL
`).get(uri);
if (!row?.atproto_uri) return renderEmpty();
const record = await atproto.getRecord(row.atproto_uri);
renderHtml(record.value);

// Plus optional Constellation backlinks:
const federated = await fetch(
  `https://constellation.microcosm.blue/links?` +
  `target=${encodeURIComponent(uri)}` +
  `&collection=app.kiesel.facts.claimVerdict&path=.subject.uri`,
).then(r => r.json());
renderFederatedReviews(federated);
```

### What changes on retire

Two writes instead of one:

```
Today:
  insert label_emit (neg=true)
  update verdict set retired_at = now()

After:
  insert label_emit (neg=true)
  update verdict set retired_at = now()
  + putRecord(claimVerdict, { …existing, retiredAt: now })
    OR deleteRecord(claimVerdict)
```

The choice between `putRecord` (keeps a tombstone with
`retiredAt`) and `deleteRecord` (removes the record entirely) is
worth a separate discussion. `putRecord` preserves audit-trail at
the cost of leaving a public "we used to think this" trail.
Default: `deleteRecord` — matches the user-facing intent of
*retract*. Operators who want the tombstone behaviour can flip
a config flag.

## Open questions for review

1. **Should `verdict` be an enum or a string with `knownValues`?**
   The Lexicon language supports both. `knownValues` is more
   forgiving for forward-compat; a fork can add `partial-truth`
   without breaking validation. Current draft uses `knownValues`.
2. **Strong-ref the labeler's emitted label vs free at-uri?**
   `labelUri` is currently a free string for ergonomics — but a
   `com.atproto.label` record doesn't expose a CID the same way a
   post does. Open to feedback.
3. **`evidence[]` cap.** Currently set to `maxLength: 20`. Real
   verdicts cap at ~8 after rerank survival, so 20 is roomy but not
   abusive. Adjust if production data argues otherwise.
4. **Should `decontextualizedText` be required when it differs
   from `claimText`?** Currently optional. Required-when-different
   isn't expressible in Lexicon directly; an implementation
   convention may suffice.
5. **`supersedes` semantics.** Should the older record be a
   pure superseded shadow (consumers ignore it), or should it
   remain visible as audit-trail? Convention vs schema choice;
   currently the schema allows both interpretations.

## Implementation roadmap (accepted)

### Phase 0 — DB migration

- Add `verdict.atproto_uri` and `verdict.atproto_cid` (nullable).
- Add `proposal.evidence_snapshot` TEXT (JSON).
- Stop writing to `evidence` going forward. Existing rows stay so
  pre-migration verdicts can be re-rendered via the dual-read path
  in Phase 4 below.

### Phase 1 — Lexicon publication (one-off)

- DNS TXT: `_lexicon.kiesel.app  IN TXT  "did=did:plc:7elfhdwxzvsqib4wmfn3zra7"`.
- `pnpm lexicons:publish` — CLI that reads the local JSON files and
  writes them as `com.atproto.lexicon.schema` records on the
  labeler's PDS, rkey = NSID. Idempotent (uses `putRecord` so
  re-runs after schema edits update in place).
- Fastify courtesy route at `/lexicons/<nsid>.json` for humans.

### Phase 2 — Pipeline writes the snapshot

- Replace evidence-table writes in `processPost` with a single
  `UPDATE proposal SET evidence_snapshot = ? WHERE id = ?`. The
  snapshot is the JSON exactly as it will appear in the atproto
  record's `evidence[]` array (so the publish step is just
  `record.evidence = snapshot`).

### Phase 3 — onDecision publishes the record

- On accept: build the `claimVerdict` from the proposal's
  `evidence_snapshot` + the claim + the verdict row. `createRecord`
  on the labeler's PDS, store the returned at-uri/cid on the
  verdict row.
- On reject: drop the snapshot, no record published.
- On retire: `deleteRecord` (default) or `putRecord` with
  retiredAt (operator flag).

### Phase 4 — Detail server reads via atproto

- Detail page resolves `atproto_uri` from the verdict row, fetches
  the record, renders. Dual-read fallback to the legacy
  `evidence` JOIN for verdicts that pre-date the migration —
  removed once the historical corpus is backfilled or judged
  irrelevant.
- Constellation backlinks queried in parallel; rendered as
  "Federated reviews" section, initially showing just our own
  record.

### Phase 5 — Backfill (optional)

- `pnpm verdicts:backfill` — for each historical accepted verdict
  in the DB, build the `claimVerdict` from the legacy `evidence`
  rows and `createRecord` it. After backfill, the dual-read path
  in Phase 4 can be removed.

### Phase 6 — Docs

- `OWN_FACT_CHECKS.md` — explain the on-atproto path via
  `app.kiesel.facts.claimReview` alongside the bulk-DataFeed path.
- `ADR_data_sources.md` — add the on-atproto path as Path 4.
- `README.md` + `PIPELINE.md` — mention atproto records as the
  canonical machine-readable output.

Nothing in this plan touches the existing wire-label or the
publisher allowlist or the matching pipeline above Stage 4.

Nothing in this proposal touches the existing pipeline output. The
on-wire Bluesky label and the SQLite-backed detail page remain
exactly as today. The atproto record is *additional* surface, not a
replacement.

## Prior art and references

- [schema.org/ClaimReview](https://schema.org/ClaimReview) — the
  field set we mirror.
- [Bluesky · Custom Schemas](https://docs.bsky.app/docs/advanced-guides/custom-schemas)
  — guidance on shipping under your own NSID.
- [Lexicon Community repo](https://github.com/lexicon-community/lexicon)
  — where future cross-project semantic alignment could live.
- [Constellation](https://constellation.microcosm.blue/) — the
  discoverability layer this proposal builds on.
- [`docs/ADR_data_sources.md`](../ADR_data_sources.md) — why we
  picked the three current intake paths.
- [`docs/PIPELINE.md`](../PIPELINE.md) — the pipeline whose output
  this proposal would also serialise to atproto.
