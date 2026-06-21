# The publisher allowlist

[`config/claimreview-publishers-allowlist.txt`](../../config/claimreview-publishers-allowlist.txt)
is the **single editorial chokepoint** of the labeler. Every intake
path — own ClaimReviews, the Data Commons bulk feed, the Fact Check
Tools API — routes new entries through it. Anything whose
`author.url` host isn't on the allowlist is dropped at ingest.

This doc covers the cross-cutting allowlist concerns. Per-path
operational mechanics (ingest CLI, refresh, cleanup) live in each
path's own doc.

## The three editorial tiers we ship by default

Defaults reflect three tiers, in roughly decreasing confidence:

1. **IFCN signatories** ([signatory list][ifcn]) — vetted against the
   IFCN code of principles. The strongest external signal of
   credibility.
2. **Established newsroom fact-check desks** — AFP Fact Check, BBC
   Verify, Washington Post Fact Checker, BR Faktenfuchs, DW
   Faktencheck, Le Monde CheckNews, etc. Not all are IFCN-listed but
   they sit inside a newsroom with corrections policy and named
   editors.
3. **Verified regional fact-checkers** — projects that don't (or
   don't yet) hold IFCN status but have a track record, named team,
   and clean ClaimReview schema.

Everything outside those three tiers is excluded by default. This
includes some real fact-checkers — likely yours, if you're reading
this and don't see your domain. Add yourself, send a PR.

[ifcn]: https://www.ifcncodeofprinciples.poynter.org/signatories

## This is an editorial decision

**The allowlist chooses which fact-checkers' verdicts you propagate
to Bluesky users.** Excluding a real fact-checker means their
verdicts are invisible inside this labeler — your service silently
disagrees with theirs. That is a real cost and you should look at it
with both eyes open.

Operators who fork this project and run their own labeler should
review the allowlist *before* their first label hits the wire. The
default reflects our editorial line; yours may legitimately differ.

## Why allowlist and not blocklist

A blocklist would need to chase every new spam blogspot URL and
every new variant of the same scam, and one missed entry poisons
real verdicts. The cost ratio is asymmetric — false negatives at
ingest (we miss a real fact-checker for a week) recover the moment
someone adds the host; false positives (junk goes into the evidence
pool) directly produce wrong labels on real users' posts.

Allowlist is the safe failure mode: a publisher we miss is silently
ignored. Blocklist would mean a publisher we forget to block becomes
load-bearing in a wrong verdict.

## File format

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
3. Re-ingest the affected path:
   - Bulk feed → `pnpm ingest` + `pnpm cli:embed-rebuild`
     (details: [`data-commons.md`](./data-commons.md))
   - Own ClaimReviews → `pnpm ingest <your-file.json>`
     (details: [`own-claimreviews.md`](./own-claimreviews.md))
   - Live API → no re-ingest needed; the next query picks it up

## Removing a publisher

1. Delete the line from the allowlist.
2. `pnpm cleanup:claims --dry-run` shows what would be removed.
3. `pnpm cleanup:claims` drops those rows. FTS index + dependent
   `evidence` rows clean up via existing triggers.

Already-emitted labels stay on the atproto network — labels are
immutable once posted. Cleanup only affects what *future* verdicts
you can cite.

If you want already-emitted labels off the wire too, follow
`pnpm cleanup:claims` with `pnpm retire` — that negates the live
labels and hides the underlying verdict from the detail page. See
[`../LIFECYCLE.md § Phase 3`](../LIFECYCLE.md#phase-3--retiring-content-variant-c--emit-negations).
