# Sources — where the fact-checks come from

Per-path operational reference:

- [`own-claimreviews.md`](./own-claimreviews.md) — host your own
  fact-checks as `ClaimReview` JSON-LD on your domain; `pnpm ingest`
  pulls them in.
- [`data-commons.md`](./data-commons.md) — daily Google Data
  Commons Fact Check feed; ingest, refresh, cleanup.
- [`factcheck-api.md`](./factcheck-api.md) — Google Fact Check
  Tools API for per-claim live lookups (closes the English
  publisher gap).
- [`feed-quality.md`](./feed-quality.md) — the publisher allowlist
  as editorial chokepoint; reporting upstream to Google.
- [`licensing.md`](./licensing.md) — per-path licensing.

**Why these three paths and not others** (Fact-Check Insights,
Common Crawl, direct crawling, OAuth, RSS) →
[`adr/data-sources.md`](../adr/data-sources.md).
