# Feedback channel

The `feedback` table holds operator-actionable signals that arrive
via the reports endpoint but **are not fact-check dispatches**.
Currently two kinds:

1. **Reports against the labeler's own posts** — somebody flagged
   one of the labeler's quote-posts or replies. Almost always means
   "your verdict is wrong" or "your reply is annoying"; never a
   fact-check request.
2. **Label appeals** — a Bluesky user tapped *Anfechten / Appeal* on
   a label this labeler emitted. The Bsky client wraps the appeal as
   a `createReport` with a specific `reasonType`.

Both bypass the pipeline. Re-running fact-extraction → retrieval →
NLI on the labeler's own post would be both pointless and a recursion
risk; running it on an appeal would produce the same verdict as
before (input unchanged) and waste an LLM call.

Code: [`src/feedback/store.ts`](../../src/feedback/store.ts) +
[`src/index.ts`](../../src/index.ts) (route handler).

## Reports against the labeler's own posts

A report whose `subject.uri` belongs to the labeler account itself
is treated as user feedback, not as a normal dispatch. The check is
a cheap string match (`at://<labelerDid>/...`); no AppView
round-trip needed.

## Label appeals

The Bluesky client sends `createReport` with `reasonType` set to one
of:

- `com.atproto.moderation.defs#reasonAppeal` (legacy)
- `tools.ozone.report.defs#reasonAppeal` (Ozone)

Both are recognised by `isAppealReason()` in
[`src/feedback/store.ts`](../../src/feedback/store.ts). The dispatcher
**short-circuits**: no pipeline re-run; the appeal goes straight to
`feedback` with the reporting DID, the reason string the user typed,
and the subject URI of the contested label.

When `HITL_MODE=telegram` or `HITL_MODE=auto-telegram`, the operator
also receives a plain-text Telegram message naming the contested
URI, reporting DID, reason text, a deep link to the detail page,
and the exact `pnpm retire` command to use if the appeal is upheld.
On `stdin` / `auto` modes the Telegram push is a no-op — those
operators review via `pnpm feedback:list`.

Log line for context:

```
{"level":40, "msg":"label appeal received — recorded as feedback,
  pipeline NOT re-run. Operator review: pnpm feedback:list /
  pnpm retire --uri=...",
  "feedbackId":42, "uri":"at://…/3kx",
  "reasonType":"tools.ozone.report.defs#reasonAppeal",
  "reportedBy":"did:plc:alice"}
```

## Reviewing feedback

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

## Acting on a feedback row

The "resolved" workflow (marking, replying, retiring the original
verdict) is not yet wired — the rows are read-only from the CLI
today. When you act on a piece of feedback, mark it manually:

```bash
sqlite3 data/labeler.sqlite \
  "UPDATE feedback SET resolved_at = datetime('now'), resolution = 'retired verdict' WHERE id = 3;"
```

For appeals upheld, the typical full flow:

```bash
pnpm feedback:list --unresolved
# decide per appeal: leave the label, or retire it
pnpm retire --uri=at://did:plc:bob/app.bsky.feed.post/3kx
sqlite3 /data/labeler.sqlite \
  "UPDATE feedback SET resolved_at = datetime('now'),
   resolution = 'appeal upheld, label retired'
   WHERE id = 42;"
```

## Dedup

The `feedback` table carries a unique index on
`(subject_uri, reason_type, reason)`. Repeated reports / appeals
against the same target bump a `count` column instead of inserting
a duplicate row. So the queue surfaces each *distinct* concern
once, with how many users raised it.
