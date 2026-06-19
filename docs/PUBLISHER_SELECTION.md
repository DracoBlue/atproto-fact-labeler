# Publisher selection (allowlist)

The Google Data Commons Fact Check feed is *open submission*. Anyone whose
site emits a valid `ClaimReview` JSON-LD blob gets indexed. In practice this
means the feed mixes IFCN-tier fact-checkers with blogspot/wordpress spam,
SEO sites, gambling pages, and at least one entry whose publisher name field
is an XSS payload. A real production verdict on this labeler was once cited
to a Thai bread-baking blog tagged as a "fact-checker".

To keep the evidence pool trustworthy we ingest only entries whose
`author.url` host matches
[`config/claimreview-publishers-allowlist.txt`](../config/claimreview-publishers-allowlist.txt).
Everything else is dropped at ingest time.

## Editorial implications — read this

**This is an editorial decision, not a technical one.** The allowlist
chooses *which fact-checkers' verdicts you propagate to Bluesky users.*
Excluding a real fact-checker means their verdicts are invisible inside
this labeler — your service silently disagrees with theirs. That is a
real cost and you should look at it with both eyes open.

Defaults reflect three buckets, in roughly decreasing confidence:

1. **IFCN signatories** ([signatory list][ifcn]) — vetted against the
   IFCN code of principles. The strongest external signal of credibility.
2. **Established newsroom fact-check desks** — AFP Fact Check, BBC Verify,
   Washington Post Fact Checker, BR Faktenfuchs, DW Faktencheck, Le Monde
   CheckNews, etc. Not all are IFCN-listed but they sit inside a
   newsroom with corrections policy and named editors.
3. **Verified regional fact-checkers** — projects that don't (or don't
   yet) hold IFCN status but have a track record, named team, and clean
   ClaimReview schema.

Everything outside those three buckets is excluded by default. This
includes some real fact-checkers — likely yours, if you're reading this
and don't see your domain. Add yourself, send a PR.

[ifcn]: https://www.ifcncodeofprinciples.poynter.org/signatories

## File format

```
# comments and blanks ignored
politifact.com                    # exact host
*.factcrescendo.com               # host suffix — matches subdomains AND apex
EXAMPLE.org                       # case-insensitive
```

`www.` is stripped before matching, so list the bare host.

## Adding a publisher

1. Verify they're a real fact-checker — look for IFCN signatory status,
   a corrections policy, named editorial team, and consistent
   `ClaimReview` schema.
2. Add the host (or `*.host` if they use country/language subdomains) to
   the allowlist.
3. Re-ingest: `pnpm ingest`.
4. Re-embed: `pnpm cli:embed-rebuild`.

New publisher entries are picked up on the next ingest; no migration
needed.

## Removing a publisher

1. Delete the line from the allowlist.
2. Run `pnpm cleanup:claims --dry-run` to see what would be removed.
3. Run `pnpm cleanup:claims` to actually drop those rows. The FTS index
   and dependent `evidence` rows clean up via existing triggers.

Already-emitted labels stay on the atproto network — labels are
immutable once posted. The cleanup only affects what *future*
verdicts you can cite.

## Why allowlist and not blocklist

We tried mentally: a blocklist would need to chase every new spam
blogspot URL and every new variant of the same scam, and one missed
entry poisons real verdicts. The cost ratio is asymmetric — false
negatives at ingest (we miss a real fact-checker for a week) recover
the moment someone adds the host; false positives (junk goes into the
evidence pool) directly produce wrong labels on real users' posts.

## Logging

`pnpm ingest` logs both `skipped` (entries missing required fields) and
`skippedByAllowlist` (entries with a known host that isn't on the
allowlist). If `skippedByAllowlist` jumps after a feed update, scan the
data feed for new big-volume publishers — likely a legitimate addition
you want to allow:

```bash
jq -r '.dataFeedElement[].item[].author.url // ""' /data/data.json \
  | awk -F/ '{print $3}' | sort | uniq -c | sort -rn | head -30
```

Compare against the allowlist and PR additions for any large host that
looks legitimate.
