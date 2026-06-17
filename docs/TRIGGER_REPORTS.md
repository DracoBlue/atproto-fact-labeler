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
```

Bluesky's AppView is used to fetch the reported post's content by URI.
This works for any public post, no auth required.

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
   - **S2 lookup** — Snopes' `"COVID-19 vaccines contain microchips"`,
     PolitiFact's `"vaccine microchip tracker"`, Reuters Fact Check
     `"microchip vaccine"`.
   - **S3 normalise** — `verdict=false`, confidence high, votes=3.
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

## Reports against the labeler's own posts → feedback channel

A report whose `subject.uri` belongs to the labeler account itself is
treated as **user feedback**, not as a normal dispatch. We never run the
fact-check pipeline on our own work — that's both pointless (we already
know what we said) and a recursion risk. Instead the report is persisted
in the `feedback` table for an operator to review.

The check is a cheap string match (`at://<labelerDid>/...`); no AppView
round-trip needed.

### Reviewing feedback

```bash
pnpm run feedback:list                     # 50 most recent rows
pnpm run feedback:list --unresolved        # only rows without a resolution
pnpm run feedback:list --since 2026-06-01  # since a date
pnpm run feedback:list --limit 100         # cap output
```

Sample output:

```
#3  2026-06-17 12:14:02  [open]
  subject : at://did:plc:fact-labeler-abcdef/app.bsky.feed.post/3kxrep1
  type    : com.atproto.moderation.defs#reasonOther
  reason  : The verdict is wrong, CORRECTIV is outdated.
```

A "resolved" workflow (marking, replying, retiring the original verdict)
is not yet wired — the rows are read-only from the CLI today. When you
act on a piece of feedback, mark it manually:

```bash
sqlite3 data/labeler.sqlite \
  "UPDATE feedback SET resolved_at = datetime('now'), resolution = 'retired verdict' WHERE id = 3;"
```

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

- [TRIGGER_MENTIONS.md](./TRIGGER_MENTIONS.md) — user mentions the
  labeler in a post or reply.
- [TRIGGER_WATCHLIST.md](./TRIGGER_WATCHLIST.md) — proactively check
  named accounts.
- [TRIGGER_FIREHOSE.md](./TRIGGER_FIREHOSE.md) — check every post (opt-in,
  high cost).
