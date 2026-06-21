# The publisher allowlist as editorial chokepoint

The labeler reaches Bluesky users with **labels signed by the operator**.
That signal is only as good as the verdicts behind it, and the verdicts
are only as good as the publishers we cite. The publisher allowlist is
where editorial responsibility actually lives.

This doc explains *why* the allowlist exists and what tiers we ship by
default. For the operational mechanics — file format, ingest CLI,
refresh after upstream changes, periodic cron — see
[`bulk-feed.md`](./bulk-feed.md).

## The fact-check feed is open submission

The Google Data Commons Fact Check feed is the bulk path most
fact-check projects use ([why three intake paths](./README.md)). It is
**open submission**: anyone whose site emits a valid `ClaimReview`
JSON-LD blob gets indexed. In practice this means the feed mixes
IFCN-tier fact-checkers with blogspot/wordpress spam, SEO sites,
gambling pages, and at least one entry whose publisher-name field is
an active XSS injection payload. A real production verdict on this
labeler was once cited to a Thai bread-baking blog tagged as a
"fact-checker".

Without a filter, the labeler would silently propagate that to Bluesky
users with the operator's signature on it. The allowlist is the
filter.

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
