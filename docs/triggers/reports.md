# Trigger — Reports

When a Bluesky user **reports** a post against the labeler, the labeler
treats the report as a request to fact-check the reported subject. This
trigger is on by default and is the path Bluesky's standard moderation UI
uses when a user picks "Report → atproto-fact-labeler" from a post's menu.

| Property | Value |
| --- | --- |
| Env | `TRIGGER_REPORTS=true` |
| Default | **on** |
| Volume | low–medium (organic, gated by user intent) |
| Source | `POST /xrpc/com.atproto.moderation.createReport` on the labeler's HTTP port |
| Detection | every `subject.uri` starting with `at://` is dispatched; account-level reports (subject = `did:`) are accepted but ignored |

## When to use

- You want a familiar reporting workflow visible inside the Bluesky
  client.
- You want a *signed* user-initiated request (Bluesky's PDS handles
  authentication; the labeler just sees the report payload).
- You want this trigger to work even when the post itself is too old to
  appear on the live Jetstream cursor.

## Setup

```bash
TRIGGER_REPORTS=true
APPVIEW_URL=https://public.api.bsky.app
REQUIRE_REPORT_AUTH=true                # ON by default
PLC_DIRECTORY_URL=https://plc.directory # used to resolve report-issuer DIDs
```

Bluesky's AppView is used to fetch the reported post's content by URI.
This works for any public post, no auth required.

### Authentication

`REQUIRE_REPORT_AUTH=true` is the default. Every request must carry a
valid atproto service JWT in `Authorization: Bearer <jwt>`. The labeler:

1. Splits + decodes the JWT.
2. Checks `alg` is `ES256K` or `ES256`, `aud` is `LABELER_DID`,
   `lxm` is `com.atproto.moderation.createReport`, `exp` is in the
   future (5 s clock-skew tolerance), `iss` looks like a DID.
3. Resolves `iss` via PLC (`did:plc:…`) or `/.well-known/did.json`
   (`did:web:…`) and parses the atproto signing key.
4. Verifies the signature against `SHA-256(header.payload)`.
5. On success, records the issuer DID as `reportedBy` in the feedback
   row and the HTTP response.

Failure paths:
- Missing / malformed `Authorization` header → **401 AuthRequired**.
- JWT validation failed → **401 BadJwt** with a precise reason in the
  response body (`signature invalid`, `expired`, `wrong audience`, …).

Real Bluesky clients always sign these requests via their PDS, so this
"just works" in production.

**For local curl-based testing**, flip the env:

```bash
REQUIRE_REPORT_AUTH=false pnpm run start
```

…then anyone can `curl -d '{...}'` the endpoint and `reportedBy` is
recorded as `"unknown"`. Never run with `REQUIRE_REPORT_AUTH=false` in
a public deployment.

The HTTP handler is mounted on the same port as `subscribeLabels` (the
default is `LABELER_PORT=14831`), so a single ingress route serves both.

## Example event

Bob has a post making a factual claim:

```jsonc
// at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob
{
  "$type":     "app.bsky.feed.post",
  "text":      "Vaccines contain tracking microchips.",
  "createdAt": "2026-06-17T10:00:00.000Z",
  "langs":     ["en"]
}
```

Alice opens the post in her Bluesky client. She has previously subscribed
to the `facts.example.org` labeler. She picks **Report** from the post
menu and the client sends:

```http
POST /xrpc/com.atproto.moderation.createReport HTTP/1.1
Host: facts.example.org
Content-Type: application/json

{
  "reasonType": "com.atproto.moderation.defs#reasonOther",
  "reason":     "please fact-check",
  "subject": {
    "$type": "com.atproto.repo.strongRef",
    "uri":   "at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob",
    "cid":   "bafy-bob"
  }
}
```

Alice's PDS signs the request on her behalf; the labeler service receives
the body. (When the labeler runs locally for development, you can post
the same JSON directly with `curl` or `httpie`.)

## What the labeler does with it

1. **HTTP intake** (`src/ingest/reports.ts`).
   The Fastify handler at
   `POST /xrpc/com.atproto.moderation.createReport` validates the body
   shape:
   - `reasonType` (string) — recorded for auditing.
   - `reason` (string) — free-text user reason.
   - `subject` — must include `uri` starting with `at://`. Account-level
     reports (no `uri`, only `did`) are accepted, logged, and dropped —
     we don't yet act on account-level subjects.
2. **Dispatch.** A `ReportPayload` is handed to the dispatcher:
   ```jsonc
   {
     "reasonType": "com.atproto.moderation.defs#reasonOther",
     "reason":     "please fact-check",
     "subjectUri": "at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob",
     "subjectCid": "bafy-bob",
     "reportedAt": "2026-06-17T10:02:14.123Z"
   }
   ```
