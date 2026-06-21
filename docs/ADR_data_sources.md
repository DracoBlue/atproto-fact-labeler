# ADR: Data sources — where fact-checks come from

**Status**: accepted · 2026-06-20

**Context**

The labeler is a *router*, not a judge — it only emits a label when an
independent publisher has already reviewed the claim. That makes the
choice of data sources the highest-leverage decision in the whole
project. A thin source pool produces silence; a noisy source pool
produces wrong labels at scale. Neither is acceptable.

Three properties matter:

1. **Coverage** — how many real fact-checks the operator can match
   against. Especially in English, where the bulk of the
   conspiracy/disinformation pressure on Bluesky sits.
2. **Quality** — entries must be from real fact-checkers, not
   SEO-spam blogs that copy-paste ClaimReview JSON-LD onto unrelated
   pages. We've observed entries with active XSS payloads in
   publisher-name fields.
3. **Licensing posture** — the operator can host this without an
   explicit per-deployment licence negotiation. Open-source
   contributors run their own instances; they can't be expected to
   sign per-organisation agreements.

Plus two practical constraints:

- **Operator effort to onboard**: more than ~5 minutes of setup loses
  contributors and self-hosters.
- **Operational stability**: the labeler is a long-running service.
  Sources that can vanish silently from one day to the next (private
  scrapes, undocumented APIs) make for a fragile production posture.

**Decision**

