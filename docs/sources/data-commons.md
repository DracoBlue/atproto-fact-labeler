# Google Data Commons Fact Check feed

The largest intake path: a compilation of `ClaimReview` JSON-LD
blobs from publishers worldwide (~92k entries upstream, ~88k after
allowlist filter), distributed as a daily ~60 MB JSON dump. CC BY 4.0 on the compilation. Excellent
non-English coverage (dpa, AFP, Univision El Detector, factly.in,
dozens more). English coverage is weaker — for that, pair with
[`factcheck-api.md`](./factcheck-api.md).

## Why an allowlist is mandatory on this feed

The feed is **open submission**: anyone whose site emits a valid
`ClaimReview` JSON-LD blob gets indexed. In practice this means the
feed mixes IFCN-tier fact-checkers with blogspot/wordpress spam,
SEO sites, gambling pages, and at least one entry whose
publisher-name field is an active XSS injection payload. A real
production verdict on this labeler was once cited to a Thai
bread-baking blog tagged as a "fact-checker".

The publisher allowlist filters the feed at ingest time. Allowlist
mechanics, tier defaults, file format, and add/remove workflow live
in [`allowlist.md`](./allowlist.md) — those apply to every intake
path. This doc covers the bulk-feed-specific operational steps.

## Ingest

```bash
docker compose run --rm fact-labeler sh -c '
  wget -O /data/data.json https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json
'
docker compose run --rm fact-labeler pnpm ingest
docker compose run --rm fact-labeler pnpm cli:embed-rebuild
```

The `pnpm ingest` step does three things:

1. Streams `/data/data.json` with `stream-json` (the file is ~60 MB).
2. Drops every entry whose `author.url` host is not on the
   publisher allowlist.
3. `INSERT OR REPLACE INTO claim_review` keyed on `source_url`.

Counters logged at end:

- `inserted` — new or updated rows
- `skipped` — entries missing required fields
- `skippedByAllowlist` — entries whose host isn't on the allowlist

`pnpm cli:embed-rebuild` then backfills embeddings for any row where
`embedding IS NULL` or `embedding_model` is outdated. Model swaps
are handled idempotently — only affected rows are re-embedded.

## Spotting allowlist candidates

`pnpm ingest` logs both `skipped` (entries missing required fields)
and `skippedByAllowlist` (entries with a host that isn't on the
allowlist). After a feed refresh, scan for big-volume publishers
we're dropping:

```bash
jq -r '.dataFeedElement[].item[].author.url // ""' /data/data.json \
  | awk -F/ '{print $3}' | sort | uniq -c | sort -rn | head -30
```

