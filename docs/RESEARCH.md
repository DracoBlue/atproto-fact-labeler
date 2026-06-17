# Research: Claim Verification & Fact-Checking on atproto and the Fediverse

> Prior-art and design-space survey for the `atproto-claim-labeler` project.
> Compiled 2026-06-15 from a multi-source, adversarially-verified web research pass
> (22 sources fetched, 84 claims extracted, 25 claims verified 3-vote, 0 refuted).

## TL;DR

Bluesky/atproto provides a robust protocol-level mechanism for claim and fact-check
labeling via its **stackable moderation** system: any third party can run a Labeler
service (typically using Bluesky's open-source **Ozone**) that implements two endpoints
(`com.atproto.label.subscribeLabels`, `com.atproto.label.queryLabels`), defines custom
labels with configurable severity, blur, defaults, and localization, and signs labels
with a secp256k1 key tied to a service DID.

Existing labelers in the ecosystem largely focus on **identity/credential verification**
(e.g., ATProtoApps community-labeler for games journalists) rather than **content
fact-checking** — a clear gap. The most relevant atproto prior art for claim annotation
is John Warden's draft **Open Community Notes** spec (v0.1.1) built on atproto lexicons
for proposing/rating/scoring annotations.

**Self-labeling cannot be used for arbitrary fact-checks** (only a small fixed global
set is honored), so a fact-check system must be implemented as a third-party labeler
service.

On the Fediverse/ActivityPub side, fact-checking work centers on the W3C
**ActivityPub Trust & Safety Taskforce** exploring **Web Annotation Protocol**
(POSTing `Annotation` objects to outboxes, with experimental implementations like
`ThisIsMissEm/annotations-service`), **shared blocklists** (Seirdy Tier-0, FediNuke,
Garden Fence, CARIAD, IFTAS-DNI) as community labeling infrastructure, and the
well-established **Schema.org ClaimReview** standard used by IFCN signatories and
Google/Bing — providing a natural interop schema that an atproto claim labeler
could map into.

---

## 1. atproto / Bluesky

### 1.1 Stackable moderation & the Labeler protocol

Bluesky's moderation architecture is explicitly stackable: independent third-party
labeler services layer on top of default moderation. Any party can operate a Labeler
by implementing two atproto endpoints:

- `com.atproto.label.subscribeLabels` — WebSocket stream that distributes new labels.
- `com.atproto.label.queryLabels` — point-in-time lookup.

Labels support:

- Custom identifiers with configurable **severity** (`inform` / `alert`).
- **Blur** settings.
- Default preferences (`hide` / `warn` / `ignore`).
- Localized names and descriptions.
- Purpose categories: `informational`, `topical`, `curational`, `moderational`.

A fact-check / claim labeler naturally maps to **severity = `inform`**,
**purpose = `informational`**.

Sources:
- <https://bsky.social/about/blog/03-12-2024-stackable-moderation>
- <https://docs.bsky.app/blog/blueskys-moderation-architecture>
- <https://atproto.com/specs/label>

### 1.2 Ozone — the canonical labeler implementation

**Ozone** is Bluesky's official open-source, self-hostable labeler service: a Next.js
web UI + backend + Postgres. It handles report intake, custom label creation, and label
issuance on both accounts and content.

Operational facts:

- Labels are signed with a **secp256k1** private key.
- Distribution is via the `subscribeLabels` **WebSocket** stream.
- Each moderation service has a **long-term service DID** with a distinct
  label-signing key indicated in its DID document.
- Labels carry `exp` (expiration timestamp) and `sig` (signature) fields per the
  updated Lexicon schema.

Setup requires:

1. A dedicated account for the labeler.
2. Registration as a moderation service via the **PLC directory**.
3. Publishing an `app.bsky.labeler.service` record so clients discover it.

Sources:
- <https://github.com/bluesky-social/ozone>
- <https://github.com/bluesky-social/ozone/blob/main/HOSTING.md>
- <https://atproto.com/guides/using-ozone>
- <https://github.com/bluesky-social/atproto/discussions/2293>

### 1.3 Self-labeling is NOT a path for fact-checks

atproto only honors a small fixed set of global self-labels:
`porn`, `sexual`, `gore`, `nudity`, `bot`, `!no-unauthenticated`.

Arbitrary claim/fact labels **must** come from a third-party labeler service.
(The record format technically permits arbitrary strings; the restriction is enforced
by AppView client behavior.)

Sources:
- <https://github.com/snarfed/self-labeler>
- <https://atproto.com/specs/label>

### 1.4 Existing labelers — and the content fact-check gap

Prominent labelers in the ecosystem focus on **identity / credentials** of accounts,
not content claims. Example: **ATProtoApps `atproto-community-labeler`** assigns
labels like *Game Dev*, *Games Journalist*, *Games Publisher* via manual maintainer
review of external evidence (Muck Rack, personal sites, Twitter/LinkedIn).

→ No prominent atproto labeler is doing content-level fact-checking. This is the gap
the present project targets.

Source:
- <https://github.com/ATProtoApps/atproto-community-labeler>

### 1.5 Open Community Notes — closest atproto prior art

**`johnwarden/open-community-notes`** (v0.1.1 draft) is a draft AT Protocol
specification for proposing, rating, scoring, and serving community-authored
annotations on Bluesky posts using custom lexicon records. Authored by John Warden
(Social Protocols). Status: **draft only, no production implementation observed**.

Source:
- <https://github.com/johnwarden/open-community-notes>

Additional design-space reading:
- <https://quilling.dev/blog/atproto-labels/>
- <https://bnewbold.leaflet.pub/3me3ea64bhk26>
- <https://leaflet.pub/bef6e8fe-d968-4b6e-bb70-a85f242103dd>

### 1.6 Margin.at — open annotation layer on atproto

**Margin** (<https://margin.at>) is a free / open-source browser extension and
**open annotation layer for the web, built on the AT Protocol**: users
highlight text, leave notes, and bookmark pages, with annotations **stored on
the user's decentralized identity** (their PDS) as atproto records.

Why this matters for the claim-labeler:

- **Adjacent live prior art on atproto** — closest atproto-native project to
  claim annotation. Their record shape for "annotation targeted at a URL +
  text span" is a natural reference for our claim records' "span back to
  source" field, and shows the Web Annotation Data Model semantics are
  viable on atproto today.
- **Annotations on the author's PDS** is a pattern we can inherit for
  crowd-sourced *claim proposals* (separate from emitted *labels*, which live
  on the labeler's signing identity).
- **Cross-protocol potential**: same underlying Web-Annotation semantics as
  the ActivityPub work in §2.1, so a margin.at ↔ ActivityPub
  annotations-service bridge is on the table.

Open follow-ups (not surfaced this pass — verify before relying):
- Lexicon namespace (e.g., `at.margin.*` / `app.margin.*`) and exact field
  shape of an annotation record.
- Operator / maintainer identity, license, source-repo location (suspected on
  **tangled.org**, atproto-native code hosting).
- Visibility model — public-by-default vs. scoped.

Sources:
- <https://margin.at>
- <https://margin.at/about>

---

## 2. Fediverse / ActivityPub

### 2.1 Web Annotation Protocol — the leading approach

The W3C **ActivityPub Trust & Safety Taskforce** is actively exploring annotation
mechanisms for Fediverse fact-checking. Approach:

- Use the **Web Annotation Data Model + Web Annotation Protocol**.
- An `Annotation` object can be POSTed to an actor's outbox; the server wraps it in
  a `Create` activity per ActivityPub §6.2.1. No new ActivityPub extension required.
- Experimental implementation: **`ThisIsMissEm/annotations-service`** (AdonisJS),
  using `sha256(Object ID)` as the annotation collection ID for easy lookup of
  annotations on a given object.

**Caveat:** Mastodon does not implement client-to-server (C2S), which limits practical
deployment to servers that support C2S (some Pleroma/Akkoma forks, Smithereen, custom
implementations).

Sources:
- <https://lists.w3.org/Archives/Public/public-swicg/2025Jan/0070.html>
- <https://github.com/ThisIsMissEm/annotations-service>

### 2.2 Shared blocklists as community labeling infrastructure

Shared Fediverse blocklists function as community labeling/moderation infrastructure
analogous to atproto labelers:

- **Seirdy Tier-0**
- **FediNuke**
- **Garden Fence**
- **CARIAD**
- **IFTAS-DNI**

They use consensus-based inclusion criteria with variable transparency, English-language
bias, and acknowledged subjectivity.

Sources:
- <https://arxiv.org/html/2506.05522v1>
- <https://seirdy.one/posts/2023/05/02/fediverse-blocklists/>
- <https://gardenfence.github.io>
- <https://cariad.fedicheck.iftas.org/login>

### 2.3 Moderator design requirements

Fediverse moderators have articulated concrete design needs for shared
labeling/annotation systems — useful UX requirements for any atproto claim labeler:

- Category filters.
- Severity toggles.
- Comment-based documentation.
- Collaborative voting mechanisms.
- Multilingual support.
- Detailed moderation "receipts" for transparency.

Source: <https://arxiv.org/html/2506.05522v1>

---

## 3. Interop standard: Schema.org ClaimReview

**Schema.org `ClaimReview`** is the dominant interoperable fact-check vocabulary:
a structured-data type for "a fact-checking review of claims made in some creative
work." Adopted by:

- **IFCN signatories**: PolitiFact, Snopes, FactCheck.org, Full Fact, AFP Fact Check.
- **Platforms**: Google Search/News, Bing, Facebook.

Stable since ~2016.

**Google Data Commons Fact Check Feed** publishes a real-time JSON DataFeed of
ClaimReview markups — directly ingestible as a source for an atproto claim labeler
to label posts referencing previously fact-checked claims.

Sources:
- <https://schema.org/ClaimReview>
- <https://blog.schema.org/2021/12/09/the-art-of-connection/>
- <https://developers.google.com/search/docs/appearance/structured-data/factcheck>
- <https://datacommons.org/factcheck/download>
- <https://www.poynter.org/fact-checking/2026/what-is-claimreview-fact-checking/>

---

## 4. Gaps & opportunities

1. **Content-level fact-check labeler is greenfield on atproto.** All major existing
   labelers do identity/credentials or moderation — nobody is doing content
   fact-checking seriously.
2. **ClaimReview → atproto label mapping** has no canonical proposal. Mapping
   (URL / claim / rating → label value) would be a useful contribution.
3. **Data Commons ClaimReview feed ingestion** for automated matching of posts
   against known fact-checks (URL match first, semantic later) is unbuilt.
4. **Open Community Notes** is a draft spec with no production implementation —
   either build against it or take it as inspiration.
5. **Cross-protocol bridge** between ActivityPub Web Annotations and atproto labels
   is completely unexplored.

---

## 5. Caveats

- **Time-sensitive:** atproto label spec and Ozone have evolved rapidly (`sig`/`exp`
  fields added in 2024). Re-verify lexicon field details against
  <https://atproto.com/specs/label> before implementation.
- **Coverage of non-English atproto labelers may be incomplete** — research focused
  on English-language ecosystem.
- The "gap" finding (no content fact-check labelers on atproto) is an
  **absence-of-evidence** claim and could miss small or recent projects.
- `ThisIsMissEm/annotations-service` is an **experimental personal project**, not an
  officially blessed W3C reference implementation.
- ClaimReview adoption stats reflect the **search-engine ecosystem**, not
  necessarily Fediverse-native fact-check tooling.
- The self-labeling restriction is enforced by **AppView client behavior**;
  technically the record format permits arbitrary strings, so behavior could shift
  if AppView policy changes.

---

## 6. Open questions

- Are there production atproto labelers specifically doing content-level
  fact-checking (not identity) that weren't surfaced — e.g., regional/non-English
  labelers, or labelers run by news organizations or IFCN signatories?
- Has the Open Community Notes draft (johnwarden) progressed beyond v0.1.1, and is
  anyone implementing it against a live Ozone instance or custom labeler backend?
- What is the current state of Mastodon/Akkoma support for the Web Annotation
  Protocol via client-to-server, and are any production fact-check bots using it
  instead of the more common reply-bot pattern (e.g., `@factcheck` mention bots)?
- How would a hybrid system map ClaimReview structured data
  (URL / claim / rating) onto atproto label values and signed label records — is
  there a canonical mapping or lexicon proposal in flight?

---

## 7. Source index

| URL | Quality | Angle |
| --- | --- | --- |
| <https://bsky.social/about/blog/03-12-2024-stackable-moderation> | primary | atproto labeler ecosystem |
| <https://docs.bsky.app/blog/blueskys-moderation-architecture> | primary | atproto labeler ecosystem |
| <https://github.com/bluesky-social/ozone> | primary | atproto technical/protocol |
| <https://github.com/bluesky-social/ozone/blob/main/HOSTING.md> | primary | atproto technical/protocol |
| <https://atproto.com/guides/using-ozone> | primary | atproto technical/protocol |
| <https://atproto.com/specs/label> | primary | atproto technical/protocol |
| <https://github.com/bluesky-social/atproto/discussions/2293> | primary | atproto technical/protocol |
| <https://github.com/snarfed/self-labeler> | primary | atproto technical/protocol |
| <https://github.com/ATProtoApps/atproto-community-labeler> | primary | atproto labeler ecosystem |
| <https://github.com/johnwarden/open-community-notes> | primary | gaps, critiques, design space |
| <https://bnewbold.leaflet.pub/3me3ea64bhk26> | primary | gaps, critiques, design space |
| <https://quilling.dev/blog/atproto-labels/> | blog | gaps, critiques, design space |
| <https://leaflet.pub/bef6e8fe-d968-4b6e-bb70-a85f242103dd> | blog | Bluesky community notes / annotation |
| <https://lists.w3.org/Archives/Public/public-swicg/2025Jan/0070.html> | primary | Fediverse / Mastodon fact-checking |
| <https://github.com/ThisIsMissEm/annotations-service> | primary | ActivityPub annotation |
| <https://cariad.fedicheck.iftas.org/login> | primary | Fediverse / Mastodon fact-checking |
| <https://arxiv.org/html/2506.05522v1> | primary | Fediverse / Mastodon fact-checking |
| <https://seirdy.one/posts/2023/05/02/fediverse-blocklists/> | primary | Fediverse / Mastodon fact-checking |
| <https://gardenfence.github.io> | primary | Fediverse / Mastodon fact-checking |
| <https://schema.org/ClaimReview> | primary | ActivityPub annotation / credibility |
| <https://blog.schema.org/2021/12/09/the-art-of-connection/> | primary | ActivityPub annotation / credibility |
| <https://developers.google.com/search/docs/appearance/structured-data/factcheck> | primary | ActivityPub annotation / credibility |
| <https://datacommons.org/factcheck/download> | primary | ActivityPub annotation / credibility |
| <https://www.poynter.org/fact-checking/2026/what-is-claimreview-fact-checking/> | secondary | ActivityPub annotation / credibility |
| <https://asml.cyber.harvard.edu/2024/10/25/fediverse-observer/> | primary | ActivityPub annotation / credibility |
| <https://arxiv.org/html/2408.15383v1> | primary | ActivityPub annotation / credibility |
