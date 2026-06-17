# Research: Claim Verification on atproto & the Fediverse

> Companion to [`PRIOR_ART.md`](./PRIOR_ART.md). Where that document
> covers the wider fact-checking literature and HITL tooling, this one
> covers **how atproto and the Fediverse expose label / annotation
> infrastructure** — protocol surfaces, existing labelers, and the
> ClaimReview interop standard.

## TL;DR

Bluesky / atproto provides a robust protocol-level mechanism for claim
and fact-check labelling via its **stackable moderation** system: any
third party can run a Labeler service that implements two endpoints
(`com.atproto.label.subscribeLabels`, `com.atproto.label.queryLabels`),
defines custom labels with configurable severity, blur, defaults, and
localisation, and signs labels with a `secp256k1` key tied to a service
DID.

Existing labelers in the ecosystem largely focus on **identity /
credential verification** (e.g., ATProtoApps' community labeler for
games journalists) rather than **content fact-checking**. This is the
gap our project targets.

Self-labelling **cannot** be used for arbitrary fact-checks (only a
small fixed global set is honoured), so a fact-check system must be
implemented as a third-party labeler service.

On the Fediverse / ActivityPub side, fact-checking work centers on the
W3C **ActivityPub Trust & Safety Taskforce** exploring the **Web
Annotation Protocol**, **shared blocklists** as community labelling
infrastructure, and the well-established **Schema.org ClaimReview**
standard — providing a natural interop schema that an atproto claim
labeler can map into. Our current ingest path uses the **Google Data
Commons Fact Check feed**, which is ClaimReview-formatted JSON.

## atproto / Bluesky

### Stackable moderation & the Labeler protocol

Bluesky's moderation architecture is explicitly stackable: independent
third-party labeler services layer on top of default moderation. Any
party can operate a Labeler by implementing two atproto endpoints:

- `com.atproto.label.subscribeLabels` — WebSocket stream that
  distributes new labels.
- `com.atproto.label.queryLabels` — point-in-time lookup.

Labels support:

- Custom identifiers with configurable **severity** (`inform` / `alert`).
- **Blur** settings.
- Default preferences (`hide` / `warn` / `ignore`).
- Localised names and descriptions.
- Purpose categories: `informational`, `topical`, `curational`,
  `moderational`.

A fact-check / claim labeler naturally maps to **severity = `inform`**,
**purpose = `informational`**. Our `fact-supported` / `fact-refuted` /
etc. vocabulary follows this pattern.

Sources:
- <https://bsky.social/about/blog/03-12-2024-stackable-moderation>
- <https://docs.bsky.app/blog/blueskys-moderation-architecture>
- <https://atproto.com/specs/label>

### Ozone — the canonical labeler implementation

**Ozone** is Bluesky's official open-source, self-hostable labeler
service: a Next.js web UI + backend + Postgres. It handles report
intake, custom label creation, and label issuance on both accounts and
content.

Operational facts:

- Labels are signed with a `secp256k1` private key.
- Distribution is via the `subscribeLabels` WebSocket stream.
- Each moderation service has a long-term service DID with a distinct
  label-signing key indicated in its DID document.
- Labels carry `exp` (expiration timestamp) and `sig` (signature) fields
  per the updated Lexicon schema.

Setup for a real Ozone deployment requires a dedicated account for the
labeler, PLC-directory registration as a moderation service, and
publishing an `app.bsky.labeler.service` record so clients discover it.
See [`LIFECYCLE.md`](./LIFECYCLE.md) for the going-live walkthrough as it
applies to this project.

Sources:
- <https://github.com/bluesky-social/ozone>
- <https://github.com/bluesky-social/ozone/blob/main/HOSTING.md>
- <https://atproto.com/guides/using-ozone>
- <https://github.com/bluesky-social/atproto/discussions/2293>

### Why self-labelling is not a fact-check path

atproto only honours a small fixed set of global self-labels:
`porn`, `sexual`, `gore`, `nudity`, `bot`, `!no-unauthenticated`.

