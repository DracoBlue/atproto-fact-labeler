# Bulk feed — Google Data Commons Fact Check

The largest intake path: a ~88k-entry compilation of `ClaimReview`
JSON-LD blobs from publishers worldwide. CC BY 4.0 on the compilation.
Excellent non-English coverage (dpa, AFP, Univision El Detector,
factly.in, dozens more). English coverage is weaker — for that, pair
with [`factcheck-api.md`](./factcheck-api.md).

This doc is the operational reference. For *why* the allowlist exists
and what tiers we ship by default, see
[`feed-quality.md`](./feed-quality.md).

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
2. Drops every entry whose `author.url` host is not on
   `config/claimreview-publishers-allowlist.txt`.
3. `INSERT OR REPLACE INTO claim_review` keyed on `source_url`.

Counters logged at end:

- `inserted` — new or updated rows
- `skipped` — entries missing required fields
- `skippedByAllowlist` — entries whose host isn't on the allowlist

`pnpm cli:embed-rebuild` then backfills embeddings for any row where
`embedding IS NULL` or `embedding_model` is outdated. Model swaps are
handled idempotently — only affected rows are re-embedded.

## Allowlist file format

[`config/claimreview-publishers-allowlist.txt`](../../config/claimreview-publishers-allowlist.txt):

```
# comments and blanks ignored
politifact.com                    # exact host
*.factcrescendo.com               # host suffix — matches subdomains AND apex
EXAMPLE.org                       # case-insensitive
```

`www.` is stripped before matching, so list the bare host.

## Adding a publisher

1. Verify they're a real fact-checker — IFCN status, corrections
   policy, named editorial team, consistent `ClaimReview` schema.
2. Add the host (or `*.host` if they use country/language
   subdomains) to the allowlist.
3. Re-ingest: `pnpm ingest`.
4. Re-embed: `pnpm cli:embed-rebuild`.

## Removing a publisher

1. Delete the line from the allowlist.
2. Run `pnpm cleanup:claims --dry-run` to see what would be removed.
3. Run `pnpm cleanup:claims` to actually drop those rows. The FTS
   index and dependent `evidence` rows clean up via existing
   triggers.

Already-emitted labels stay on the atproto network — labels are
immutable once posted. The cleanup only affects what *future*
verdicts you can cite.

If you want already-emitted labels off the wire too (e.g. the
verdict was sourced from a publisher you've removed), follow
`pnpm cleanup:claims` with `pnpm retire` — that negates the live
labels and hides the underlying verdict from the detail page. See
[`../LIFECYCLE.md § Phase 3`](../LIFECYCLE.md#phase-3--retiring-content-variant-c--emit-negations)
for the full retraction flow.

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
[`feed-quality.md § Reporting upstream`](./feed-quality.md#reporting-upstream-to-google).

## Refreshing after upstream cleanup

Once Google removes a junk entry from the compilation, the **next**
feed download will simply not contain it. But the row is still in
our local SQLite from the previous ingest — `INSERT OR REPLACE` on
the next ingest only updates matching `source_url`s, it doesn't
delete absent ones.

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
rows whose `source_url` is no longer present in the current feed,
rebuild from scratch:

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
[`../DEPLOY.md § Periodic re-ingest`](../DEPLOY.md)) already covers
the happy case. Adding `cleanup:claims` after the embed step makes
sure allowlist edits propagate even without manual intervention:

```bash
docker compose run --rm fact-labeler pnpm ingest
docker compose run --rm fact-labeler pnpm cleanup:claims
docker compose run --rm fact-labeler pnpm cli:embed-rebuild
```