3. **Target resolution.** `dispatchByUri("at://did:plc:bob…/3kxbob", "report")`
   checks `post_cache` first; on miss, calls
   `GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=at://did:plc:bob…/3kxbob`,
   converts the response to an `IngestedPost`, and persists it.
4. **Pipeline.**
   - **S1 extract** — `"Vaccines contain tracking microchips."`
   - **S2 retrieve** — dense cosine returns Snopes' `"COVID-19 vaccines
     contain microchips"`, PolitiFact's `"vaccine microchip tracker"`,
     Reuters Fact Check `"microchip vaccine"` plus topical neighbours.
   - **S3 entail** — NLI marks all three direct hits as `entailment`;
     neighbours drop as `neutral`.
   - **S4 match** — `verdict=false`, confidence high, votes=3.
   - **S5 propose** — proposal pushed to HITL.
5. **HITL.** Reviewer accepts.
6. **Emit.** `@skyware/labeler` signs and persists a `fact-refuted`
   label against Bob's post URI/CID. Streamed on `subscribeLabels`.
7. **HTTP response.** The Fastify handler returns a body shaped per
   `com.atproto.moderation.defs#createReportOutput`:
   ```jsonc
   {
     "id":         1750158134123,
     "reasonType": "com.atproto.moderation.defs#reasonOther",
     "reason":     "please fact-check",
     "subject":    { "$type": "com.atproto.repo.strongRef",
                     "uri":   "at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob",
                     "cid":   "bafy-bob" },
     "reportedBy": "unknown",
     "createdAt":  "2026-06-17T10:02:14.123Z"
   }
   ```
   Alice's client uses this as confirmation. Note: `reportedBy` is
   `"unknown"` for now — Bluesky's PDS-side JWT isn't yet propagated to
   the labeler in this implementation.

## Quote-post the reported post (opt-in)

With `REPLY_TO_REPORTS=true` the labeler **quote-posts** the reported
post on its own feed after a successful label emit, so the verdict +
sources land in the labeler's timeline. The post-author's postgate
setting is honoured (no quote if quotes are disabled).

Quote-posts are idempotent per reported URI: re-reports of the same
post don't produce a second quote.

See [`replies.md`](./replies.md) for the full reply behaviour shared
with the [mentions](./mentions.md) trigger — payload format,
`Details:` link policy, postgate handling, i18n picker, retry queue.

## Local development

You can simulate a report against a running labeler with curl:

```bash
curl -s -X POST http://localhost:14831/xrpc/com.atproto.moderation.createReport \
  -H 'Content-Type: application/json' \
  -d '{
    "reasonType": "com.atproto.moderation.defs#reasonOther",
    "reason":     "please fact-check",
    "subject":    { "$type": "com.atproto.repo.strongRef",
                    "uri":   "at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob",
                    "cid":   "bafy-bob" }
  }'
```

The reported post is dispatched immediately. Watch the HITL surface
(stdin / Telegram / auto) for the resulting proposal.

## Bypassed cases → feedback channel

Two report classes don't go through the fact-check pipeline:

- A report whose `subject.uri` belongs to the labeler account
  itself ("you got something wrong on your own post"). Re-checking
  our own work is pointless and recursive.
- A report with `reasonType` set to the *appeal* constant — a user
  tapping *Anfechten / Appeal* on a label we emitted. Re-running the
  pipeline on the same input would produce the same verdict.

Both land in the `feedback` table for operator review and never
reach the dispatcher. See [`../feedback.md`](../feedback.md) for the
review CLIs, Telegram surfacing on appeals, the resolved-workflow,
and the dedup behaviour.

## Edge cases

- **Account-level report** (`subject = did:plc:bob…`): currently logged
  and ignored. Will need a separate workflow if we want to label
  whole accounts.
- **Subject URI for a non-post collection** (e.g. a list, a starter
  pack): the AppView call returns nothing, the dispatcher logs a warning
  and drops. We only handle `app.bsky.feed.post`.
- **Reports against a deleted post**: AppView returns empty, drop.
- **Bulk-report flooding**: when `REQUIRE_REPORT_AUTH=true` (the
  default), every request must carry a valid atproto service JWT, so a
  random caller can't spam the endpoint. For self-reports against the
  labeler's own posts the `feedback` table also dedupes on
  `(subject_uri, reason_type, reason)` and bumps a `count` column
  instead of creating new rows. Further per-DID rate limiting is left
  to a Fastify plugin if traffic justifies it.

## See also

- [TRIGGER_MENTIONS.md](./mentions.md) — user mentions the
  labeler in a post or reply.
- [TRIGGER_WATCHLIST.md](./watchlist.md) — proactively check
  named accounts.
- [TRIGGER_FIREHOSE.md](./firehose.md) — check every post (opt-in,
  high cost).
