# Triggers

Four ways a post can land in the labeler's pipeline. Operators pick
the mix they want via env flags; defaults are conservative
(mentions + reports only).

| Trigger | Env flag | Cost | When to use |
|---|---|---|---|
| [Mentions](./mentions.md) | `TRIGGER_MENTIONS=true` (default) | low | User explicitly tags `@facts.example.org` in a post or reply — they're asking for a fact-check. |
| [Reports](./reports.md) | `TRIGGER_REPORTS=true` (default) | low | User taps "Report" on a post and chooses the labeler as the moderation target. Treats reports as fact-check requests; respects `reasonAppeal` separately. |
| [Watchlist](./watchlist.md) | `TRIGGER_WATCHLIST=true` | moderate | Operator pre-configured DIDs whose posts should be auto-checked. Proactive, opt-in per account list. |
| [Firehose](./firehose.md) | `TRIGGER_FIREHOSE=true` | high | Every post on the network gets checked. Only sensible at scale with strong filters; default off. |

All four converge on the same orchestrator
([`src/index.ts:dispatchByUri`](../../src/index.ts)), which loads the
post, runs the [pipeline](../pipeline/README.md), and routes the
result through HITL.

## Shared reply / quote-post layer

Mentions and reports both have an opt-in surface where the labeler
*responds* on Bluesky after a successful verdict — mentions get a
thread reply, reports get a quote-post on the labeler's own feed.
The behaviour is documented once in [`replies.md`](./replies.md):
when it fires, what the post looks like, where the `Details:` link
points, the i18n picker, and the retry queue.
