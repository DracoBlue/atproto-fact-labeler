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
  [`docs/FEED_QUALITY.md`](docs/FEED_QUALITY.md), filtered with the
  publisher allowlist, and reported upstream via
  `factcheck-support@datacommons.org`. They're not vulnerabilities in
  this codebase.
- Denial of service via crafted gigabyte-sized posts arriving on the
  trigger endpoints. Upstream Bluesky rate limits cap that at the AT
  Protocol level.

## What we already do

- The detail page (`src/detail/server.ts`) HTML-escapes every dynamic
  field and sets `<meta name="robots" content="noindex,nofollow,
  noarchive,nosnippet">` plus `X-Robots-Tag` header so search engines
  don't index the rendered attacker content.
- The `createReport` endpoint verifies the issuer's atproto service
  JWT against the PLC-resolved signing key (`src/util/atproto-jwt.ts`).
- All SQLite calls use prepared statements.
- The publisher allowlist (`config/claimreview-publishers-allowlist.txt`)
  filters out the obvious junk publishers at ingest, including an
  observed XSS-payload entry in the Google feed.
- Dependencies are tracked by Dependabot (`.github/dependabot.yml`)
  with weekly minor/patch group PRs.
