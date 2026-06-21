# Replies and quote-posts

Two opt-in surfaces let the labeler talk back on Bluesky after a
successful label emit:

- **`REPLY_TO_MENTIONS=true`** — for the [mentions](./mentions.md)
  trigger. Replies inline to the mention post in the user's thread.
- **`REPLY_TO_REPORTS=true`** — for the [reports](./reports.md)
  trigger. **Quote-posts** the reported post on the labeler's own
  feed (no thread reply — reporters aren't a thread, they're a
  reporting channel).

Both go through the same shared code path. This doc describes the
common behaviour. Trigger-specific differences are noted inline.

## Setup

Both replies and quote-posts need the labeler service account to
authenticate as a real Bluesky user. Generate an **app password**
in the account's settings (`bsky.app` → Settings → Privacy and
Security → App Passwords). Never use the main account password.

```bash
REPLY_TO_MENTIONS=true   # opt-in to mention replies
REPLY_TO_REPORTS=true    # opt-in to report quote-posts
LABELER_BSKY_SERVICE=https://bsky.social
LABELER_BSKY_IDENTIFIER=facts.example.org      # or did:plc:fact-labeler-abcdef
LABELER_BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
LABELER_DETAIL_BASE_URL=https://facts.example.org   # for the deep-link
```

Config validation fails fast at startup if either flag is `true`
but the identifier or app password is missing.

## Conditions

A reply / quote-post fires only when **all** of:

1. The corresponding env flag is `true`.
2. The trigger reason matches: `mention` / `mention-reply` for
   `REPLY_TO_MENTIONS`, `report` for `REPLY_TO_REPORTS`. Watchlist
   and firehose triggers never produce a reply.
3. A label was actually emitted — i.e. HITL accepted the proposal
   (rejections and defers produce no reply).
4. We haven't already replied to this post (one reply per target
   URI, tracked in the `mention_reply` table).
5. For quote-posts on report: the post-author has not disabled
   quotes via the postgate (`app.bsky.feed.postgate#disableRule`).

## Example reply payload — mention

After a mention is accepted, the labeler posts a reply on its own
PDS, linking **directly to the top publisher's article**:

```jsonc
{
  "$type":     "app.bsky.feed.post",
  "text":      "Verdict: refuted. Sources: CORRECTIV, AFP Fact Check, Snopes. Details: https://correctiv.org/faktencheck/wissenschaft/2018/01/30/erde-scheibe-kugel/",
  "createdAt": "2026-06-17T10:01:42.000Z",
  "reply": {
    "parent": { "uri": "at://did:plc:alice/...", "cid": "..." },
    "root":   { "uri": "at://did:plc:bob/...",   "cid": "..." }
  }
}
```

- `parent` points at the **mention post** — that's who we're
  answering.
- `root` is the original thread root, taken from the mention's own
  `replyRoot` if set, or the mention's URI otherwise.
- The post body fits inside 280 characters; longer source lists
  are trimmed and the URL preserved.

## Example payload — report quote-post

For reports, the labeler posts on its **own feed** with the
reported post embedded:

```jsonc
{
  "$type":     "app.bsky.feed.post",
  "text":      "Verdict: refuted. Sources: CORRECTIV, AFP Fact Check. Details: https://...",
  "createdAt": "2026-06-17T10:02:00.000Z",
  "embed": {
    "$type": "app.bsky.embed.record",
    "record": {
      "uri": "at://did:plc:author/app.bsky.feed.post/3kx",
      "cid": "bafy-post"
    }
  }
}
```

Quote-posts are idempotent per `(reported-post-uri)`: re-reports
of the same post don't produce a second quote. If the author has
disabled quotes via postgate, the labeler skips and logs at info
level.

## Where the `Details:` link points

The link is chosen per-verdict so the user lands one click closer
to the underlying journalism:

| Verdict | Link target |
|---|---|
| `supported`, `refuted`, `mixed`, `outdated`, `unknown` | **Top publisher's original article** — taken from `evidence.source_url`, ordered by retrieval cosine after the NLI gate. Most cases are clear and one source's URL is enough. |
| `disputed` | The labeler's **own detail page**. When publishers disagreed enough that we labeled the post as disputed, no single source's URL tells the whole story — the detail page lists every conflicting source side by side. |
| `no-claim`, `no-match` | No link (these replies are short diagnostic messages without a target). |

