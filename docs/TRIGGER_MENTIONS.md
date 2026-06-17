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
   `GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob`.
   The response is converted to an `IngestedPost` and persisted.
4. **Pipeline.**
   - **S1 extract** — LLM extracts one atomic claim:
     `"The earth is flat."`
   - **S2 retrieve** — dense cosine over the embedded ClaimReview index
     returns CORRECTIV's `"Die Erde ist eine Scheibe"` (crosslingual at
     cosine ≈ 0.81), AFP Fact Check's `"the earth is flat"`, Snopes'
     `"Flat Earth claims"`, plus topical neighbours.
   - **S3 entail** — NLI judge classifies each candidate as `entailment`
     (publisher reviewed the same claim) for the three direct hits and
     `neutral` for the topical neighbours.
   - **S4 match** — neutral candidates are dropped, no flip needed
     (entailment passes the publisher verdict through). Aggregation:
     `verdict=false`, `confidence≈0.95`, `votes=3`, `agreement=1.0`.
   - **S5 propose** — proposal #N is pushed to the HITL surface.
5. **HITL.** Reviewer accepts.
6. **Emit.** `@skyware/labeler` signs and persists a `fact-refuted`
   label against **Bob's post URI/CID**. The label streams to subscribers
   on `subscribeLabels`. Alice's reply is **not** labeled — only the
   claim-bearing post is.
7. **Detail page.** Anyone with the post URI can open
   `http://localhost:14831/posts?uri=at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob`
   to see the matched fact-checks with links to CORRECTIV, AFP, Snopes.

## Mention in a quote-post

If Alice **quote-posts** Bob's post and adds `@facts.example.org check this`:

```jsonc
// at://did:plc:alice-abcdef/app.bsky.feed.post/3kxalice
{
  "$type":     "app.bsky.feed.post",
  "text":      "@facts.example.org check this",
  "createdAt": "2026-06-17T10:01:00.000Z",
  "facets": [
    {
      "features": [{
        "$type": "app.bsky.richtext.facet#mention",
        "did":   "did:plc:fact-labeler-abcdef"
      }]
    }
  ],
  "embed": {
    "$type":  "app.bsky.embed.record",
    "record": {
      "uri": "at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob",
      "cid": "bafy-bob"
    }
  }
}
```

`evaluateTrigger` returns
`{ reason: 'mention-quote', targetUri: <Bob's post URI>, targetIsSourcePost: false }`.
The dispatcher resolves Bob's post via AppView and runs the pipeline
against **Bob's quoted claim**, not Alice's commentary. Behaves the same
way as a mention-in-reply.

Quote-with-media (`app.bsky.embed.recordWithMedia`) is supported too —
the inner `record.record.uri` is used.

**Precedence** when a mention post is both a reply and a quote (Alice
replies to Carol with a post quoting Bob):

1. `replyParent` wins — `mention-reply` targets Carol.
2. `quotedRecord` is the fallback — `mention-quote` targets Bob.
3. Neither set → `mention` targets Alice's own post.

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

- **Self-mention** (the labeler account is the post's author):
  **always dropped**, regardless of which triggers are enabled.
  `evaluateTrigger` short-circuits at the top when `post.did` equals
  `LABELER_DID`. This prevents the recursion that
  `REPLY_TO_MENTIONS=true` would otherwise trigger when our own reply is
  carried back through Jetstream, and it also stops the labeler from
  fact-checking its own posts on a watchlist or firehose match.
- **Multiple mentions in one post** (`@facts.example.org @other-bot`):
  the first matching facet wins; other-bot is irrelevant to us.
- **Mention with no claim**: extraction returns zero falsifiable claims;
  the pipeline drops the post silently.
- **Mention of a deleted parent**: AppView fetch returns no post; the
  dispatcher logs a warning and drops.

## Reply to the mention author (opt-in)

By default the labeler stays silent on Bluesky — it only signs labels.
With `REPLY_TO_MENTIONS=true` the labeler also **replies** to Alice's
mention post after a successful label emit, so the user who asked sees
the verdict inline in the thread.

### Setup

This trigger needs the labeler service account to authenticate as a real
Bluesky user (so it can post). Generate an **app password** in the
account's settings (`bsky.app` → Settings → Privacy and Security → App
Passwords). Never use the main account password.

```bash
REPLY_TO_MENTIONS=true
LABELER_BSKY_SERVICE=https://bsky.social
LABELER_BSKY_IDENTIFIER=facts.example.org      # or did:plc:fact-labeler-abcdef
LABELER_BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
LABELER_DETAIL_BASE_URL=https://facts.example.org   # for the deep-link in the reply
```

Config validation fails fast at startup if `REPLY_TO_MENTIONS=true` but
the identifier or app password is missing.

### Conditions

The reply fires only when **all** of:

1. `REPLY_TO_MENTIONS=true`,
2. trigger reason is `mention` or `mention-reply` (never for watchlist /
   firehose / report),
3. a label was actually emitted — i.e. HITL accepted the proposal
   (rejections and defers produce no reply),
4. we haven't already replied to this proposal (one reply per proposal,
   tracked in the `mention_reply` table).

