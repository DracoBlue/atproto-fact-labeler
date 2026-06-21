# Trigger — Watchlist

When a post's author DID is on the configured watchlist, the labeler
processes the post proactively — no mention, no report, no opt-in from
the user. This trigger is **off by default** and is intended for
intentional monitoring of high-impact accounts (politicians, news outlets,
known repeat spreaders).

| Property | Value |
| --- | --- |
| Env | `TRIGGER_WATCHLIST=did:plc:a,did:plc:b,…` |
| Default | empty (no posts) |
| Volume | proportional to the watchlist (controllable) |
| Source | Jetstream (`app.bsky.feed.post` create events) |
| Detection | `post.did` ∈ watchlist; replies and top-level posts both match |

## When to use

- You're running a journalism / civic-tech labeler and want to keep an
  eye on a known shortlist of accounts.
- You want a steady, predictable LLM load.
- You want fact-checks to appear without any user action.

This is the trigger that justifies the largest editorial responsibility:
you are choosing **whose words to scrutinise**. Document the criteria
publicly when you operate this at scale.

## Setup

```bash
LABELER_DID=did:plc:fact-labeler-abcdef
# Mix DIDs and bare handles freely — handles are resolved at startup.
TRIGGER_WATCHLIST=did:plc:bob-abcdef,carol.example.org,@dave.bsky.social
```

The value is a comma-separated list. Each entry is either:

- An atproto DID (`did:plc:…` or `did:web:…`) — used as-is.
- A bare Bluesky handle (`alice.example.org`) — resolved to a DID at
  startup via `com.atproto.identity.resolveHandle` against `APPVIEW_URL`.
- A handle with a leading `@` — the `@` is stripped before resolution.

If **any** entry fails to resolve, the service refuses to start with an
error listing every failure. A half-resolved watchlist silently misses
posts, so failing fast is safer than working around the bad config.

Whitespace is trimmed; empty entries are dropped. `did:plc:` entries are
lowercased for the method-specific id.

## Example event

Bob (on the watchlist) writes a post making a factual claim:

```jsonc
// at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob
{
  "$type":     "app.bsky.feed.post",
  "text":      "Unemployment in Germany is now at a record 15 %.",
  "createdAt": "2026-06-17T10:00:00.000Z",
  "langs":     ["de", "en"]
}
```

Bob's PDS broadcasts the create event onto Jetstream.

## What the labeler does with it

1. **Jetstream ingest.**
   `src/ingest/jetstream.ts` parses the commit and builds an
   `IngestedPost`. The post's `did` is `did:plc:bob-abcdef`.
2. **Trigger evaluation** (`src/ingest/triggers.ts`).
   - `cfg.firehose` is `false` → skip.
   - `cfg.watchlist.includes(post.did)` is `true` → return
     ```jsonc
     {
       "reason":            "watchlist",
       "targetUri":         "at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob",
       "targetIsSourcePost": true
     }
     ```
   - (The mention path is never reached because the watchlist matched
     first.)
3. **Pipeline.**
   - **S1 extract** — `"Unemployment in Germany is at 15%."`
   - **S2 retrieve** — dense cosine returns CORRECTIV's
     `"Arbeitslosigkeit in Deutschland"` entries (crosslingual EN→DE),
     dpa-Faktencheck's `"Arbeitslosenquote"` items, Reuters' English
     equivalents.
   - **S3 entail** — NLI marks each as `entailment` since publishers
     reviewed the same statistical claim.
   - **S4 match** — publisher ratings (`Größtenteils falsch`, `Falsch`,
     `Mostly False`) pass through and aggregate to `verdict=false`,
     confidence high, votes=2.
   - **S5 propose** — proposal pushed to HITL.
4. **HITL.** Reviewer accepts (or rejects if the claim is actually true
   — the labeler doesn't know in advance; HITL still owns the decision).
5. **Emit.** `@skyware/labeler` signs and persists a `fact-refuted`
   label against Bob's post.

## Watchlist + reply behaviour

Replies are matched the same way — `post.did` is the **replier's** DID,
not the parent's. If you watchlist Bob, every reply Bob writes is also
considered, regardless of who he's replying to. If you want to fact-check
posts that Bob is **replying to** (because they're contentious in his
threads), use [TRIGGER_MENTIONS.md](./mentions.md) instead.

## Operational notes

- **Volume is predictable** — proportional to the watchlist size and
  posting rate. Twenty active accounts at ~10 posts/day each is ~200
  pipeline runs per day. Easy to size for.
- **Cold-start re-check.** The cursor in `post_cache` only covers what
  Jetstream has streamed since the service was last running. To check
  historical posts from a newly-added watchlist DID, manually call the
  reports endpoint with each URI you care about
  ([TRIGGER_REPORTS.md](./reports.md)).
- **Removing a DID** from the list takes effect on the next config
  reload (i.e. service restart). Labels already emitted are not
  retroactively retired — use `pnpm run retire` if you need that
  (see `../LIFECYCLE.md` § Phase 3).
- **Public watchlist.** Bluesky's design assumes labelers are
  transparent. Consider publishing the watchlist (e.g. on the labeler
  account's pinned post) — operating it secretly invites mistrust.

## Edge cases

- **Watchlist + firehose both enabled** ([TRIGGER_FIREHOSE.md](./firehose.md)):
  firehose precedence wins; the `reason` field on the proposal records
  `"firehose"`. The watchlist becomes redundant.
- **Account on the watchlist deleted from atproto**: Jetstream stops
  emitting events for that DID; the trigger naturally goes silent.
- **Watchlist of >1000 entries**: the lookup is `Array.includes` —
  O(n) per event. Replace with a Set if you scale into the
  thousands.

## See also

- [TRIGGER_MENTIONS.md](./mentions.md) — user mentions the
  labeler in a post or reply.
- [TRIGGER_REPORTS.md](./reports.md) — user reports the post
  via `createReport`.
- [TRIGGER_FIREHOSE.md](./firehose.md) — check every post (opt-in,
  high cost).