Three independent intake paths, configurable per deployment, each
filling a gap the others have. A fourth path is in flight as the
project moves to atproto-native records (see
[`kiesel-app/facts`](https://github.com/kiesel-app/facts)).
All paths route through the same
[`config/claimreview-publishers-allowlist.txt`](../config/claimreview-publishers-allowlist.txt)
so the editorial bar stays identical regardless of intake.

| Path | What | When to enable | Coverage | Licence |
| --- | --- | --- | --- | --- |
| **1. Own ClaimReviews** | Single-item or N-item schema.org DataFeed JSON, ingested via `pnpm ingest` | The operator runs a newsroom / NGO that already publishes ClaimReview-tagged articles | unbounded by operator | Operator's choice |
| **2. Google Data Commons bulk feed** | Daily ~60 MB public JSON dump, ingested via `pnpm ingest data.json` | Default; strong on non-English (dpa, AFP, Univision, factly.in, …) | ~88 k after allowlist, refreshed daily | CC BY 4.0 compilation, per-entry publisher copyright |
| **3. Google Fact Check Tools API (`claims:search`)** | Live per-claim HTTP query, activated by `FACTCHECK_API_KEY` | Recommended; closes the English-publisher gap (Lead Stories, USA Today, Snopes, AAP all here) | the full Google Fact Check Explorer index | Google API ToS, accepted by the operator's GCP project |
| **4. Atproto-native ClaimReview records** *(in progress)* | Publishers writing `app.kiesel.facts.claimReview` records to their own PDS; consumers discover them via Constellation backlinks. Same shape as schema.org/ClaimReview. | When fact-checkers move onto atproto themselves; gives publishers full control over their entries (correctable, supersedeable) without a JSON-LD-on-website round-trip. | grows as adopters appear | Publisher's choice on per-record `sdLicense`. |

Per-path setup, caching, and ToS implications:

- **Path 1** — [`OWN_FACT_CHECKS.md`](OWN_FACT_CHECKS.md)
- **Path 2** — [`FEED_QUALITY.md`](FEED_QUALITY.md) + [`LICENSING.md § Path 2`](LICENSING.md#path-2--google-data-commons-bulk-feed)
- **Path 3** — [`FACTCHECK_API.md`](FACTCHECK_API.md) + [`LICENSING.md § Path 3`](LICENSING.md#path-3--google-fact-check-tools-api-claimssearch)

The default deployment runs Path 2 + Path 3 — they're independent
upstreams (different licence, different infrastructure) so a Google
outage on one doesn't take down the other. Path 1 is additive for
operators who have their own content.

**Alternatives considered**

### Fact-Check Insights (MediaVault) — rejected

[Fact-Check Insights][fci] (powered by Full Fact + Maldita.es, with
Duke Reporters' Lab tracking) is the obvious "more publishers than
the bulk feed" candidate. Tens of thousands of entries, daily
updates, JSON + CSV.

Rejected because the [Terms of Service][fci-tos] explicitly forbid
"redistribution of downloaded content from MediaVault and the use of
the service to develop commercial products based on the obtained
data" and require [contacting][fci-contact] for "products, research,
external integrations" — which is exactly what a labeler is.

A per-deployment written agreement with Maldita/Full Fact is feasible
for a single instance (a newsroom that wants to use it), but it's
incompatible with an open-source project where any operator can spin
up their own labeler. The licensing terms are project-disqualifying,
not operator-disqualifying.

Operators who *do* have a relationship with Maldita/Full Fact and the
written permission to use the data can plug it in via Path 1 (drop
the data into an own DataFeed file and `pnpm ingest`) — the
labeler doesn't impose any limit there.

### Common Crawl filter — rejected (for now)

Common Crawl publishes monthly web crawls; a filter for
`<script type="application/ld+json">` blocks containing `ClaimReview`
would yield raw ClaimReview JSON-LD from every publisher that
embeds it. No licence layer beyond per-entry publisher copyright
(the same layer we already have).

Rejected at this time because:
- Crawl latency is monthly, not daily.
- Filtering 1 TB+ of Common Crawl per month is operationally heavy.
  Path 3 closes the same coverage gap with a single API call per
  claim, on demand, for free.
- A future revisit becomes useful if Google retires the Fact Check
  Tools API or the Data Commons feed (both are possible; Google has
  already deprecated ClaimReview as a Search rich-result).

### Direct crawling per publisher — rejected

Building a per-publisher scraper for Lead Stories, USA Today,
Snopes etc. would give us the most coverage. Rejected because:
- ToS risk per site.
- High maintenance burden — every layout change breaks a scraper.
- Path 3 returns the same content via Google's own index without
  any scraping.

### OAuth / service-account for `claims:search` — rejected by Google

Empirically tested:
- API key only (`?key=...`) → 200 OK
- Service-account JWT bearer + valid GCP role → 400 INVALID_ARGUMENT
- User OAuth bearer + valid scope → 400 INVALID_ARGUMENT
- Bearer **and** API key together → 400 INVALID_ARGUMENT (bearer
  rejected even with a valid key)

The endpoint actively refuses bearer auth. Operator setup is
necessarily a single GCP API key, restricted to
`factchecktools.googleapis.com`. Documented in
[`FACTCHECK_API.md`](FACTCHECK_API.md).

### Public fact-checker organisations' RSS feeds — rejected

A few publishers expose ClaimReview-rich RSS or sitemap feeds. They
would each be a per-publisher integration with no central index, no
unified format guarantees, and no automatic onboarding for new
publishers. Path 3 returns these same publishers' content via a
single API endpoint Google already curates.

**Consequences**

- **No operator paperwork required by default.** Path 2 (CC BY 4.0 on
  the compilation) and Path 3 (Google API ToS accepted at GCP
  project creation by the operator themselves) both onboard in
  minutes without project-side approvals.
- **The allowlist is the single editorial chokepoint.** All three
  paths feed `claim_review` through the same
  [`PublisherAllowlist`](../src/ingest/publisher-allowlist.ts), so
  decisions about which publishers count are made once, not three
  times.
- **Coverage is the union of enabled paths.** Operators who only run
  Path 2 will hit the documented English-publisher gap (Lead
  Stories etc. are missing). Operators who add Path 3 close it; the
  empirical "the earth is round" case demonstrates this end-to-end.
- **Source provenance survives downstream.** Every `claim_review`
  row carries an `attribution` column naming the publisher and the
  intake path. The detail page renders it. An auditor reviewing an
  emitted label can trace each piece of evidence to its origin.
- **The project survives any one upstream failing.** Path 1 has no
  Google dependency at all. Path 2 + Path 3 are independent Google
  systems; an API outage on one doesn't take both down. A medium-term
  upstream loss (e.g. Google retires the bulk feed) would degrade
  coverage but not break the service.

[fci]: https://www.factcheckinsights.org/
[fci-tos]: https://www.factcheckinsights.org/terms
[fci-contact]: https://www.factcheckinsights.org/users/sign_in