Compare against the allowlist; PR additions for anything large that
looks legitimate. Anything tiny + obviously not a fact-checker
should also get reported upstream — see
[Reporting upstream to Google](#reporting-upstream-to-google) below.

## Refreshing after upstream cleanup

Once Google removes a junk entry from the compilation, the **next**
feed download won't contain it. But the row is still in our local
SQLite from the previous ingest — `INSERT OR REPLACE` on the next
ingest only updates matching `source_url`s, it doesn't delete
absent ones.

### Allowlist-driven (recommended)

If the publisher wasn't on the allowlist to begin with, the rows
are already disallowed and `pnpm cleanup:claims` removes them. This
is the normal path — the allowlist is the source of truth,
regardless of whether Google upstream still ships the entry.

```bash
docker compose exec fact-labeler pnpm cleanup:claims --dry-run
docker compose exec fact-labeler pnpm cleanup:claims
```

### Full rebuild (for major upstream changes)

When Google reshuffles the feed structure or you want to drop *all*
rows whose `source_url` is no longer present in the current feed:

```bash
# Stop the labeler, snapshot the volume, then:
sqlite3 /data/labeler.sqlite "DELETE FROM claim_review;"

docker compose run --rm fact-labeler sh -c '
  wget -O /data/data.json.new https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json
  mv /data/data.json.new /data/data.json
'
docker compose run --rm fact-labeler pnpm ingest
docker compose run --rm fact-labeler pnpm cli:embed-rebuild
```

Heavy hammer — only reach for it when the allowlist-driven path
isn't enough. Already-emitted labels stay on the network; only
future evidence lookups change.

## Cron-friendly periodic refresh

The standard weekly refresh (see
[`../DEPLOY.md § Periodic re-ingest`](../DEPLOY.md)) covers the
happy case. Chaining `cleanup:claims` after `ingest` makes sure
allowlist edits propagate even without manual intervention:

```bash
docker compose run --rm fact-labeler pnpm ingest
docker compose run --rm fact-labeler pnpm cleanup:claims
docker compose run --rm fact-labeler pnpm cli:embed-rebuild
```

## Reporting upstream to Google

The allowlist patches our local instance. But the same garbage is
sitting in Google's feed where every other consumer ingests it too.
Reporting back is the right thing — Google does curate the
compilation and acts on credible reports.

### Pathways

| What you're reporting | Where to send it |
|---|---|
| **Compilation-level issue** (sites that aren't fact-checkers but show up in the feed; off-topic entries; obvious test data) | `factcheck-support@datacommons.org` |
| **The publishing site itself** (so it's also down-ranked in Search) | [Search spam report][gss] — pick "Spammy structured markup", mention "ClaimReview abuse, not a fact-checker" |
| **Security issue in the feed** (XSS, SSTI, or other injection in any field — we observed one in production) | [Google Bug Hunter Program][bh] *and* `factcheck-support@datacommons.org` *and*, if the host is on `*.blogspot.com`, [Blogger abuse][bla] |

[gss]: https://search.google.com/search/help/report-quality-issues
[bh]: https://bughunters.google.com/
[bla]: https://support.google.com/blogger/answer/76315

### Email template — `factcheck-support@datacommons.org`

Tone: sober, factual, specific URLs as evidence. They've seen this
before; no need to dramatise.

```
Subject: Non-fact-checker entries in Data Commons Fact Check feed

Hi,

We consume the Fact Check feed (storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json)
in an atproto labeling service. While auditing source quality we found
a number of entries whose author.url host is not a fact-checker by any
reasonable reading — blogspot/wordpress blogs, SEO pages, test entries,
plus one entry whose publisher name field carries an active XSS+SSTI
injection payload.

Examples (all from the current feed as of <DATE>):

  1. bakingworldbyswit.blogspot.com — Thai bread-baking blog, publishes
     ClaimReview JSON-LD with publisher name "FC"; not a fact-checker.
     Sample entry: <ENTRY-URL>

  2. videoblogtestx.blogspot.jp — appears to be a test artefact;
     publisher name "Video Test".
     Sample entry: <ENTRY-URL>

  3. 69bot69.blogspot.com — publisher name field contains an active
     XSS+SSTI injection payload:
       http://69bot69.blogspot.com/?{{[[a'12321t1z7xqqq]]}}11<img src=xt1z7x onerror=print(1)>
     Any consumer that renders this field without escaping is vulnerable.
     (Reported separately to Google Bug Hunters.)

  4. <…further examples…>

For each we believe the entry should be removed from the compilation.
For #3 we also suggest reviewing whether unescaped JSON-LD strings in
publisher names should be sanitised before publication.

Happy to share the full list of suspect hosts our audit surfaced
(approx. <N> domains) if useful.

Thanks,
<NAME>
```

Adjust the count and the examples. Don't pad the list — three crisp
examples plus an offer to share the full set lands better than a
40-line dump.

### Security report — `bughunters.google.com`

For the XSS payload entry, file via the Bug Hunter Program. Useful
report skeleton:

```
Product: Google Data Commons Fact Check feed
Type: Stored XSS via republished third-party content

Summary
-------
The public Fact Check feed
(https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json)
republishes attacker-controlled HTML+JS payloads in ClaimReview
publisher.name and author.url fields. Any consumer rendering these
fields without escaping is vulnerable.

Reproduction
------------
Search the feed for:
  jq '.dataFeedElement[].item[] | select(.author.url | contains("69bot69"))' data.json
Observed payload in the author.url field:
  http://69bot69.blogspot.com/?{{[[a'12321t1z7xqqq]]}}11<img src=xt1z7x onerror=print(1)>

The same domain also carries an SSTI probe in the URL path.

Impact
------
Any downstream consumer (search-result fact-check panels, third-party
dashboards, atproto labelers, news-aggregator widgets) that does not
HTML-escape these fields will execute attacker JS in the embedding
context.

Suggested fix
-------------
1. Reject ClaimReview entries whose JSON-LD string fields contain HTML
   tags or template-injection markers at compilation time.
2. Remove the existing offending entries from the public feed.
```
