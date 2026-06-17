# Trigger — Firehose

When `TRIGGER_FIREHOSE=true`, **every** `app.bsky.feed.post` create event
from the Jetstream relay is dispatched into the LLM pipeline. This is the
maximally permissive trigger and is **off by default** because Bluesky's
post volume far exceeds a single local LLM endpoint's throughput.

| Property | Value |
| --- | --- |
| Env | `TRIGGER_FIREHOSE=true` |
| Default | **off** |
| Volume | very high — ~30 M posts/day across all of Bluesky, ~hundreds/sec sustained |
| Source | Jetstream (`app.bsky.feed.post` create events) |
| Detection | every post matches |

## When to use

- You have a high-throughput LLM endpoint (multi-GPU vLLM cluster, a
  hosted endpoint with a paid tier, or similar).
- You want fact-checks to appear on *every* match without any user
  action.
- You have an aggressive pre-filter outside this codebase (e.g. a tiny
  classifier in front of the LLM) — the current pipeline does **not**
  pre-filter; every post hits Stage 1 extraction.

If any of those isn't true, prefer one of the other triggers:

- [TRIGGER_MENTIONS.md](./TRIGGER_MENTIONS.md) for user-initiated checks.
- [TRIGGER_REPORTS.md](./TRIGGER_REPORTS.md) for the Bluesky moderation
  UI's "Report" flow.
- [TRIGGER_WATCHLIST.md](./TRIGGER_WATCHLIST.md) for a curated set of
  accounts.

## Setup

```bash
TRIGGER_FIREHOSE=true
JETSTREAM_URL=wss://jetstream2.us-east.bsky.network/subscribe
```

The Jetstream URL points at any Bluesky-operated relay; geographic
proximity matters a little for latency, not for filtering. The labeler
filters down to `app.bsky.feed.post` create events on the server side via
`wantedCollections=app.bsky.feed.post`, so the bandwidth into your
service is already trimmed by ~90 % relative to the unfiltered firehose.

## Example event

Alice writes a post:

```jsonc
// at://did:plc:alice-abcdef/app.bsky.feed.post/3kxalice
{
  "$type":     "app.bsky.feed.post",
  "text":      "5G towers cause COVID. Multiple studies have proven it.",
  "createdAt": "2026-06-17T10:00:00.000Z",
  "langs":     ["en"]
}
```

Alice's PDS broadcasts the create event onto Jetstream. So do millions of
other users, every day, every second.

## What the labeler does with it

1. **Jetstream ingest.**
   `src/ingest/jetstream.ts` parses the commit and builds an
   `IngestedPost`. The post is forwarded to the trigger layer.
2. **Trigger evaluation** (`src/ingest/triggers.ts`).
   `evaluateTrigger(post, cfg)`:
   - `cfg.firehose` is `true` → return
     ```jsonc
     {
       "reason":            "firehose",
       "targetUri":         "at://did:plc:alice-abcdef/app.bsky.feed.post/3kxalice",
       "targetIsSourcePost": true
     }
     ```
   - (Mention, watchlist, and reply-parent checks are never reached
     because firehose takes precedence.)
3. **Pipeline.**
   - **S1 extract** — LLM is called with Alice's text. For Alice's post
     it returns:
     `"5G towers cause COVID."` (atomic, decontextualised).
   - **S2 retrieve** — dense cosine returns Snopes' `"5G coronavirus"`,
     Reuters Fact Check `"5G COVID-19"`, CORRECTIV's German equivalents
     plus topical neighbours.
   - **S3 entail** — NLI marks the direct hits as `entailment`, drops the
     topical neighbours as `neutral`.
   - **S4 match** — pass-through publisher verdicts; every `false`
     remains `false`. Aggregation: `verdict=false`.
   - **S5 propose** — proposal pushed to HITL.

   Most posts in firehose mode produce **no** proposal:
   - posts whose extracted claims aren't falsifiable
     (`is_falsifiable: false` — see `src/pipeline/extract.ts`),
   - posts whose retrieval returns nothing above the `minCosine` floor,
   - posts where every retrieved candidate is judged `neutral` by NLI
     (`uncovered`),
   - posts whose confidence is below threshold.

   The pipeline cost is paid regardless — every post still passes through
   Stage 1 extraction.
4. **HITL + emit.** Same as the other triggers.

## Cost envelope

Some back-of-the-envelope numbers to set expectations.

| Item | Value |
| --- | --- |
| Bluesky posts/day | ~30 M |
| Sustained rate | ~350 events/sec (peaks higher during news cycles) |
| Local LLM throughput, gemma-class on a single GPU | ~5–20 requests/sec |
| Resulting LLM backlog at 350 events/sec | hours to days |
| Hosted endpoint cost at 30 M extractions/day, $0.0001/request | $3 000/day |

In other words, running firehose with a single local instance is
operationally infeasible. Either upgrade your endpoint or pre-filter
before the trigger layer.

## Suggested pre-filter (not implemented)

If you want firehose-style coverage but with a manageable LLM bill,
insert a cheap pre-filter before Stage 1 extraction. None of the
following is implemented yet — these are hooks you'd add:

- **Length filter** — drop posts < 30 characters or > 5 000.
- **Language filter** — only languages your fact-check index covers
  (e.g. `de`, `en`, `fr`).
- **Has-link / has-quote heuristic** — only check posts that link to a
  news source, or that look like quoted statistics.
- **Cheap classifier** — a small distillBERT-grade model (~30 ms/post on
  CPU) that scores "claim-likely" vs "not-claim-likely". Keep the
  predicted-claim half; drop the rest.

These can ride alongside `TRIGGER_FIREHOSE=true` if added to
`src/ingest/triggers.ts` between event reception and extraction.

## Operational notes

- **Watchlist + firehose** — firehose takes precedence; the watchlist
  becomes redundant. If you've set both, the `reason` on every proposal
  records `"firehose"`.
- **Mentions + firehose** — same precedence; explicit mentions still
  produce proposals, they just report `reason: "firehose"` instead of
  `"mention"`. Operationally indistinguishable downstream.
- **Stopping cleanly** — the Jetstream cursor is persisted to
  `kv_state` in SQLite. After a restart with firehose still on, the
  service resumes where it left off rather than re-processing the gap.
  In a high-backlog scenario this is usually fine; in a complete
  pipeline freeze it can mean weeks of catch-up. Reset the cursor by
  deleting the row if you'd rather skip ahead.

## See also

- [TRIGGER_MENTIONS.md](./TRIGGER_MENTIONS.md) — user mentions the
  labeler in a post or reply.
- [TRIGGER_REPORTS.md](./TRIGGER_REPORTS.md) — user reports the post
  via `createReport`.
- [TRIGGER_WATCHLIST.md](./TRIGGER_WATCHLIST.md) — proactively check
  named accounts.