### Example reply payload

After Alice's mention from the example above is accepted by the HITL,
the labeler posts a reply on Alice's PDS, linking **directly to the
original CORRECTIV article**:

```jsonc
// at://did:plc:fact-labeler-abcdef/app.bsky.feed.post/<rkey>
{
  "$type":     "app.bsky.feed.post",
  "text":      "Verdict: refuted. Sources: CORRECTIV, AFP Fact Check, Snopes. Details: https://correctiv.org/faktencheck/wissenschaft/2018/01/30/erde-scheibe-kugel/",
  "createdAt": "2026-06-17T10:01:42.000Z",
  "reply": {
    "parent": {
      "uri": "at://did:plc:alice-abcdef/app.bsky.feed.post/3kxalice",
      "cid": "bafy-alice"
    },
    "root": {
      "uri": "at://did:plc:bob-abcdef/app.bsky.feed.post/3kxbob",
      "cid": "bafy-bob"
    }
  }
}
```

- `parent` points at **Alice's mention** — that's who we're answering.
- `root` is the original thread root, taken from Alice's own
  `replyRoot` if set (Bob's post here) or her post URI otherwise.
- The post body fits inside 280 characters; longer source lists are
  trimmed and the URL preserved.

### Where the `Details:` link points

The link is chosen per-verdict so the user lands one click closer to
the underlying journalism:

| Verdict | Link target |
| --- | --- |
| `supported`, `refuted`, `mixed`, `outdated`, `unknown` | **Top publisher's original article** — taken from `evidence.source_url`, ordered by retrieval cosine after the NLI gate. Most cases are clear and one source's URL is enough. |
| `disputed` | The labeler's **own detail page**. When publishers disagreed enough that we labeled the post as disputed, no single source's URL tells the whole story — the detail page lists every conflicting source side by side. |
| `no-claim`, `no-match` | No link (these replies are short diagnostic messages without a target). |

This matches the labeler's epistemic stance: we route users to the
journalism that did the verification work, not to ourselves.

### Reply behaviour by outcome

| Outcome | Reply | Reply kind |
| --- | --- | --- |
| HITL accept → label emitted | yes | `verdict` |
| HITL reject | no | — (we don't amplify proposals a moderator rejected) |
| HITL defer | no yet — if a later accept fires, the verdict reply goes out then | — |
| extraction returned no falsifiable claim | **yes** | `no-claim` |
| at least one falsifiable claim but no ClaimReview match | **yes** | `no-match` |
| target post couldn't be loaded (deleted, AppView unreachable) | **yes** | `no-target` |

Diagnostic replies (`no-claim`, `no-match`, `no-target`) bypass HITL — they're a
statement about our own pipeline's behaviour, not an editorial verdict on
the user's content. Dedup is by mention-source URI: at most one reply
per Alice's mention post, regardless of kind. Across restarts this is
enforced by a unique index on `mention_reply.replied_to_uri`.

### Internationalisation

Replies are posted in the **mention author's language**, picked from the
`langs` field of Alice's post. Currently supported: English (`en`) and
German (`de`). BCP-47 region subtags are normalised (`de-AT` → `de`).

When the mention post has no `langs`, or uses an unsupported language,
the reply falls back to `LABELER_REPLY_DEFAULT_LANG` (default `en`).

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
`src/replier/i18n.ts` and add the new key to `SUPPORTED_LANGS`. The
picker, format functions, and tests pick it up automatically.

### Reply delivery is retried

If Bluesky's API rejects the reply (5xx, 429, network error), the labeler
persists the attempt to `reply_queue` instead of dropping it. A background
worker drains the queue every 30 s with exponential backoff
(60 s → 1 h, max 7 attempts) so transient failures recover on their own.
Rows that exhaust all retries land in `status='failed'` and stop trying.

The dedup check (`hasReplied`) consults both `mention_reply` and
`reply_queue`, so a re-triggered mention while a previous reply is still
queued doesn't enqueue a second job.

### Operational notes

- App passwords can be revoked from `bsky.app` settings at any time.
  Revoking a password while the labeler is running will surface as a
  401 on the next post; the client tries a refresh once and then logs
  the error.
- Bluesky's API has per-account rate limits. A high mention volume will
  eventually hit them; failed posts are logged but do not block the
  pipeline.
- The reply uses an authenticated `com.atproto.repo.createRecord` call.
  The labels themselves are still signed with the labeler's secp256k1
  key — the two paths are independent.
- The detail link uses `LABELER_DETAIL_BASE_URL` if set, otherwise
  falls back to `LABELER_HOSTNAME`. For a production deploy, set
  `LABELER_DETAIL_BASE_URL` to the public reverse-proxy URL.

## See also

- [TRIGGER_REPORTS.md](./TRIGGER_REPORTS.md) — user reports the post
  via `createReport`.
- [TRIGGER_WATCHLIST.md](./TRIGGER_WATCHLIST.md) — proactively check
  named accounts.
- [TRIGGER_FIREHOSE.md](./TRIGGER_FIREHOSE.md) — check every post (opt-in,
  high cost).
