# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue.**

Email the maintainer (see `package.json` `author`) with:

- a short summary of the issue,
- repro steps or a proof-of-concept,
- which commit / release tag you tested against,
- your assessment of impact.

You should hear back within a week. Coordinated disclosure is the
default — we aim to publish a fix and credit you (unless you ask not to
be named) before the details become public.

## In scope

- Anything that lets a remote party run code on, exfiltrate secrets
  from, or DoS a running labeler instance.
- Authentication bypass on `/xrpc/com.atproto.moderation.createReport`
  (the report endpoint) — the JWT verifier is in
  `src/util/atproto-jwt.ts`.
- Cross-site scripting in the `/posts` detail page. The detail page
  echoes back attacker-controlled post text and third-party publisher
  fields; we escape with `escapeHtml` and also send strict CSP-style
  headers, but a confirmed bypass is in scope.
- SQL injection through any pipeline path — all queries should be
  parameterised (`better-sqlite3` prepared statements).
- Signing-key handling — the labeler key is a secp256k1 secret used
  for label provenance.

## Out of scope

- Issues that require shell access to the host the labeler is running
  on. That's already game-over by the time you have it.
- Bugs in third-party fact-checker articles that we cite. We surface
  their verdicts; their editorial mistakes are upstream.
- Spam or low-quality entries in the Google Data Commons Fact Check
  feed itself. Those are documented in
  [`docs/sources/feed-quality.md`](docs/sources/feed-quality.md), filtered with the
  publisher allowlist, and reported upstream via
  `factcheck-support@datacommons.org`. They're not vulnerabilities in
  this codebase.
- Denial of service via crafted gigabyte-sized posts arriving on the
  trigger endpoints. Upstream Bluesky rate limits cap that at the AT
  Protocol level.

## What we already do

- `tools.ozone.moderation.emitEvent` only accepts the labeler's own DID
  (`src/labels/server.ts`). Any third-party Bluesky JWT — even a valid
  one — is rejected, so no caller can use the labeler's signing key to
  forge labels on arbitrary posts.
- The detail page (`src/detail/server.ts`) HTML-escapes every dynamic
  field, restricts `href` URLs to `http(s):` (so a `javascript:` /
  `data:` URL in feed content cannot ride into a clickable link), and
  sets `<meta name="robots" content="noindex,nofollow,noarchive,
  nosnippet">` plus `X-Robots-Tag` header so search engines don't
  index rendered attacker content.
- The `createReport` endpoint verifies the issuer's atproto service
  JWT against the PLC-resolved signing key (`src/util/atproto-jwt.ts`):
  low-S enforcement, `iat`/`exp`/`aud`/`lxm` checks, an in-memory
  `(iss, jti)` replay cache, and a per-call timeout on DID resolution.
  `did:web` is refused by default — opt in only when you specifically
  need self-hosted-PDS reporters — and when allowed, hostnames that
  resolve to loopback / RFC1918 / link-local / cloud-metadata addresses
  are blocked to prevent SSRF.
- The freshly-generated signing key is written to `.env` with `mode
  0o600` and `chmod`ed on update, so the secret isn't world-readable
  on shared hosts.
- All SQLite calls use prepared statements; the one place where an
  identifier is interpolated (`PRAGMA table_info`) is guarded by an
  identifier-allowlist regex.
- The publisher allowlist (`config/claimreview-publishers-allowlist.txt`)
  filters out the obvious junk publishers at ingest, including an
  observed XSS-payload entry in the Google feed.
- Dependencies are tracked by Dependabot (`.github/dependabot.yml`)
  with weekly minor/patch group PRs.