Arbitrary claim / fact labels **must** come from a third-party labeler
service. The record format technically permits arbitrary strings; the
restriction is enforced by AppView client behaviour.

Sources:
- <https://github.com/snarfed/self-labeler>
- <https://atproto.com/specs/label>

### Existing labelers — and the content fact-check gap

Prominent labelers in the ecosystem focus on **identity / credentials**
of accounts, not content claims. Example:
**ATProtoApps' `atproto-community-labeler`** assigns labels like
*Game Dev*, *Games Journalist*, *Games Publisher* via manual maintainer
review of external evidence (Muck Rack, personal sites, Twitter /
LinkedIn).

No prominent atproto labeler is doing content-level fact-checking. This
is the gap our project targets.

Source:
- <https://github.com/ATProtoApps/atproto-community-labeler>

### Open Community Notes — closest atproto prior art

**`johnwarden/open-community-notes`** (v0.1.1 draft) is a draft AT
Protocol specification for proposing, rating, scoring, and serving
community-authored annotations on Bluesky posts using custom lexicon
records. Authored by John Warden (Social Protocols). Status: **draft
only, no production implementation observed**.

Source: <https://github.com/johnwarden/open-community-notes>

Additional design-space reading:
- <https://quilling.dev/blog/atproto-labels/>
- <https://bnewbold.leaflet.pub/3me3ea64bhk26>
- <https://leaflet.pub/bef6e8fe-d968-4b6e-bb70-a85f242103dd>

### Margin.at — open annotation layer on atproto

