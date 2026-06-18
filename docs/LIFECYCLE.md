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

1. Create a dedicated Bluesky **service account** at `bsky.app`. This is
   distinct from your personal account.
2. Register the labeler endpoint + signing key in the account's DID
   document:
   ```bash
   pnpm dlx @skyware/labeler setup
   ```
   Skyware asks for the service-account credentials and a PLC token
   (mailed to the account's address) and either generates a signing key
   or uses the one in `.env`. Persist the signing key.
3. Declare every label value in `app.bsky.labeler.service`:
   ```bash
   pnpm dlx @skyware/labeler label add
   # Repeat for each fact-* value: severity, blur, defaultSetting, locales
   ```
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
# 1. Preview what would be negated
pnpm run retire:check               # alias for retire --dry-run
# or
pnpm tsx src/cli/retire.ts --dry-run

# 2. Apply (signs and emits a neg=true companion for every live label)
pnpm run retire
# or
pnpm tsx src/cli/retire.ts

# Filter to a single label value:
pnpm tsx src/cli/retire.ts --val=fact-refuted

# Filter to a single post:
pnpm tsx src/cli/retire.ts --uri=at://did:plc:.../app.bsky.feed.post/3kx
```

Each negation is a real, signed atproto label with `neg=true`. AppViews
stop hydrating the original on next sync. End users stop seeing the badge.
The original signed label is **not** deleted — the negation simply
overrides it on read. This matches the protocol: see
`com.atproto.label.defs#label.neg` and the spec at
<https://atproto.com/specs/label>.

The retire CLI is **idempotent**. Re-running after a partial crash skips
already-negated labels.

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
