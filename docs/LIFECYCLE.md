# Operator Lifecycle

You must understand the **full lifecycle** before running this in production:
online, paused, retired, cleared. Atproto labels are durable signed objects
— turning the service off does **not** make them go away. The four phases
below cover every transition you'll actually need.

For the **infrastructure** side (DNS, reverse proxy, persistent storage,
Coolify / Caddy / Traefik specifics, going-live checklist), see
[`DEPLOY.md`](./DEPLOY.md). This file is the **Bluesky-side** lifecycle —
skyware setup, retire, clear. The two are independent; DEPLOY.md happens
first, then LIFECYCLE.md Phase 1.

## Phase 1 — Going online (one-time setup)

To make the labels visible to real Bluesky users:

1. Create a dedicated Bluesky **service account** at `bsky.app` (or your
   chosen PDS — Eurosky, a self-hosted PDS, etc.). This is distinct from
   your personal account. Set `LABELER_BSKY_SERVICE` in `.env` to the
   account's actual PDS URL (e.g. `https://bsky.social`,
   `https://eurosky.social`). You can verify by resolving the account's
   handle to a DID, then fetching the DID document from
   `https://plc.directory/did:plc:...` and reading the
   `service[type='AtprotoPersonalDataServer'].serviceEndpoint` field.
