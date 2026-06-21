# Sources — where the fact-checks come from

Per-path operational reference:

- [`own-claimreviews.md`](./own-claimreviews.md) — host your own
  fact-checks as `ClaimReview` JSON-LD on your domain; `pnpm ingest`
  pulls them in.
- [`data-commons.md`](./data-commons.md) — Google Data Commons
  Fact Check feed: ingest, refresh, cleanup, upstream reporting.
- [`factcheck-api.md`](./factcheck-api.md) — Google Fact Check
  Tools API for per-claim live lookups (closes the English
  publisher gap).
- [`atproto-records.md`](./atproto-records.md) — Path 4 (in
  progress): atproto-native ClaimReview records published by
  fact-checkers on their own PDS, discovered via Constellation.

Cross-cutting:

- [`allowlist.md`](./allowlist.md) — the publisher allowlist that
  every intake path routes through; the single editorial chokepoint
  of the labeler.
- [`licensing.md`](./licensing.md) — per-path licensing.

**Why these three paths and not others** (Fact-Check Insights,
Common Crawl, direct crawling, OAuth, RSS) →
[`adr/data-sources.md`](../adr/data-sources.md).
