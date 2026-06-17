# atproto-fact-labeler

A self-hostable [atproto](https://atproto.com) labeler that surfaces
**existing fact-check verdicts** (CORRECTIV, dpa, AFP, Snopes, PolitiFact, …)
on Bluesky posts.

**This labeler does not decide what is true.** It routes the verdicts that
third-party fact-checkers have already published. Every emitted label points
back to its source. The vocabulary on the wire is descriptive
(`fact-supported`, `fact-refuted`, `fact-disputed`, `fact-unknown`,
`fact-outdated`, `fact-mixed`).

License: MIT (see [LICENSE](./LICENSE)).

---

## How it works (in 60 seconds)

```
Bluesky / Jetstream
        │
        ▼
   ingest worker
        │
        ▼
 LLM extraction (LM Studio @ 127.0.0.1:1234)
        │
        ▼
 ClaimReview lookup (local SQLite index, built from Google Data Commons feed)
        │
        ▼
 publisher-rating normaliser → internal verdict {true,false,mixed,unknown,disputed,outdated}
        │
        ▼
 HITL (stdin · Telegram · auto)
        │ on accept
        ▼
 @skyware/labeler  →  signed label on subscribeLabels  +  detail HTML page
```

The pipeline is **lookup-first**: most claims are answered by an existing
fact-check entry. Running our own retrieval-augmented LLM verification is a
fallback for novel claims and is stubbed in this v0 — see the `S4` notes in
`src/pipeline/orchestrator.ts`.

---

## Requirements

- **Node ≥ 22** and **pnpm ≥ 9**.
- **LM Studio** running an OpenAI-compatible API at
  `http://127.0.0.1:1234/v1`. A small model like `google/gemma-4-e2b`
  works for extraction.
- A copy of the **Google Data Commons Fact Check feed**:
  ```bash
  curl -L \
    https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json \
    -o data.json
  ```
  (Compilation is CC BY 4.0; per-entry text remains under each publisher's
  copyright. We store URLs + metadata + a normalised rating only.)

---

## Install

```bash
git clone <this-repo>
cd atproto-fact-labeler
pnpm install
cp .env.example .env
```

Edit `.env`:

```
# REQUIRED — your LM Studio key
OPENAI_API_KEY=sk-lm-...

# Bluesky labeler identity (placeholder fine for local dev)
LABELER_DID=did:plc:placeholder-replace-after-setup
LABELER_SIGNING_KEY=         # auto-generated on first run

# HITL surface (stdin | telegram | auto)
HITL_MODE=stdin
```

---

## Ingest fact-checks

Build the local SQLite index from the Data Commons feed:

```bash
pnpm run ingest                    # uses CLAIMREVIEW_FEED_PATH from .env
# or
pnpm run ingest path/to/data.json
```

Progress is logged every 5 000 entries. The full Data Commons dump
(~200 MB JSON, ~200 k entries) takes a couple of minutes.

---

## Run the service

```bash
pnpm run start
```

You'll see something like:

```
labeler server listening on http://127.0.0.1:14831
detail HTTP server listening on http://127.0.0.1:14832
starting Jetstream ingest
```

The service is now:

- consuming `app.bsky.feed.post` events from the Bluesky Jetstream,
- extracting atomic claims via LM Studio,
- matching them against the local fact-check index,
- proposing labels via your HITL surface.

When you press `a`/`y`, the label is signed by `@skyware/labeler` and
served on `subscribeLabels`. Without a real Bluesky service account
registered in PLC, the label won't be honoured by the public AppView yet —
see [Going Live](#going-live) below.

---

## Local development without internet

To run the pipeline offline against local fixture posts:

```bash
echo 'JETSTREAM_FIXTURE=fixtures/posts.jsonl' >> .env
pnpm run start
```

There is also a deterministic offline smoke test that bypasses LM Studio
entirely (stubs the extraction with a known claim) and proves the rest of
the pipeline end-to-end:

```bash
pnpm tsx src/cli/smoke-test.ts
```

The fixture file has one JSON post per line. `fixtures/posts.jsonl` ships
with five sample posts (German + English).

---

## HITL modes

- **`stdin`** (default) — Each proposal prints in your terminal. Press
  `a`/`y` to accept, `r`/`n` to reject, `d` to defer, `q` to quit.
- **`telegram`** — Set `TG_BOT_TOKEN` and `TG_REVIEWER_CHAT_ID` in `.env`,
  then `HITL_MODE=telegram`. The bot DMs you each proposal with inline
  `✅/❌/↻` buttons.
- **`auto`** — Decide automatically without a human. Used for smoke
  tests; accept iff aggregated confidence ≥ 0.8 and votes ≥ 1.

---

## Detail HTTP page

For any post the service has touched:

```
http://localhost:14832/posts?uri=at://did:plc:.../app.bsky.feed.post/3kx
http://localhost:14832/posts?uri=at://did:plc:.../app.bsky.feed.post/3kx&format=json
```

HTML for humans, JSON via `format=json` or `Accept: application/json`.

---

## Tests

```bash
pnpm test              # one shot
pnpm run test:watch    # watch mode
pnpm run typecheck     # tsc --noEmit
```

Unit tests cover the pure-function paths: rating normalisation, lookup
tokenisation, extraction-response parsing, attribution shape, label-value
regex compliance.

---

## Operator lifecycle

You must understand the **full lifecycle** before running this in production:
online, paused, retired, cleared. Atproto labels are durable signed objects
— turning the service off does **not** make them go away. The four phases
below cover every transition you'll actually need.

### Phase 1 — Going online (one-time setup)

To make the labels visible to real Bluesky users:

1. Create a dedicated Bluesky **service account** at `bsky.app`. This is
   distinct from your personal account.
2. Register the labeler endpoint + signing key in the account's DID
   document:
   ```bash
   pnpm dlx @skyware/labeler setup
   ```
   Skyware asks for the service-account credentials and a PLC token
   (mailed to the account's address) and either generates a signing key
   or uses the one in `.env`. Persist the signing key.
3. Declare every label value in `app.bsky.labeler.service`:
   ```bash
   pnpm dlx @skyware/labeler label add
   # Repeat for each fact-* value: severity, blur, defaultSetting, locales
   ```
4. Start the service:
   ```bash
   pnpm run start
   ```

Subscribers (Bluesky AppView, on behalf of opted-in users) open a long-lived
WebSocket against `subscribeLabels` and stay connected. Labels emitted from
this point on flow to them in real time. AppViews backfill from `cursor=0`
on first subscribe.

### Phase 2 — Pausing emissions (variant A & B — temporary)

Use this when you want to stop emitting **new** labels but keep existing
ones visible.

**Variant A — server reboot, deploy, brief maintenance.**
Just stop the process. The WebSocket breaks, AppViews reconnect with
exponential backoff (seconds to minutes), and the cursor lets them resume
without gaps when you restart. Bluesky's AppView tolerates short outages.
Existing labels stay visible the whole time — they live in the AppView's
cache, not on your server.

**Variant B — longer pause, server stays up.**
Stop the *pipeline* but keep `subscribeLabels` / `queryLabels` answering.
Easiest: don't run `pnpm run start`; instead start the labeler in pause
mode:

```bash
# Run the server alone, no ingest. Pure HITL drain.
HITL_MODE=auto JETSTREAM_FIXTURE=/dev/null pnpm run start
```

Subscribers see no new labels. Existing ones are untouched.

### Phase 3 — Retiring content (variant C — emit negations)

When labels were emitted in error, or you want to take them off the wire
without removing the labeler entirely. Use the built-in retire CLI:

```bash
# 1. Preview what would be negated
pnpm run retire:check               # alias for retire --dry-run
# or
pnpm tsx src/cli/retire.ts --dry-run

# 2. Apply (signs and emits a neg=true companion for every live label)
pnpm run retire
# or
pnpm tsx src/cli/retire.ts

# Filter to a single label value:
pnpm tsx src/cli/retire.ts --val=fact-refuted

# Filter to a single post:
pnpm tsx src/cli/retire.ts --uri=at://did:plc:.../app.bsky.feed.post/3kx
```

Each negation is a real, signed atproto label with `neg=true`. AppViews
stop hydrating the original on next sync. End users stop seeing the badge.
The original signed label is **not** deleted — the negation simply
overrides it on read. This matches the protocol: see
`com.atproto.label.defs#label.neg` and the spec at
<https://atproto.com/specs/label>.

The retire CLI is **idempotent**. Re-running after a partial crash skips
already-negated labels.

### Phase 4 — Clearing the labeler declaration (variant D — permanent)

When you want to retire the labeler **permanently** — the account becomes
a normal Bluesky user again. **Run Phase 3 first** so existing labels stop
being shown; clearing the declaration on its own does *not* invalidate
labels that AppViews have already cached.

```bash
# 1. Make sure no labels are still live on the wire
pnpm run lifecycle:status
# Expected: "currently live = 0"

# 2. Remove #atproto_label and #atproto_labeler from the DID document and
#    delete app.bsky.labeler.service:
pnpm dlx @skyware/labeler clear
```

Skyware asks for credentials and a PLC token; the operation is reversible
by re-running `pnpm dlx @skyware/labeler setup`.

After clearing:
- The DID still exists; the account is no longer recognised as a labeler.
- Cached labels in AppViews may persist for a while but new label
  signatures from your old key are no longer trusted (the verifying key
  is gone from the DID document).
- New subscribers can no longer discover you.

### Lifecycle status at any time

```bash
pnpm run lifecycle:status
```

Prints identity, on-wire counts, per-value live/retired counts, and a list
of recommended next steps based on current state. Safe to run any time.

### Cheat sheet

| Goal | Command |
| --- | --- |
| Deploy / reboot | stop and restart `pnpm run start` |
| Pause emissions but keep serving | run with `HITL_MODE=auto JETSTREAM_FIXTURE=/dev/null` |
| Preview a content retire | `pnpm tsx src/cli/retire.ts --dry-run` |
| Retire all live labels | `pnpm tsx src/cli/retire.ts` |
| Retire one label value | `pnpm tsx src/cli/retire.ts --val=fact-refuted` |
| Retire labels on one post | `pnpm tsx src/cli/retire.ts --uri=at://…` |
| See current state | `pnpm run lifecycle:status` |
| Permanently retire labeler | retire-content **first**, then `pnpm dlx @skyware/labeler clear` |

---

## Layout

```
src/
├── config/                env + zod validation
├── store/                 SQLite + schema migrations
├── ingest/
│   ├── claimreview-feed.ts  Google Data Commons → SQLite
│   ├── jetstream.ts         live atproto firehose (JSON)
│   └── fixture.ts           local JSONL replay for tests/dev
├── pipeline/
│   ├── extract.ts           S1  LM Studio extraction
│   ├── lookup.ts            S2  FTS5 over ClaimReview index
│   ├── normalise-rating.ts  S3  publisher rating → internal verdict
│   └── orchestrator.ts      glue S0 → S5
├── hitl/
│   ├── stdin.ts             terminal HITL
│   ├── telegram.ts          grammy bot
│   ├── auto.ts              policy-only HITL
│   └── format.ts            proposal renderers
├── labels/
│   ├── server.ts            @skyware/labeler wrapper + key gen
│   └── vocabulary.ts        verdict → fact-* label value
├── detail/
│   └── server.ts            per-post HTTP "why?" page
└── index.ts                 main entrypoint
test/                        vitest unit tests
fixtures/posts.jsonl         sample posts for offline dev
```

---

## Licensing of the data you ingest

- **[Google Data Commons Fact Check feed][gdc-fc]** compilation: CC BY 4.0
  (attribution required, redistribution permitted). Feed endpoint, refresh
  cadence, and the per-entry `sdLicense` mechanism are documented at
  [datacommons.org/factcheck/faq][gdc-fc-faq] and the
  [download page][gdc-fc-download].

[gdc-fc]: https://datacommons.org/factcheck/
[gdc-fc-faq]: https://datacommons.org/factcheck/faq
[gdc-fc-download]: https://datacommons.org/factcheck/download
- **Individual ClaimReview entries**: the *text* (claim, verdict, rationale)
  remains under each publisher's own copyright. We store only the URL,
  metadata, normalised rating, and a verbatim attribution string. We do not
  mirror publisher text. Default posture for every publisher is therefore
  citation-only — link users out to the publisher's article, never reproduce
  it. Adjust per publisher only with explicit written permission.
- Our own normalised verdict + matching work + labels are MIT-licensed and
  redistributable.

---

## Acknowledgements

Built on top of [`@skyware/labeler`](https://github.com/skyware-js/labeler),
the lightweight atproto labeler SDK that lets you skip Ozone for solo / lean
deployments.