**Margin** (<https://margin.at>) is a free / open-source browser
extension and **open annotation layer for the web, built on the AT
Protocol**: users highlight text, leave notes, and bookmark pages, with
annotations stored on the user's decentralised identity (their PDS) as
atproto records.

Why this matters for the claim-labeler:

- **Adjacent live prior art on atproto** — closest atproto-native
  project to claim annotation. Their record shape for "annotation
  targeted at a URL + text span" is a natural reference for our claim
  records' "span back to source" field, and shows the Web Annotation
  Data Model semantics are viable on atproto today.
- **Annotations on the author's PDS** is a pattern we could inherit for
  crowd-sourced *claim proposals* (separate from emitted *labels*, which
  live on the labeler's signing identity).
- **Cross-protocol potential**: same underlying Web-Annotation semantics
  as the ActivityPub work below, so a margin.at ↔ ActivityPub
  annotations-service bridge is on the table.

Open follow-ups (not surfaced — verify before relying):

- Lexicon namespace (e.g. `at.margin.*` / `app.margin.*`) and exact
  field shape of an annotation record.
- Operator / maintainer identity, licence, source-repo location
  (suspected on **tangled.org**, atproto-native code hosting).
- Visibility model — public-by-default vs. scoped.

Sources:
- <https://margin.at>
- <https://margin.at/about>

## Fediverse / ActivityPub

### Web Annotation Protocol — the leading approach

The W3C **ActivityPub Trust & Safety Taskforce** is actively exploring
annotation mechanisms for Fediverse fact-checking. Approach:

- Use the **Web Annotation Data Model + Web Annotation Protocol**.
- An `Annotation` object can be POSTed to an actor's outbox; the server
  wraps it in a `Create` activity per ActivityPub § 6.2.1. No new
  ActivityPub extension required.
- Experimental implementation:
  **`ThisIsMissEm/annotations-service`** (AdonisJS), using
  `sha256(Object ID)` as the annotation collection ID for easy lookup of
  annotations on a given object.

**Caveat**: Mastodon does not implement client-to-server (C2S), which
limits practical deployment to servers that support C2S (some
Pleroma/Akkoma forks, Smithereen, custom implementations).

Sources:
- <https://lists.w3.org/Archives/Public/public-swicg/2025Jan/0070.html>
- <https://github.com/ThisIsMissEm/annotations-service>

### Shared blocklists as community labelling infrastructure

Shared Fediverse blocklists function as community labelling /
moderation infrastructure analogous to atproto labelers:

- **Seirdy Tier-0**
- **FediNuke**
- **Garden Fence**
- **CARIAD**
- **IFTAS-DNI**

They use consensus-based inclusion criteria with variable transparency,
English-language bias, and acknowledged subjectivity.

Sources:
- <https://arxiv.org/html/2506.05522v1>
- <https://seirdy.one/posts/2023/05/02/fediverse-blocklists/>
- <https://gardenfence.github.io>
- <https://cariad.fedicheck.iftas.org/login>

### Moderator design requirements

Fediverse moderators have articulated concrete design needs for shared
labelling / annotation systems — useful UX requirements for any atproto
claim labeler:

- Category filters.
- Severity toggles.
- Comment-based documentation.
- Collaborative voting mechanisms.
- Multilingual support.
- Detailed moderation "receipts" for transparency.

Source: <https://arxiv.org/html/2506.05522v1>

## Interop: Schema.org ClaimReview

**Schema.org `ClaimReview`** is the dominant interoperable fact-check
vocabulary: a structured-data type for "a fact-checking review of claims
made in some creative work." Adopted by:

- **IFCN signatories**: PolitiFact, Snopes, FactCheck.org, Full Fact,
  AFP Fact Check, CORRECTIV, dpa-Faktencheck.
- **Platforms**: Google Search/News, Bing, Facebook.

Stable since ~2016.

**Google Data Commons Fact Check feed** publishes a real-time JSON
DataFeed of ClaimReview markups — directly ingestible as a source for an
atproto claim labeler to label posts referencing previously fact-checked
claims. **This is what we ingest today** — see
[`LICENSING.md`](./LICENSING.md) for the licensing of the corpus and the
mapping from publisher-native ratings to our internal verdict
vocabulary.

Sources:
- <https://schema.org/ClaimReview>
- <https://blog.schema.org/2021/12/09/the-art-of-connection/>
- <https://developers.google.com/search/docs/appearance/structured-data/factcheck>
- <https://datacommons.org/factcheck/download>
- <https://www.poynter.org/fact-checking/2026/what-is-claimreview-fact-checking/>

## Gaps & opportunities

1. **Content-level fact-check labeling is greenfield on atproto.** All
   major existing labelers do identity / credentials or moderation —
   nobody is doing content fact-checking seriously. This project fills
   that gap.
2. **ClaimReview → atproto label mapping** had no canonical proposal
   before this project. The mapping
   (URL / claim / rating → `fact-supported` / `fact-refuted` / ...) is
   documented in [`LICENSING.md`](./LICENSING.md) §
   "Internal verdict vocabulary" and worth proposing upstream as a
   reusable lexicon.
3. **Data Commons ClaimReview feed ingestion** for automated matching of
   posts against known fact-checks is the **shipped ingest path** in
   `src/ingest/claimreview-feed.ts`. URL-first matching has been
   superseded by dense + NLI matching — see
   [`PIPELINE.md`](./PIPELINE.md).
4. **Open Community Notes** is a draft spec with no production
   implementation. Could be a target for a future "user-proposed claim"
   layer that bridges to our labeler engine.
5. **Cross-protocol bridge** between ActivityPub Web Annotations and
   atproto labels is completely unexplored.

## Caveats

- **Time-sensitive**: atproto label spec and Ozone have evolved rapidly
  (`sig` / `exp` fields added in 2024). Re-verify lexicon field details
  against <https://atproto.com/specs/label> before implementation.
- **Coverage of non-English atproto labelers may be incomplete** —
  research focused on the English-language ecosystem.
- The "gap" finding (no content fact-check labelers on atproto) is an
  **absence-of-evidence** claim and could miss small or recent projects.
- `ThisIsMissEm/annotations-service` is an **experimental personal
  project**, not an officially blessed W3C reference implementation.
- ClaimReview adoption stats reflect the **search-engine ecosystem**,
  not necessarily Fediverse-native fact-check tooling.
- The self-labelling restriction is enforced by **AppView client
  behaviour**; technically the record format permits arbitrary strings,
  so behaviour could shift if AppView policy changes.

## Open questions

- Are there production atproto labelers specifically doing content-level
  fact-checking (not identity) that we missed — e.g., regional /
  non-English labelers, or labelers run by news organisations or IFCN
  signatories?
- Has the Open Community Notes draft (johnwarden) progressed beyond
  v0.1.1, and is anyone implementing it against a live Ozone instance or
  custom labeler backend?
- What is the current state of Mastodon / Akkoma support for the Web
  Annotation Protocol via client-to-server, and are any production
  fact-check bots using it instead of the more common reply-bot pattern
  (e.g., `@factcheck` mention bots)?
- Is the ClaimReview → atproto label mapping documented in
  [`LICENSING.md`](./LICENSING.md) worth a public RFC against
  [`@atproto/lexicon`](https://github.com/bluesky-social/atproto)?

## Sources

| URL | Quality | Topic |
| --- | --- | --- |
| <https://bsky.social/about/blog/03-12-2024-stackable-moderation> | primary | atproto labeler ecosystem |
| <https://docs.bsky.app/blog/blueskys-moderation-architecture> | primary | atproto labeler ecosystem |
| <https://github.com/bluesky-social/ozone> | primary | Ozone repo |
| <https://github.com/bluesky-social/ozone/blob/main/HOSTING.md> | primary | Ozone hosting |
| <https://atproto.com/guides/using-ozone> | primary | atproto Ozone guide |
| <https://atproto.com/specs/label> | primary | label spec |
| <https://github.com/bluesky-social/atproto/discussions/2293> | primary | label sig/exp discussion |
| <https://github.com/snarfed/self-labeler> | primary | self-labeling boundary |
| <https://github.com/ATProtoApps/atproto-community-labeler> | primary | identity-labeler example |
| <https://github.com/johnwarden/open-community-notes> | primary | Open Community Notes draft |
| <https://bnewbold.leaflet.pub/3me3ea64bhk26> | primary | design-space reading |
| <https://quilling.dev/blog/atproto-labels/> | blog | design-space reading |
| <https://leaflet.pub/bef6e8fe-d968-4b6e-bb70-a85f242103dd> | blog | Bluesky community notes / annotation |
| <https://margin.at> | primary | Margin — atproto annotation layer |
| <https://margin.at/about> | primary | Margin about |
| <https://lists.w3.org/Archives/Public/public-swicg/2025Jan/0070.html> | primary | W3C T&S Taskforce — annotations |
| <https://github.com/ThisIsMissEm/annotations-service> | primary | ActivityPub annotation impl |
| <https://arxiv.org/html/2506.05522v1> | primary | Fediverse moderation research |
| <https://seirdy.one/posts/2023/05/02/fediverse-blocklists/> | primary | shared blocklists |
| <https://gardenfence.github.io> | primary | Garden Fence blocklist |
| <https://cariad.fedicheck.iftas.org/login> | primary | CARIAD / IFTAS-DNI |
| <https://schema.org/ClaimReview> | primary | ClaimReview spec |
| <https://blog.schema.org/2021/12/09/the-art-of-connection/> | primary | ClaimReview context |
| <https://developers.google.com/search/docs/appearance/structured-data/factcheck> | primary | Google fact-check structured data |
| <https://datacommons.org/factcheck/download> | primary | Data Commons fact-check feed |
| <https://www.poynter.org/fact-checking/2026/what-is-claimreview-fact-checking/> | secondary | ClaimReview overview |
| <https://asml.cyber.harvard.edu/2024/10/25/fediverse-observer/> | primary | Fediverse credibility |
| <https://arxiv.org/html/2408.15383v1> | primary | Fediverse credibility |
