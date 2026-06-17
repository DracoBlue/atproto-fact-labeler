# Trigger — Mentions

When a Bluesky user `@mentions` the labeler, the labeler treats it as an
explicit request to fact-check something. This is the most natural
user-facing trigger and is **on by default**.

| Property | Value |
| --- | --- |
| Env | `TRIGGER_MENTIONS=true` |
| Default | **on** |
| Volume | low (one event per explicit user request) |
| Source | Jetstream (`app.bsky.feed.post` create events) |
| Detection | structured facet `app.bsky.richtext.facet#mention`, or plain-text `@<handle>` fallback when `LABELER_HANDLE` is set |

## When to use

- You want a low-volume, opt-in trigger driven by users' explicit intent.
- You want to support the "@factbot please check this" convention common
  on Bluesky / Mastodon.
- Your LLM endpoint is a single local instance and can't take firehose
  volume.

## Setup

```bash
LABELER_DID=did:plc:fact-labeler-abcdef
LABELER_HANDLE=facts.example.org     # only needed for text-fallback
TRIGGER_MENTIONS=true
```

A standards-compliant Bluesky client always includes a `facet` for every
mention, so the structured path covers the common case. `LABELER_HANDLE`
is only needed when you want to catch plain-text mentions from clients
that don't emit facets.

## Example event

Bob writes a post making a factual claim:

```jsonc
// at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob
{
  "$type":     "app.bsky.feed.post",
  "text":      "The earth is flat. I have done the research.",
  "createdAt": "2026-06-17T10:00:00.000Z",
  "langs":     ["en"]
}
```

Alice sees the post and replies with a mention of the labeler:

```jsonc
// at://did:plc:alice-abcdef/app.bsky.feed.post/3kxalice
{
  "$type":     "app.bsky.feed.post",
  "text":      "@facts.example.org could you check this?",
  "createdAt": "2026-06-17T10:01:00.000Z",
  "langs":     ["en"],
  "reply": {
    "parent": {
      "uri": "at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob",
      "cid": "bafy-bob"
    },
    "root": {
      "uri": "at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob",
      "cid": "bafy-bob"
    }
  },
  "facets": [
    {
      "index": { "byteStart": 0, "byteEnd": 19 },
      "features": [
        {
          "$type": "app.bsky.richtext.facet#mention",
          "did":   "did:plc:fact-labeler-abcdef"
        }
      ]
    }
  ]
}
```

Alice's PDS broadcasts the create event onto the Jetstream relay.

## What the labeler does with it

1. **Jetstream ingest.**
   `src/ingest/jetstream.ts` parses the commit event, builds an
   `IngestedPost` with `facets`, `replyParent`, `replyRoot`. The post is
   forwarded to the trigger layer.
2. **Trigger evaluation** (`src/ingest/triggers.ts`).
   `evaluateTrigger(post, cfg)` runs:
   - `cfg.firehose` is `false` → skip.
   - `cfg.watchlist` is empty (Alice not listed) → skip.
   - `cfg.mentions` is `true` → call `detectMention(post, {did, handle})`.
     The facet matches Labeler's DID — `matched: true, via: 'facet'`.
   - Alice's post is a reply (`post.replyParent` set) → return
     ```jsonc
     {
       "reason":            "mention-reply",
       "targetUri":         "at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob",
       "targetIsSourcePost": false
     }
     ```
3. **Target resolution.** The trigger target is **Bob's post**, not
   Alice's reply. The dispatcher calls `dispatchByUri()`. Since Bob's
   post is not yet in `post_cache`, the AppView is queried at
   `GET https://api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob`.
   The response is converted to an `IngestedPost` and persisted.
4. **Pipeline.**
   - **S1 extract** — LLM extracts one atomic claim:
     `"The earth is flat."`
   - **S2 lookup** — FTS over the ClaimReview index returns CORRECTIV's
     `"Die Erde ist eine Scheibe"` (cross-lingual via stemmed tokens), AFP
     Fact Check's `"the earth is flat"`, Snopes' `"Flat Earth claims"`.
   - **S3 normalise** — every publisher's native rating maps to our
     internal `false`. Aggregation: `verdict=false`,
     `confidence≈0.95`, `votes=3`, `agreement=1.0`.
   - **S5 propose** — proposal #N is pushed to the HITL surface.
5. **HITL.** Reviewer accepts.
6. **Emit.** `@skyware/labeler` signs and persists a `fact-refuted`
   label against **Bob's post URI/CID**. The label streams to subscribers
   on `subscribeLabels`. Alice's reply is **not** labeled — only the
   claim-bearing post is.
7. **Detail page.** Anyone with the post URI can open
   `http://localhost:14831/posts?uri=at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob`
   to see the matched fact-checks with links to CORRECTIV, AFP, Snopes.

## Standalone mention (no reply)

If Alice writes the assertion herself with a mention:

```jsonc
{
  "text": "Hey @facts.example.org — the earth is flat, right?",
  "facets": [
    {
      "index": { "byteStart": 4, "byteEnd": 23 },
      "features": [{
        "$type": "app.bsky.richtext.facet#mention",
        "did":   "did:plc:fact-labeler-abcdef"
      }]
    }
  ]
  // no reply field
}
```

`evaluateTrigger` returns
`{ reason: 'mention', targetUri: <Alice's post URI>, targetIsSourcePost: true }`.
Alice's post itself is what gets fact-checked, because the mention is
inside the asserting message.

## Text-fallback example

If a client sends a mention without facets:

```jsonc
{
  "text": "@facts.example.org please check: the earth is flat"
  // no facets
}
```

With `LABELER_HANDLE=facts.example.org` set, `detectMention()` matches
the substring `@facts.example.org` and returns
`{ matched: true, via: 'text' }`. Without `LABELER_HANDLE`, the mention
is missed.

## Edge cases

- **Self-mention** (the labeler account mentions itself): not
  special-cased — `evaluateTrigger` fires normally. Avoid posting from
  the labeler account if you don't want recursion.
- **Multiple mentions in one post** (`@facts.example.org @other-bot`):
  the first matching facet wins; other-bot is irrelevant to us.
- **Mention with no claim**: extraction returns zero falsifiable claims;
  the pipeline drops the post silently.
- **Mention of a deleted parent**: AppView fetch returns no post; the
  dispatcher logs a warning and drops.

## See also

- [TRIGGER_REPORTS.md](./TRIGGER_REPORTS.md) — user reports the post
  via `createReport`.
- [TRIGGER_WATCHLIST.md](./TRIGGER_WATCHLIST.md) — proactively check
  named accounts.
- [TRIGGER_FIREHOSE.md](./TRIGGER_FIREHOSE.md) — check every post (opt-in,
  high cost).