2. Register the labeler endpoint + signing key in the account's DID
   document:
   ```bash
   pnpm dlx @skyware/labeler setup
   ```
   Skyware asks for the service-account credentials and a PLC token
   (mailed to the account's address) and either generates a signing key
   or uses the one in `.env`. Persist the signing key.
3. Declare every label value in `app.bsky.labeler.service`.
   `@skyware/labeler` exposes this as `label edit` which expects the
   full label-array on stdin (not one-at-a-time interactive prompts).
   The labeler ships a canonical six-label JSON for our `fact-*`
   vocabulary — paste it into the editor that opens:
   ```bash
   pnpm dlx @skyware/labeler label edit
   # On the prompt, paste the array from labels.json (see below) and save.
   ```

   <details>
   <summary>labels.json (paste this array into `label edit`)</summary>

   ```json
   [
     {
       "identifier": "fact-supported",
       "severity": "inform",
       "blurs": "none",
       "defaultSetting": "inform",
       "adultOnly": false,
       "locales": [
         { "lang": "en", "name": "Fact-supported", "description": "Independent fact-checkers have supported this claim." },
         { "lang": "de", "name": "Faktencheck: bestätigt", "description": "Unabhängige Faktenchecker haben diese Aussage bestätigt." }
       ]
     },
     {
       "identifier": "fact-refuted",
       "severity": "inform",
       "blurs": "none",
       "defaultSetting": "warn",
       "adultOnly": false,
       "locales": [
         { "lang": "en", "name": "Fact-refuted", "description": "Independent fact-checkers have refuted this claim." },
         { "lang": "de", "name": "Faktencheck: widerlegt", "description": "Unabhängige Faktenchecker haben diese Aussage widerlegt." }
       ]
     },
     {
       "identifier": "fact-disputed",
       "severity": "inform",
       "blurs": "none",
       "defaultSetting": "warn",
       "adultOnly": false,
       "locales": [
         { "lang": "en", "name": "Fact-disputed", "description": "Fact-checkers disagree about this claim." },
         { "lang": "de", "name": "Faktencheck: umstritten", "description": "Faktenchecker sind sich uneinig über diese Aussage." }
       ]
     },
     {
       "identifier": "fact-mixed",
       "severity": "inform",
       "blurs": "none",
       "defaultSetting": "warn",
       "adultOnly": false,
       "locales": [
         { "lang": "en", "name": "Fact-mixed", "description": "Independent fact-checkers found this claim partially true and partially false." },
         { "lang": "de", "name": "Faktencheck: teils-teils", "description": "Unabhängige Faktenchecker fanden diese Aussage teils richtig, teils falsch." }
       ]
     },
     {
       "identifier": "fact-outdated",
       "severity": "inform",
       "blurs": "none",
       "defaultSetting": "warn",
       "adultOnly": false,
       "locales": [
         { "lang": "en", "name": "Fact-outdated", "description": "This claim was accurate at the time it was reviewed but is no longer current." },
         { "lang": "de", "name": "Faktencheck: veraltet", "description": "Diese Aussage war zum Prüfzeitpunkt korrekt, ist aber inzwischen veraltet." }
       ]
     },
     {
       "identifier": "fact-unknown",
       "severity": "inform",
       "blurs": "none",
       "defaultSetting": "inform",
       "adultOnly": false,
       "locales": [
         { "lang": "en", "name": "Fact-unknown", "description": "Fact-checkers could not establish whether this claim is true or false." },
         { "lang": "de", "name": "Faktencheck: unbekannt", "description": "Faktenchecker konnten nicht feststellen, ob diese Aussage wahr oder falsch ist." }
       ]
     }
   ]
   ```

   The same JSON is checked in at
   [`config/labels.json`](../config/labels.json) for re-use during
   upgrades.

   </details>

   Per-field meaning, condensed from
   [atproto.com/specs/label](https://atproto.com/specs/label):

   - `severity: inform` — informational label, not moderation. The
     client may surface a small badge or footnote.
   - `blurs: none` — never hide the post or media; we only annotate.
   - `defaultSetting` — per label. `inform` for the positive /
     uncertain cases (`fact-supported`, `fact-unknown`), `warn` for the
     four that flag a problem (`fact-refuted`, `fact-disputed`,
     `fact-mixed`, `fact-outdated`).
   - `adultOnly: false` — not an adult-content label.
   - `locales` — at minimum `en`. We also ship `de` because the
     replier (mention-reply) already speaks both languages; add more
     locales as the labeler picks up additional reply translations.
4. Start the service:
   ```bash
   pnpm run start
   ```

Subscribers (Bluesky AppView, on behalf of opted-in users) open a long-lived
WebSocket against `subscribeLabels` and stay connected. Labels emitted from
this point on flow to them in real time. AppViews backfill from `cursor=0`
on first subscribe.

## Phase 2 — Pausing emissions (variant A & B — temporary)

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

## Phase 3 — Retiring content (variant C — emit negations)

When labels were emitted in error, or you want to take them off the wire
without removing the labeler entirely. Use the built-in retire CLI:

```bash
# 1. Preview what would be negated (server can stay running for this)
pnpm run retire:check               # alias for retire --dry-run
# or
pnpm tsx src/cli/retire.ts --dry-run

# 2. Stop the live labeler — retire signs + emits through its own
#    LabelerServer instance, which needs the same port and writes to the
#    same labels.db. Two processes on labels.db would race.
docker compose stop fact-labeler

# 3. Apply (signs and emits a neg=true companion for every live label).
#    `compose run --rm` spawns a fresh container that doesn't publish ports
#    so the bind itself is clean too.
docker compose run --rm fact-labeler pnpm retire

# 4. Bring the labeler back up.
docker compose start fact-labeler

# Filters work in both --dry-run and apply forms:
docker compose run --rm fact-labeler pnpm retire --val=fact-refuted
docker compose run --rm fact-labeler pnpm retire --uri=at://did:plc:.../app.bsky.feed.post/3kx
```

If you forget to stop the labeler first, the retire CLI detects the
EADDRINUSE on its own start() and prints the recipe above instead of a
raw stack trace.

Each negation is a real, signed atproto label with `neg=true`. AppViews
stop hydrating the original on next sync. End users stop seeing the badge.
The original signed label is **not** deleted — the negation simply
overrides it on read. This matches the protocol: see
`com.atproto.label.defs#label.neg` and the spec at
<https://atproto.com/specs/label>.

The retire CLI is **idempotent**. Re-running after a partial crash skips
already-negated labels.

### Local side-effects of `retire`

`retire` doesn't just emit on the wire. To keep the local detail page
(`/posts?uri=...`) in sync with what users see in Bluesky, the CLI also
**marks the matching `verdict` row as retired** by stamping
`verdict.retired_at = datetime('now')`. The detail server then **omits**
those verdicts entirely from both HTML and JSON output.

That's intentional. The detail page surfaces post text, claim text and
publisher URLs verbatim. If a verdict was emitted in error — e.g.
sourced from a fact-checker we later distrust, or from an entry that
turned out to be spam-injected — keeping the URL visible as plain text
is a reputation risk on its own (Google's quality systems penalise
hosts that prominently link to junk, regardless of whether the link is
clickable or `rel="nofollow"`). Hiding the retired verdict is the
safest default.

The detail page additionally only shows verdicts whose `status =
'accepted'` — anything still in `proposed` is in-flight pipeline state
that may yet be rejected by HITL or superseded, and a public URL is
the wrong place to surface it. Use `pnpm lifecycle:status` (or direct
SQL on `verdict`) to inspect proposed state.

The original verdict row is **not** deleted. `retired_at` is just a
timestamp column; you can `SELECT * FROM verdict WHERE retired_at IS
NOT NULL` to inspect the audit trail. Likewise the `label_emit` table
keeps both the original positive row and the negation, so the on-wire
history is preserved.

The retire CLI prints both numbers:

```
retire complete  negated=12  verdictsRetired=12
```

`verdictsRetired` ≤ `negated`: a label can only be retired in the
detail page if the underlying verdict still exists in this DB. Labels
emitted by previous instances or rebuilt-from-scratch DBs may have
`verdictsRetired = 0` even with a non-zero `negated`.

### Detail page is not crawled

The detail server sets `<meta name="robots" content="noindex, nofollow,
noarchive, nosnippet">` in every HTML response and an `X-Robots-Tag`
header on every `/posts` response (HTML + JSON). A `robots.txt` at the
root disallows the entire host. This is belt-and-suspenders: detail
pages quote attacker-controlled content (post text + third-party URLs)
and we don't want any of them in any search index.

## Phase 4 — Clearing the labeler declaration (variant D — permanent)

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

## Lifecycle status at any time

```bash
pnpm run lifecycle:status
```

Prints identity, on-wire counts, per-value live/retired counts, and a list
of recommended next steps based on current state. Safe to run any time.

## Cheat sheet

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
