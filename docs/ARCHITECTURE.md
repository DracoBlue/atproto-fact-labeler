# Architecture: One Labeler, Two-Stage Pipeline

> Runtime architecture for the `atproto-claim-labeler` project. Companion to
> [`COMPONENTS.md`](./COMPONENTS.md) (what's inside each component),
> [`EPISTEMICS.md`](./EPISTEMICS.md) (who verifies what on what basis),
> [`PRIOR_ART.md`](./PRIOR_ART.md) (where the design ideas come from), and
> [`SOURCES.md`](./SOURCES.md) (what external fact-check feeds we ingest).

## 0. TL;DR

**One atproto labeler.** A single service-DID, a single signing key, a
single `app.bsky.labeler.service` record, a single label vocabulary.
Internally a two-stage pipeline (extract → verify), but the wire output is
unified `fact-*` labels. Verification primarily reuses existing
fact-checks via the ClaimReview ecosystem
([SOURCES.md](./SOURCES.md)) rather than running our own RAG.

```
Bluesky / atproto
      │ Jetstream
      ▼
┌──────────────────────────────────────────────────────────────────┐
│                       FACT LABELER                               │
│                                                                  │
│  ingest ─► pipeline-worker:                                      │
│             1. extract atomic claims        (LM Studio)          │
│             2. lookup Google Fact Check API + ClaimReview        │
│             3. on match: normalise publisher verdict             │
│             4. on no match + high stakes: RAG-LLM fallback       │
│             5. propose label + evidence                          │
│                              │                                   │
│                              ▼ proposal                          │
│                       HITL (Telegram-bot or Ozone)               │
│                              │ on accept                         │
│                              ▼                                   │
│                       label-server / Ozone                       │
│                       - sign label (secp256k1)                   │
│                       - subscribeLabels (WS)                     │
│                       - queryLabels (HTTP)                       │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                       AppViews / clients ── fact-*
```

End users opt in via the standard `atproto-accept-labelers` header. Two
deployment shapes are documented:

- **Lite** (§11): label-server + Telegram-bot HITL + SQLite. **Recommended
  v0 / v1.**
- **Ozone** (§3 ff.): full Ozone stack. Recommended once HITL becomes a
  team or reports/appeals traffic justifies it.

## 1. Why one labeler (and not two)

An earlier revision of this doc proposed splitting extraction and
verification into two on-wire labelers (`claim-*` and `fact-*`). The
collapse to **one** labeler reflects the actual product:

- End users only care about the verdict ("is this true?"), not the
  intermediate "is this a checkable claim?" signal.
- Verification primarily reuses existing fact-checks via ClaimReview
  ([SOURCES.md](./SOURCES.md)) — there is no expensive RAG step that
  benefits from being decoupled.
- Solo HITL means **one** queue, not two — splitting the wire created
  ops cost without product gain.
- The protocol allows but does not document chaining labelers; staying
  inside well-trodden territory simplifies partner conversations.

The **epistemic** two-level split (extraction ≠ verification) remains —
it lives in the internal data model (`claim`, `verdict`, `evidence`
records in the sidecar DB) and in the HITL UX (reviewer sees both
"what was extracted" and "what was verified"). See
[`EPISTEMICS.md`](./EPISTEMICS.md).

### When to split out a second labeler later

Reconsider if any of these become real:

- A third party asks for our raw extracted-claim stream to build their
  own competing fact-labeler.
- We want users to be able to subscribe to extraction without verification
  (or vice versa).
- Extraction throughput substantially diverges from verification
  throughput such that decoupling for ops is worth it.

None of these are v1 concerns. Adding a second labeler later is cheap:
register a second service-DID, emit `claim-*` from the same backend.

### Label value format — kebab-case, ≤ 128 bytes

Per the [atproto protocol spec](https://atproto.com/specs/label) (more
authoritative than the bsky.app guide): `val` is **max 128 bytes**, strongly
recommended kebab-case (`[a-z]` + internal dashes, **no leading or trailing
dash**, no punctuation/whitespace/non-ASCII), "to a couple dozen characters
at most." Base64, key/value syntax, lists, numerical scores, URLs are
**explicitly discouraged**.

`!`-prefix is reserved for **system-level behavior directives** (`!warn`,
`!takedown`, `!suspend`). Our labels are descriptive, so no `!`.

Our vocabulary (single labeler emits only these):
`fact-supported`, `fact-refuted`, `fact-disputed`, `fact-unknown`,
`fact-outdated`. All conform.

End users opt in via the `atproto-accept-labelers` HTTP header (up to 20
labelers per client).

### Label-record envelope (what's on the wire)

Protocol-level fields on every label (spec verbatim):

```
ver  required  integer    current version = 1
src  required  did        labeler DID (must match #atproto_label key)
uri  required  uri        subject (at:// post or did: account)
cid  optional  cid        pinned subject version
val  required  string     ≤ 128 bytes, kebab-case
neg  optional  bool       true = retracts an earlier label
cts  required  datetime   created-at
exp  optional  datetime   expiration; after exp, services should NOT hydrate
sig  optional  bytes      required when transferring full objects
```

Signing (handled by Ozone): construct minus `sig`, CBOR-encode via DRISL
normalisation, SHA-256, sign hash bytes with key id `#atproto_label`.

### DID document — what Ozone's "announce to network" actually writes

Two entries get added to the labeler service account's DID document:

- Signing key with id **`#atproto_label`** (matches `OZONE_SIGNING_KEY_HEX`)
- Service endpoint with id **`#atproto_labeler`**, type
  **`AtprotoLabeler`**, value = our `OZONE_PUBLIC_URL`

Verifying the announce step worked = checking these two entries exist via
`com.atproto.identity.resolveHandle` → PLC lookup.

### Negation and expiration are real wire mechanisms — use them

**Negation** (`neg=true`): to retract a previous label, re-emit with the
same `src`+`uri`+`val`, `neg=true`, a later `cts`. **A negation does not
assert the inverse** — it only retracts. AppViews stop hydrating the
original.

**Expiration** (`exp`): labels with `exp` set persist in storage but should
**not be hydrated in API responses after that time**. Useful for
time-bounded verdicts.

These two map directly onto our verdict lifecycle (see
[`EPISTEMICS.md §2.3`](./EPISTEMICS.md)):

| Event | Wire action |
| --- | --- |
| New verdict on a previously-unlabeled claim | Emit positive label |
| Verdict changes (e.g. `false → true` because the world changed) | Emit `neg=true` for the old `val`; emit new positive label |
| Verdict's `valid_at` window known to be bounded | Set `exp` on the label |
| Verdict declared outdated (re-verification stale) | Emit `neg=true` for the old; optionally emit `fact-outdated` |
| Reviewer rejects a previously-issued label (bug, abuse) | Emit `neg=true` |

We never destroy verdict history in our sidecar DB; on the wire we use
`neg` + new `cts`. Audit fidelity preserved at both layers.

### Payload lives elsewhere — confirmed by spec

The spec is explicit: *"The spec does not define mechanisms for embedding
richer claim or verdict data. Label semantics and supporting evidence are
generally communicated elsewhere."* Our sidecar-DB + Ozone-comment plan
(§8) is exactly the recommended shape.

## 2. What a labeler actually is

A labeler is **not a PDS publishing claim records**. A labeler is:

- A **service DID** registered in PLC.
- A signing key (`secp256k1`) — `#atproto_label` in the DID doc.
- An `app.bsky.labeler.service` record published once on the labeler
  account's PDS.
- An HTTP/WS endpoint implementing the two label methods:
  - `com.atproto.label.subscribeLabels` (WebSocket stream)
  - `com.atproto.label.queryLabels` (lookup)
- A backend (Ozone Postgres or our lite SQLite) where the labels and
  per-subject state actually live.

**Labels are not PDS records.** They are a separate class of signed
objects defined by `com.atproto.label.defs`, distributed via the two
endpoints above. Bluesky's own moderation labeler runs at scale on this
pattern.

→ No claim records on PDS. No verdict records on PDS. No `app.claim.*` or
`app.fact.*` collections in v1. All payload state lives in the labeler
backend's DB. The **optional** [detail records on the labeler's PDS](#optional-detail-records-on-pds)
are a v2 / external-consumer concern, not part of the wire labels.

## 3. Pipeline topology

One application stack:

```
                          ┌─────────────────────┐
       Jetstream  ──────► │   ingest worker     │
                          │   - WS, cursor      │
                          │   - dedup, lang     │
                          │   - pre-filter      │
                          └──────────┬──────────┘
                                     │
                                     ▼
                          ┌──────────────────────────────────────────┐
                          │  pipeline-worker (single LLM extraction) │
                          │                                          │
                          │  S0  fetch post text (already in event)  │
                          │  S1  extract atomic claims  (LM Studio)  │
                          │  S2  ClaimReview lookup     (Google API) │
                          │  S3  normalise publisher verdict         │
                          │  S4  if no match + high stakes:          │
                          │        RAG-LLM fallback (LM Studio)      │
                          │  S5  build proposed label + evidence     │
                          └──────────┬───────────────────────────────┘
                                     │ proposal (claim, verdict, evidence)
                                     ▼
                          ┌─────────────────────┐
                          │   HITL              │
                          │   - Telegram-bot    │ (Lite — default)
                          │   - or Ozone UI     │ (when team forms)
                          └──────────┬──────────┘
                                     │ on accept
                                     ▼
                          ┌─────────────────────┐
                          │  label-server       │ (Lite)
                          │   - SQLite          │   or
                          │   - secp256k1 sign  │
                          │   - subscribeLabels │  Ozone backend
                          │   - queryLabels     │
                          └──────────┬──────────┘
                                     │ signed labels
                                     ▼
                                AppViews / clients
```

The whole thing is one service-DID, one signing key, one
`labeler.service` record, one set of label values, one HITL queue.

### Pipeline stages — what they do

| Stage | What | Where data flows |
| --- | --- | --- |
| `S0 ingest` | Jetstream filter `app.bsky.feed.post`, lang-detect, drop boost/share, dedup by `(repo, cid)` | post text → S1 |
| `S1 extract` | LM Studio call. Decompose + decontextualise + entity-link. Emit atomic-claim list with span + confidence | claims → S2 |
| `S2 lookup` | Google Fact Check Tools API + cached ClaimReview ([SOURCES.md](./SOURCES.md)). URL match → entity overlap pre-filter → semantic embedding match | claim-with-sources → S3 (hit) or S4 (no hit) |
| `S3 normalise` | Map publisher rating ("Falsch", "False", "Pants on Fire") to our `{true, false, mixed, unknown, disputed, outdated}` | verdict proposal → HITL |
| `S4 RAG fallback` | Only when no ClaimReview match and claim is high-stakes (health, elections, named individuals). Wikidata + Wikipedia + news corpus retrieval + LLM verdict | verdict proposal → HITL |
| `S5 propose` | Build `{claim, verdict, evidence[]}` proposal, push to HITL queue | → HITL |

S2 is the **default path** — most claims get verified by reusing existing
ClaimReviews. S4 is the **fallback** for novel claims, and is the only
place we run our own RAG-LLM pipeline. See [`COMPONENTS.md`](./COMPONENTS.md)
for stage internals.

## 4. Storage

One DB (Postgres if Ozone, SQLite if Lite). Tables:

- `post_cache` — minimal `(uri, cid, did, text, lang, indexedAt)` for
  posts we touched. Working cache, can be evicted.
- `claim` — `{id, post_uri, atomic_text, decontextualized_text, span,
  entities, lang, confidence, status: proposed|accepted|rejected,
  extractor_version, extracted_at}`.
- `verdict` — `{id, claim_id, post_uri, label: supported|refuted|…,
  valid_at, verified_at, verifier_id, verifier_kind: feed|model|human,
  evidence_ids[], confidence, rationale, status, supersedes?}`.
- `evidence` — `{id, source_url, publisher, snippet?, rating_native,
  reviewed_at, retrieved_at, retrieval_method, license, attribution}`.
  (No verbatim publisher rationale text — citation-only per
  [SOURCES.md §12](./SOURCES.md).)
- `label_emit` — projection of accepted `(claim × current-verdict)` to
  what was actually streamed on `subscribeLabels`. Also feeds the
  negation/supersession lifecycle ([§1 negation table](#negation-and-expiration-are-real-wire-mechanisms--use-them)).
- Lite: Telegram message-id ↔ proposal-id map for HITL state.
- Ozone: Ozone's own `report`, `moderation_event`, `label` tables.

State recoverability: post URIs from Jetstream replay, evidence from
re-retrieval against ClaimReview feeds, labels we emitted from our own
DB plus AppView reconciliation.

## 5. Two deployment shapes (Lite or Ozone)

This project supports two stacks for the labeler backend. The pipeline
(S0–S5) is identical; only the HITL surface and the label-serving
backend differ. See [§11](#11-lite-stack-recommended-v0--v1) for the
lite stack (recommended v0/v1) and the rest of §5+ for the Ozone path.

## 6. Processes (Ozone path) — what Ozone actually ships

The Ozone repo ships a **single `compose.yaml`** that brings up
everything we need on the labeler side. We only add the upstream pipeline.

**What Ozone gives us out of the box** (per its
[HOSTING.md](https://github.com/bluesky-social/ozone/blob/main/HOSTING.md)):

| Container | Role |
| --- | --- |
| `ozone` | Node service — **UI + backend** in one process, on `:3000` |
| `ozone-daemon` | Background daemon (scheduled actions, event pushing, blob diverting) |
| `postgres` | Backend DB |
| `caddy` | TLS + reverse proxy, auto-LetsEncrypt |
| `watchtower` | Auto-update of containers (nightly) |

Set up via systemd unit, deploys with `docker compose --profile daemon up`.

**Required env vars** (excerpt — see HOSTING.md for the full list):

```
OZONE_SERVER_DID           # service account's DID
OZONE_PUBLIC_URL           # https://fact-labeler.example.com
OZONE_ADMIN_DIDS           # comma-separated admin DIDs
OZONE_ADMIN_PASSWORD       # also acts as API key
OZONE_SIGNING_KEY_HEX      # secp256k1, one openssl command
OZONE_DB_POSTGRES_URL
OZONE_APPVIEW_URL          # https://api.bsky.app
OZONE_APPVIEW_DID          # did:web:api.bsky.app
```

**"Announce to network" step** is done **once in the Ozone UI** after first
login as the service account. It (a) adds the labeler entry + verification
method to the account's DID document, and (b) publishes the
`app.bsky.labeler.service` record. We do not write that record manually.

**What we add (Ozone path):**

| Process | Stack | Notes |
| --- | --- | --- |
| `ingest` | Python asyncio | Jetstream WS, cursor persistence, dedup, reconnect/backoff |
| `pipeline-worker` ×N | Python; OpenAI SDK → LM Studio | Pipeline stages S1–S5 |
| `ozone-writer` | tiny Python service | Authenticates as a moderator DID, calls `tools.ozone.moderation.emitEvent` to submit proposed labels/comments into Ozone |

External: LM Studio (already running) at `http://127.0.0.1:1234`.

## 7. How we actually push labels into Ozone

Per [`docs/api.md`](https://github.com/bluesky-social/ozone/blob/main/docs/api.md)
and the lexicon
[`tools.ozone.moderation.emitEvent`](https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/emitEvent.json),
Ozone exposes a single canonical entry point for moderation actions
(including labels).

```
POST  /xrpc/tools.ozone.moderation.emitEvent
Auth  Bearer  (session for a DID with moderator|admin role)

{
  "event":   { "$type": "tools.ozone.moderation.defs#modEventLabel",
               "createLabelVals": ["fact-refuted"],
               "negateLabelVals": [] },
  "subject": { "$type": "com.atproto.repo.strongRef",
               "uri": "at://did:plc:.../app.bsky.feed.post/3k...",
               "cid": "bafy..." },
  "createdBy": "did:plc:<our-moderator-bot-did>"
}
```

That's it. Ozone:
- writes the label row in its DB,
- signs it with `OZONE_SIGNING_KEY_HEX`,
- streams it out on `com.atproto.label.subscribeLabels`,
- serves it via `com.atproto.label.queryLabels`,
- keeps the moderation event in the per-subject history.

Other useful event types we'll use:
- `modEventComment` — attach our LLM's rationale + atomic-claim text as a
  comment on the subject so human moderators see it.
- `modEventTag` — tag a subject with `confidence:low`, `category:health`,
  etc. (cheap metadata).
- `modEventAcknowledge` / `modEventEscalate` — close or escalate the
  subject in Ozone's queue.

**Auth:** Ozone enforces RBAC. Triage / moderator / admin roles. **Only
moderator and admin can issue labels.** Our pipeline writer DID gets the
moderator role (added via `OZONE_ADMIN_DIDS` or via Ozone UI).

## 8. Where the claim/verdict payload lives

`emitEvent` doesn't carry our rich payload (atomic text, span, entities,
evidence URLs, etc.). Two options:

1. **Store payload in our own sidecar DB**, keyed by subject URI. Join
   externally when needed (Ozone UI renders the comment, we render the
   detail). Operationally cleanest for v1.
2. **Stuff the payload into `modEventComment.comment`** as Markdown / JSON.
   Visible to moderators in Ozone immediately, no sidecar to maintain — but
   the comment field is unstructured and limited.

Recommendation for v1: **comment for moderator-facing summary +
sidecar DB for machine-readable payload** (claim/verdict/evidence as
typed records, indexed by post URI).

## 9. Ozone manages the HITL queue — we don't reinvent it

Per Ozone's docs, every subject has `reviewState` ∈
`{reviewOpen, reviewEscalated, reviewClosed, reviewNone}` plus
`muted`, `appealed`, `takendown`. State transitions are caused by events.
This already covers our HITL queue model:

- We `emitEvent` with our proposed label + a comment → subject lands in
  `reviewOpen`.
- Moderators see it in the standard Ozone queue, accept / override / escalate.
- Acceptance issues the label downstream.

No custom queueing layer on our side. (For Level 1, where Argilla felt
natural, we should re-evaluate: if Ozone's queue is sufficient, we drop
Argilla and run both labelers on Ozone — see §10.)

## 7. Runtime envelope (sanity)

- **Jetstream → claim-labeler**: ~10 k posts/min steady-state. Pre-filter
  (lang + non-empty + non-quote-only) cuts to ~3 k/min. Checkworthy gate
  cuts further to a few hundred per minute. Realistic LLM-extraction load:
  manageable for a single LM Studio instance.
- **claim-labeler → fact-labeler**: only accepted claims trigger
  verification. AVeriTeC-class verifiers run ~60 s/claim on a single A10;
  on smaller hardware accept higher latency or restrict to high-priority
  categories.
- **Ozone DB growth**: rows scale with labels emitted, not with posts seen.
  Bluesky's own moderation labeler runs at scale on this; we're orders of
  magnitude smaller.

## 8. Deployment shape

Two independent docker-compose stacks (or two namespaces in k8s), each:

```
labeler-<name>/
  docker-compose.yml
  ingest/        # ingest worker
  pipeline/      # extraction OR verification worker
  read-api/      # claim-labeler only
  ozone/         # vendored Ozone backend + UI
  postgres/      # DB
  config/
    secrets/     # signing key, LM Studio key, etc.
    plc-info/    # service DID, labeler.service record
```

Each stack is self-contained. Spin up the claim-labeler first, prove it
emits labels Bluesky picks up. Spin up the fact-labeler second, point it at
the claim-labeler. Done.

## 9. What is **not** in v1

- No PDS-published claim or verdict records (see §2).
- No Community Notes bridging algorithm (concept noted in
  [`PRIOR_ART.md §7.2`](./PRIOR_ART.md#72-community-notes-bridging-based-matrix-factorization);
  v2 candidate).
- No ActivityPub / Web Annotation bridge ([`RESEARCH.md §2.1`](./RESEARCH.md#21-web-annotation-protocol--the-leading-approach);
  v2 candidate).
- No own UI beyond Ozone + standard Bluesky clients.

## 10. Open implementation questions

Still open after the single-labeler consolidation:

1. **Verifier model size for S4 fallback** — gemma-4-e2b is fine for S1
   extraction, but for the rare RAG-LLM fallback (S4) on novel claims, do
   we need a larger local model (Qwen3-14B class) or a hosted API?
2. **Disputed-wire-format** — single `fact-disputed` label, or multiple
   competing `fact-*` labels when ingested publishers disagree?
3. **High-stakes definition for S4 trigger** — when no ClaimReview match
   exists, should we (a) emit `fact-unknown`, (b) run RAG fallback, or
   (c) skip? Probably category-dependent (health / elections / named
   individuals → RAG; everything else → `fact-unknown`).
4. **Detail-record publication** ([§9 below](#optional-detail-records-on-pds))
   — publish on the labeler's PDS yes/no, and where to deterministically
   key them?

Resolved by the single-labeler consolidation:
- ~~Claim-payload coupling between two labelers~~ — no two labelers.
- ~~Two Ozones or one~~ — one.
- ~~Argilla yes or no~~ — Lite stack uses Telegram; Ozone path uses Ozone
  queue. Either way, no separate Argilla.

---

## 11. Lite stack (recommended v0 / v1) — Telegram-bot HITL, no Ozone

This is the **default** recommended deployment shape for the project's
current phase (solo HITL, LM Studio local, prototype to early v1). The
Ozone-based path documented in §3–§9 above remains available for any
future team scale-up — both shapes share the same pipeline (S0–S5),
storage model, and wire output.

### 11.1 What atproto actually requires

A labeler is just:

1. DID document with `#atproto_label` (secp256k1 key) and `#atproto_labeler`
   (service endpoint) entries.
2. `app.bsky.labeler.service` record on the service account's PDS.
3. An HTTP server implementing:
   - `WS /xrpc/com.atproto.label.subscribeLabels`
   - `GET /xrpc/com.atproto.label.queryLabels`

Everything else Ozone provides (web UI, reports intake, takedown state
machine, team workflows, appeals) is **optional** from the protocol's
perspective.

### 11.2 Topology — Telegram-bot HITL

```
Jetstream
   │
   ▼
ingest-worker  →  extraction (LM Studio)  →  verification (LM Studio + ClaimReview API)
                                                            │ proposal
                                                            ▼
                                               telegram-bot:
                                               ┌─────────────────────────────────┐
                                               │ 📝 @alice.bsky.social            │
                                               │ "Die Erde ist flach..."          │
                                               │                                  │
                                               │ Atomic: "Die Erde ist flach"     │
                                               │ Vorschlag: fact-refuted          │
                                               │ Quellen: CORRECTIV, AFP, mimi.   │
                                               │                                  │
                                               │ [✓ Label] [✗ Skip] [↻ Defer]     │
                                               └─────────────────────────────────┘
                                                            │ on ✓
                                                            ▼
                                                  label-server (tiny):
                                                   - SQLite store
                                                   - secp256k1 signing
                                                   - subscribeLabels (WS)
                                                   - queryLabels (HTTP)
                                                            │
                                                            ▼
                                                AppViews / clients
```

### 11.3 What replaces what

| Ozone provides | Lite replacement |
| --- | --- |
| Postgres + Node service + ozone-daemon + Caddy + watchtower | One `label-server` binary + SQLite |
| Web UI for moderators | Telegram inline-keyboard buttons |
| `tools.ozone.moderation.emitEvent` API | `POST /internal/labels` on the label-server, called by the bot on accept |
| `subscribeLabels` + `queryLabels` | Same — implemented in label-server |
| Reports intake (`createReport`) | 50-line endpoint that forwards reports to the same Telegram chat |
| RBAC (triage / moderator / admin) | Telegram chat ACL — only allowlisted Telegram users see the buttons |
| State machine (reviewOpen / Escalated / …) | Bot tracks `proposed | accepted | rejected | deferred` in SQLite |

### 11.4 Realistic implementation surface

- **`label-server`** — ~300–500 LOC in Python or TypeScript. Even less with
  [`@skyware/labeler`](https://github.com/skyware-js/labeler), an explicit
  non-Ozone labeler SDK from the Skyware ecosystem.
- **`telegram-bot`** — ~200 LOC. Receives proposals on a queue, posts
  message with inline buttons, calls label-server on accept, writes
  decision to SQLite.
- **Both labelers (claim + fact) can share the same `label-server`
  binary** — multiple service-DID configs, one per labeler, run as separate
  processes or as multi-tenant.

### 11.5 Trade-offs

**Gain:**
- Massively simpler infra: no Postgres, no Caddy, no Node-monorepo, no
  daemon/watchtower stack.
- HITL on your phone everywhere — push notification is one tap from
  accept.
- Faster iteration: bot logic is a redeploy, not a DB migration.
- Better UX for solo HITL than any web UI.

**Lose:**
- Reports-intake out of the box — has to be added as a thin endpoint.
- Multi-reviewer workflow + standardized roles — fine for solo, awkward
  if a team forms.
- Takedown / mute / appeal primitives — we don't use them anyway for
  fact-check labels.
- Free Ozone audit-trail UI — replaced by SQLite + a 50-line dashboard
  or `litecli`.
- Easy migration *to* Ozone later — doable, weekend-scale, but not free.

### 11.6 When to switch back to Ozone

- A team of >3 reviewers forms.
- Reports intake from third parties becomes a real volume.
- Appeals / takedown workflows become a real need.
- We want the bsky-native moderation-service onboarding UX without
  bespoke ops.

### 11.7 Precedence

We are not the first to skip Ozone:

- **`@skyware/labeler`** exists explicitly to build labelers without Ozone.
  Bluesky's own docs say "use Ozone or build your own."
- Early Aaron Rodericks labelers were custom-built.
- The games labeler (`ozone.birb.house`) — despite the handle — runs its
  user-facing intake as a **DM bot**, not via the Ozone UI. Same idea.

### 11.8 Recommendation

**v0 / prototype:** Lite stack (Telegram-bot + label-server). It matches
the solo-HITL reality, fits the LM-Studio-local model story, and reduces
time-to-first-live-label dramatically.

**v1+ (when growth justifies it):** Migrate to Ozone, or run Ozone
alongside for the bits where it pulls weight (reports, team review).

Document is **not** rewriting §3–§10 around this — those describe the
Ozone path which remains documented for any future team scale-up.

## 12. Optional detail records on PDS (deferred to v2)

Earlier exploration considered publishing `dev.fact-labeler.detail`
records on the labeler's PDS so external consumers (custom clients,
researchers) can fetch per-post detail without our private HTTP API. See
the design sketch in [`SOURCES.md §11`](./SOURCES.md) for the proposed
lexicon shape and [the per-post lookup pattern](#) (deterministic rkey =
`base32(sha256(post-uri))`).

**Status:** deferred. Not part of the v1 wire. Reasons:
- Standard Bluesky clients don't fetch them.
- Volume management (TTL, dedup) adds complexity.
- The same data is available via our service's HTTP detail endpoint
  (link surfaced from the labeler's generic label description).

Revisit when a partner client / aggregator asks for them.