This matches the labeler's epistemic stance: route users to the
journalism that did the verification work, not to ourselves.

## Reply behaviour by outcome

| Outcome | Mention reply | Report quote-post | Reply kind |
|---|---|---|---|
| HITL accept → label emitted | yes | yes | `verdict` |
| HITL reject | no | no | — (we don't amplify proposals a moderator rejected) |
| HITL defer | not yet — if a later accept fires, the verdict reply goes out then | same | — |
| extraction returned no falsifiable claim | **yes** | no | `no-claim` |
| at least one falsifiable claim but no ClaimReview match | **yes** | no | `no-match` |
| target post couldn't be loaded (deleted, AppView unreachable) | **yes** | no | `no-target` |

Diagnostic replies (`no-claim`, `no-match`, `no-target`) bypass
HITL — they're a statement about our own pipeline's behaviour, not
an editorial verdict on the user's content. They are mention-only
because reports don't carry the conversational expectation of a
diagnostic; on report, silence is the right answer.

Dedup is by replied-to URI: at most one reply per source post,
regardless of kind. Enforced across restarts by a unique index on
`mention_reply.replied_to_uri`.

## Internationalisation

Replies are posted in the **target user's language**, picked from
the `langs` field of the post we're addressing (the mention author's
post for mentions, the reported author's post for report
quote-posts).

Currently supported: English (`en`) and German (`de`). BCP-47
region subtags are normalised (`de-AT` → `de`). When the source
post has no `langs`, or uses an unsupported language, the reply
falls back to `LABELER_REPLY_DEFAULT_LANG` (default `en`).

Example diagnostic replies:

```
en  "I couldn't find a falsifiable factual claim in that post — nothing to fact-check."
de  "Ich konnte in dem Beitrag keine prüfbare Tatsachenbehauptung finden — nichts zu prüfen."

en  "I checked, but no fact-check publisher I know of has covered that claim yet."
de  "Ich habe geprüft, aber bislang hat keine mir bekannte Faktencheck-Quelle diese Aussage abgedeckt."

en  "I couldn't load the post you asked about — maybe it was deleted or unavailable."
de  "Ich konnte den verlinkten Beitrag nicht laden — möglicherweise gelöscht oder nicht erreichbar."
```

Verdict replies translate the head as well:

```
en  Verdict: refuted. Sources: CORRECTIV, AFP. Details: https://…
de  Einschätzung: widerlegt. Quellen: CORRECTIV, AFP. Details: https://…
```

To add more languages, extend `TRANSLATIONS` in
`src/replier/i18n.ts` and add the new key to `SUPPORTED_LANGS`.
The picker, format functions, and tests pick it up automatically.

## Delivery is retried

If Bluesky's API rejects the reply (5xx, 429, network error), the
labeler persists the attempt to `reply_queue` instead of dropping
it. A background worker drains the queue every 30 s with
exponential backoff (60 s → 1 h, max 7 attempts) so transient
failures recover on their own. Rows that exhaust all retries land
in `status='failed'` and stop trying.

The dedup check (`hasReplied`) consults both `mention_reply` and
`reply_queue`, so a re-triggered mention while a previous reply is
still queued doesn't enqueue a second job.

## Postgate handling (quote-posts only)

For report quote-posts, the labeler honours the post-author's
postgate setting. If the author published an
`app.bsky.feed.postgate` record with the `disableRule` embedding
rule, the quote-post is skipped and logged at info level:

```
{"level":30, "postUri":"at://...", "msg":"report-quote: author disabled quotes (postgate), skipping"}
```

The label still goes on the wire — only the quote-post is
suppressed.

## Operational notes

- App passwords can be revoked from `bsky.app` settings at any
  time. Revoking a password while the labeler is running will
  surface as a 401 on the next post; the client tries a refresh
  once and then logs the error.
- Bluesky's API has per-account rate limits. A high mention or
  report volume will eventually hit them; failed posts are logged
  but do not block the pipeline.
- All replies and quote-posts use authenticated
  `com.atproto.repo.createRecord` calls. The labels themselves are
  still signed with the labeler's secp256k1 key — the two paths are
  independent.
- The detail link uses `LABELER_DETAIL_BASE_URL` if set, otherwise
  falls back to `LABELER_HOSTNAME`. For a production deploy, set
  `LABELER_DETAIL_BASE_URL` to the public reverse-proxy URL.
