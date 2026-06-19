# Feed quality — what we filter, how to report, how to refresh

The Google Data Commons Fact Check feed is *open submission*. Anyone whose
site emits a valid `ClaimReview` JSON-LD blob gets indexed. In practice this
means the feed mixes IFCN-tier fact-checkers with blogspot/wordpress spam,
SEO sites, gambling pages, and at least one entry whose publisher name field
is an active XSS injection payload. A real production verdict on this
labeler was once cited to a Thai bread-baking blog tagged as a "fact-checker".

This doc covers the three things you need to do something about that:

1. **Filter** at ingest with a publisher allowlist (this instance).
2. **Report** the obvious garbage upstream to Google so other consumers benefit too.
3. **Refresh** the local instance after upstream cleanup so old junk rows go away.

---

## 1. The publisher allowlist

We ingest only entries whose `author.url` host matches
[`config/claimreview-publishers-allowlist.txt`](../config/claimreview-publishers-allowlist.txt).
Everything else is dropped at ingest time.

### Editorial implications — read this

**This is an editorial decision, not a technical one.** The allowlist
chooses *which fact-checkers' verdicts you propagate to Bluesky users.*
Excluding a real fact-checker means their verdicts are invisible inside
this labeler — your service silently disagrees with theirs. That is a
real cost and you should look at it with both eyes open.

Defaults reflect three tiers, in roughly decreasing confidence:

1. **IFCN signatories** ([signatory list][ifcn]) — vetted against the
   IFCN code of principles. The strongest external signal of credibility.
2. **Established newsroom fact-check desks** — AFP Fact Check, BBC Verify,
   Washington Post Fact Checker, BR Faktenfuchs, DW Faktencheck, Le Monde
   CheckNews, etc. Not all are IFCN-listed but they sit inside a
   newsroom with corrections policy and named editors.
3. **Verified regional fact-checkers** — projects that don't (or don't
   yet) hold IFCN status but have a track record, named team, and clean
   ClaimReview schema.

Everything outside those three tiers is excluded by default. This
includes some real fact-checkers — likely yours, if you're reading this
and don't see your domain. Add yourself, send a PR.

[ifcn]: https://www.ifcncodeofprinciples.poynter.org/signatories

### File format

```
# comments and blanks ignored
politifact.com                    # exact host
*.factcrescendo.com               # host suffix — matches subdomains AND apex
EXAMPLE.org                       # case-insensitive
```

`www.` is stripped before matching, so list the bare host.

### Adding a publisher

1. Verify they're a real fact-checker — IFCN status, corrections
   policy, named editorial team, consistent `ClaimReview` schema.
2. Add the host (or `*.host` if they use country/language subdomains)
   to the allowlist.
3. Re-ingest: `pnpm ingest`.
4. Re-embed: `pnpm cli:embed-rebuild`.

### Removing a publisher

1. Delete the line from the allowlist.
2. Run `pnpm cleanup:claims --dry-run` to see what would be removed.
3. Run `pnpm cleanup:claims` to actually drop those rows. The FTS index
   and dependent `evidence` rows clean up via existing triggers.

Already-emitted labels stay on the atproto network — labels are
immutable once posted. The cleanup only affects what *future*
verdicts you can cite.

If you want the already-emitted labels off the wire too (e.g. the
verdict was sourced from a publisher you've now removed from the
allowlist), follow `pnpm cleanup:claims` with `pnpm retire` — that
negates the live labels and hides the underlying verdict from the
detail page. See
[`LIFECYCLE.md § Phase 3`](LIFECYCLE.md#phase-3--retiring-content-variant-c--emit-negations)
for the full retraction flow.

### Why allowlist and not blocklist

A blocklist would need to chase every new spam blogspot URL and every
new variant of the same scam, and one missed entry poisons real
verdicts. The cost ratio is asymmetric — false negatives at ingest (we
miss a real fact-checker for a week) recover the moment someone adds
the host; false positives (junk goes into the evidence pool) directly
produce wrong labels on real users' posts.

### Spotting candidates for the allowlist

`pnpm ingest` logs both `skipped` (entries missing required fields) and
`skippedByAllowlist` (entries with a host that isn't on the allowlist).
After a feed refresh, scan for big-volume publishers we're dropping:

```bash
jq -r '.dataFeedElement[].item[].author.url // ""' /data/data.json \
  | awk -F/ '{print $3}' | sort | uniq -c | sort -rn | head -30
```

Compare against the allowlist; PR additions for anything large that
looks legitimate.

---

## 2. Reporting upstream to Google

The allowlist patches our local instance. But the same garbage is
sitting in Google's feed where every other consumer ingests it too.
Reporting back is the right thing — Google does curate the compilation
and acts on credible reports.

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

---

## 3. Refreshing after upstream cleanup

Once Google removes a junk entry from the compilation, the **next**
feed download will simply not contain it. But the row is still in our
local SQLite from the previous ingest — `INSERT OR REPLACE` on the next
ingest only updates matching `source_url`s, it doesn't delete absent ones.

You have two paths to clean up:

### A. Allowlist-driven (recommended)

If the publisher wasn't on the allowlist to begin with, the rows are
already disallowed and `pnpm cleanup:claims` removes them. This is the
normal path — the allowlist is the source of truth, regardless of
whether Google upstream still ships the entry.

```bash
docker compose exec fact-labeler pnpm cleanup:claims --dry-run
docker compose exec fact-labeler pnpm cleanup:claims
```

### B. Full rebuild (for major upstream changes)

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

Path B is the heavy hammer — only reach for it when (A) isn't enough.
Already-emitted labels stay on the network; only future evidence
lookups change.

### Cron-friendly periodic refresh

The standard weekly refresh (see [DEPLOY.md § Periodic re-ingest][dep])
already covers the happy case. Adding `cleanup:claims` after the
embed step makes sure allowlist edits propagate even without manual
intervention:

```bash
docker compose run --rm fact-labeler pnpm ingest
docker compose run --rm fact-labeler pnpm cleanup:claims
docker compose run --rm fact-labeler pnpm cli:embed-rebuild
```

[dep]: DEPLOY.md
