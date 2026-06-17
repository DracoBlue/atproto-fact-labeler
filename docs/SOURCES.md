# Fact-Check Sources to Ingest

> What we ingest instead of running full verification ourselves. Compiled
> 2026-06-16 from a multi-source adversarially-verified research pass
> (20 sources, 71 claims extracted, 25 verified 3-vote, **0 refuted**).
>
> Companion to [`EPISTEMICS.md §2.1.2`](./EPISTEMICS.md) — these are the
> "External fact-check feeds (direct passthrough)" channel.

## TL;DR

**The single highest-leverage ingestion path is Google's
ClaimReview ecosystem.**

- **Google Data Commons Fact Check feed** — daily-refreshed JSON DataFeed
  at a stable public URL, CC BY 4.0 on the compilation, no API key needed.
- **Google Fact Check Tools Claim Search API** — query-based lookup over
  the same dataset, API-key-gated, supports per-publisher filtering
  (`reviewPublisherSiteFilter`).
- Combined: covers **CORRECTIV, dpa, Snopes, PolitiFact, AFP, Full Fact**
  and ~140 other publishers across 39 languages and 205k+ fact-checks.
- Direct publisher APIs are largely absent — **dpa specifically has no
  public fact-check API** (B2B-consulting only). Same likely true for most
  others. Google's aggregator is therefore not just convenient, it's the
  *de facto* only path for most publishers.
- For verdict normalization across publishers: **Snopes vs. PolitiFact agree
  on 69.6 % of matching claims, only 1 of 749 is truly conflicting** — the
  ~30 % divergence is taxonomy/timing, not factual disagreement. A
  cross-publisher rating taxonomy is mandatory but tractable.

## 1. Google ClaimReview ecosystem (top priority)

### 1.1 Google Data Commons Fact Check feed

- **Endpoint** (live, returns >10 MB JSON):
  <https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json>
- **Format:** Schema.org `DataFeed` containing `ClaimReview` entries.
- **Refresh:** daily.
- **License:** **CC BY 4.0** on the compilation (attribution required,
  redistribution and commercial use permitted). Individual ClaimReview
  entries may carry their own license via the `sdLicense` field.
- **Auth:** none — plain HTTPS GET.
- **Docs:** <https://datacommons.org/factcheck/faq>,
  <https://datacommons.org/factcheck/download>

→ **This is the default ingestion path.** Pull daily, diff against previous
snapshot, upsert new/updated entries into our evidence store.

### 1.2 Google Fact Check Tools — Claim Search API

- **Endpoint:** `GET https://factchecktools.googleapis.com/v1alpha1/claims:search`
- **Auth:** API key.
- **Params:**
  - `query` (free-text claim search; required unless `reviewPublisherSiteFilter` set)
  - `languageCode` (e.g. `de`, `en`)
  - `reviewPublisherSiteFilter` (e.g. `correctiv.org`, `dpa-factchecking.com`, `snopes.com`)
  - `pageSize`, `pageToken`, `offset`
- **Returns:** ClaimReview JSON (same dataset as Fact Check Explorer).
- **Docs:** <https://developers.google.com/fact-check/tools/api>,
  reference: <https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search>

→ **For on-demand "has anyone fact-checked this?"** lookups, when our
extractor hits a specific claim and we want to query before retrieval.

### 1.3 Important: Search-side rendering is being phased out, the API isn't

Google says verbatim: *"We're phasing out support for ClaimReview markup
in Google Search. However, this markup remains supported by the Factcheck
Explorer Tool."*
(<https://developers.google.com/search/docs/appearance/structured-data/factcheck>)

Translation: rich-result rendering in Google Search is going away, but the
**Fact Check Tools API + Data Commons feed remain the supported ingestion
surface**. Our path is preserved.

### 1.4 Scale this gets us

The MultiClaim research dataset (EMNLP 2023,
<https://arxiv.org/html/2305.07991>) assembled **205,751 fact-checks across
39 languages from 142 fact-checking organizations**, largely via the Google
Fact Check Explorer pipeline. That's the order-of-magnitude scale a labeler
ingesting Google's aggregator can reach.

## 2. Direct publisher APIs — mostly absent

### 2.1 dpa-Faktencheck (Germany)

- **Public API: no.** dpa's verification-services page sells only B2B
  consulting (training, research, content production). No RSS, no
  ClaimReview-advertised feed, no JSON-LD endpoint.
- Sources:
  <https://www.dpa.com/de/verification-services>,
  <https://www.dpa.com/en/fact-checking-at-dpa>
- **Volume:** self-reports >5,000 fact-checks in three languages.
- **Workaround:** ingest via Google API with
  `reviewPublisherSiteFilter=dpa-factchecking.com` (or whichever domain
  hosts their published checks).

### 2.2 CORRECTIV, AFP-DE, Tagesschau, mimikama, APA et al.

The research pass **did not surface verified primary-source info** on
direct APIs/RSS/sitemap surfaces for these. Assumption (to verify when we
build the ingest): they likely have **no public structured API** either,
and the only realistic path is Google's aggregator filtered by their
publisher domain.

→ **Action for v1:** treat the Google feed as the source of truth for all
publishers. Add direct ingest only if a publisher actually publishes a
machine-readable feed.

## 3. Non-Google sources worth ingesting

### 3.1 EUvsDisinfo — Mendeley dump

- **Source:** Mendeley dataset v3, DOI 10.17632/yhdtkszvgp.3
  (<https://data.mendeley.com/datasets/yhdtkszvgp/3>)
- **Scope:** 14,497 disinformation cases, Jan 2015 – Nov 2022.
- **Schema:** 7 structured fields per case — date, link to EUvsDisinfo
  article, title, outlets of propagation, target countries, disinformation
  text, factual disproofs.
- **License:** **CC BY 4.0** — commercial reuse permitted with attribution.
- **Caveat:** the dump ends Nov 2022. For fresh EUvsDisinfo content, the
  live EEAS database must be scraped — no documented official live feed
  surfaced in this pass.

→ **Useful as a historical evidence corpus** for retrieval, especially for
Russian disinformation patterns. Not a live feed.

### 3.2 Meedan Check API

- **Repo:** <https://github.com/meedan/check-api> (MIT licence).
- **What it is:** the backend for Meedan's Check platform — what fact-check
  newsrooms use internally for tipline / claim-matching workflows.
- **What it isn't:** there's no public hosted Meedan feed of fact-checks.
  Ingestion would require self-hosting Check or a direct partnership.
- **Implication:** **not a practical v1 ingestion target.** Worth noting
  as a reference architecture (their schema for tipline-driven claim
  matching is well-thought-out).

## 4. Wikidata / Wikipedia / OSM (structured-data alternatives)

**Not surfaced as verified findings in this pass.** Already covered in
[`COMPONENTS.md §2.2`](./COMPONENTS.md#22-ai-support--retrieve-and-generate)
as primary retrieval corpora; the present pass focused on fact-check
feeds, not background knowledge bases. Treat Wikidata/Wikipedia as the
**evidence layer** for the AVeriTeC-style RAG path, and the Google feed as
the **prior-verdict layer**.

## 5. Verdict normalisation across publishers

**Key finding** from Harvard Misinformation Review
(<https://misinforeview.hks.harvard.edu/article/fact-checking-fact-checkers-a-data-driven-approach/>):

- 521 of 749 (69.6 %) matching Snopes vs. PolitiFact ratings were
  **identical**.
- 228 (30.4 %) diverged: 98 rating-system differences, 59 different focus,
  57 similar-but-not-identical, 13 timing.
- **Only 1 of 749 was a genuine factual conflict.**

**Implication:** a normalisation layer across publishers is **mandatory**
(everyone uses their own rating taxonomy: Snopes' "False" vs. PolitiFact's
"Pants on Fire" vs. CORRECTIV's "Frei erfunden") but **tractable** —
most of the divergence is taxonomy, not facts.

→ Build a lookup table per publisher mapping their native ratings to our
internal `{true, false, mixed, unknown, disputed, outdated}` vocabulary.
This is small, finite, documented per-publisher.

**Caveat:** the study covers only two US English-language publishers.
DACH/multilingual generalisation needs its own audit pass.

## 6. Matching ingested fact-checks to incoming claims

The research pass cited multiple primary papers
(<https://arxiv.org/html/2305.07991>, <https://arxiv.org/html/2505.10740>,
<https://arxiv.org/html/2508.03475v1>, <https://arxiv.org/pdf/2505.22118>)
but didn't synthesise concrete strategies into verified findings.
Captured as open question — see §8.

Pragmatic baseline for v1:

1. **URL match first**: if a post links to a URL that the ingested
   ClaimReview's `itemReviewed.url` covers, that's a hard match. Cheap,
   high precision.
2. **Cross-lingual embedding match**: embed the post's atomic claim with a
   multilingual model (`bge-m3`, `mxbai-embed-large-v1` with multilingual
   variants); compare against embedded `claimReviewed` text from ingested
   feeds. Threshold + manual review at the boundary.
3. **Entity overlap as a pre-filter**: only run embedding match when
   shared entities (Wikidata QIDs) exist between post and candidate.

Refine after a measurement pass on real Bluesky claims.

## 7. Priority — what to ingest first

| Priority | Source | Cost | Coverage | Licence for redistribution |
| --- | --- | --- | --- | --- |
| **1** | Google Data Commons Fact Check feed | $0, daily HTTPS GET | 142+ orgs, 39 langs, 205k+ checks | CC BY 4.0 on compilation; per-entry licence may vary |
| **2** | Google Fact Check Tools Claim Search API | API key, free tier quotas unclear (see §8) | Same dataset, on-demand | Same as feed |
| **3** | EUvsDisinfo Mendeley dump | $0, one-time download | 14.5k Russian-disinfo cases, 2015–Nov 2022 | CC BY 4.0 |
| 4 (later) | Direct publisher APIs (CORRECTIV, dpa, etc.) | Per-publisher coordination | Marginal gain over Google feed | Per-publisher TOS |
| 5 (research, not v1) | Meedan Check (self-hosted) | High — operate the platform | None unless partnership | MIT (code), data not redistributable |

**Recommended v1 ingest stack:** #1 (the feed) + #2 (the API for queries
the feed misses). #3 added as a historical-evidence corpus. Skip #4 / #5
until measured gaps justify them.

## 8. Still open

1. **Google Fact Check Tools API rate limits / daily quotas** on a free key,
   paid-tier existence — not documented anywhere we found.
2. **Which DACH publishers publish ClaimReview markup discoverable through
   Google's feed?** Need to query the feed with publisher-domain filters
   and count.
3. **Concrete semantic-matching strategy** for joining post-claim text to
   `claimReviewed` across languages — research papers exist (multiclaim,
   etc.) but no synthesised recipe.
4. **Live EUvsDisinfo / EDMO hub feeds** to replace the Nov-2022-capped
   Mendeley dump.
5. **Per-publisher TOS** for redistributing verdict text vs.
   link-only — surfaced in EPISTEMICS but not surveyed per publisher.

## 9. Caveats

- dpa's >5,000 fact-checks figure is self-reported.
- EUvsDisinfo Mendeley dump ends Nov 2022; fresh data requires scraping.
- The Snopes/PolitiFact 69.6 % agreement study covers only two US English
  publishers; multilingual / DACH generalisation may differ.
- Google may change Fact Check Tools API access at any time (e.g.,
  introduce or tighten rate limits). Single-vendor dependency is real.
- ClaimReview markup is being deprecated **in Search rich results** but
  not in the Fact Check Tools / Data Commons pipeline.

## 10. Sources

| URL | Quality | Topic |
| --- | --- | --- |
| <https://storage.googleapis.com/datacommons-feeds/factcheck/latest/data.json> | primary | Data Commons feed (live URL) |
| <https://datacommons.org/factcheck/faq> | primary | Data Commons FAQ |
| <https://datacommons.org/factcheck/download> | primary | Data Commons download/license |
| <https://developers.google.com/fact-check/tools/api> | primary | Fact Check Tools API |
| <https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search> | primary | Claim Search API reference |
| <https://developers.google.com/search/docs/appearance/structured-data/factcheck> | primary | ClaimReview Search deprecation note |
| <https://www.dpa.com/de/verification-services> | primary | dpa verification services (B2B only) |
| <https://www.dpa.com/en/fact-checking-at-dpa> | primary | dpa fact-checking page |
| <https://data.mendeley.com/datasets/yhdtkszvgp/3> | primary | EUvsDisinfo Mendeley dump |
| <https://github.com/meedan/check-api> | primary | Meedan Check API (MIT) |
| <https://misinforeview.hks.harvard.edu/article/fact-checking-fact-checkers-a-data-driven-approach/> | primary | Snopes vs PolitiFact agreement study |
| <https://arxiv.org/html/2305.07991> | primary | MultiClaim dataset (scale benchmark) |
| <https://arxiv.org/html/2505.10740> | primary | ClaimReview matching research |
| <https://arxiv.org/html/2508.03475v1> | primary | ClaimReview matching research |
| <https://arxiv.org/pdf/2505.22118> | primary | ClaimReview matching research |

---

## 11. Can we mint our own atproto lexicon for fact-checks?

**Yes — technically and protocol-conformantly.** atproto NSIDs are
reversed-DNS names; per the
[NSID spec](https://atproto.com/specs/nsid): *"Namespace authorities are
responsible for preventing duplication and confusion"* and *"no automated
mechanism for verifying control of a 'domain authority' currently exists."*

So we can publish e.g. `dev.fact-labeler.claimReview` records on the
labeler service account's PDS without anyone's permission, provided:

- We control the reversed domain (any domain we own works).
- We don't squat on reserved namespaces (`app.bsky.*`, `com.atproto.*`,
  `tools.ozone.*`, etc.).
- We publish the lexicon schema at a discoverable location so other tools
  can validate against it. Convention: serve the JSON schema at the NSID's
  HTTPS URL (e.g., `https://fact-labeler.dev/lexicons/claimReview.json`).

A lexicon for fact-checks would look something like:

```jsonc
// dev.fact-labeler.claimReview
{
  "lexicon": 1,
  "id": "dev.fact-labeler.claimReview",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",            // we'd use a deterministic rkey
      "record": {
        "type": "object",
        "required": ["sourceUrl", "publisher", "ratingNormalized", "ingestedAt"],
        "properties": {
          "sourceUrl":           { "type": "string", "format": "uri" },
          "publisher":           { "type": "string" },          // e.g. "correctiv.org"
          "claimReviewedText":   { "type": "string", "maxLength": 5000 },  // FAIR USE ZONE — see §12
          "ratingNative":        { "type": "string" },          // publisher's own label
          "ratingNormalized":    { "type": "string", "knownValues": ["true","false","mixed","unknown","disputed","outdated"] },
          "languageCode":        { "type": "string" },
          "reviewedAt":          { "type": "string", "format": "datetime" },
          "ingestedAt":          { "type": "string", "format": "datetime" },
          "validAt":             { "type": "string", "format": "datetime" },
          "claimAuthor":         { "type": "string" },          // who originally said the claim
          "entities":            { "type": "array", "items": { "type": "string" } }, // QIDs
          "attribution":         { "type": "string" }           // full attribution string
        }
      }
    }
  }
}
```

(Detail draft — actual schema to be designed in
[`docs/LEXICON.md`](./LEXICON.md) when we get there.)

## 12. **But can we put the publisher's claim/verdict text in it?** Usually no.

This is the real question. The license stack is **layered**:

| Layer | Owner | License |
| --- | --- | --- |
| The *compilation* (Google Data Commons aggregation, DataFeed structure, joins, URLs) | Google | **CC BY 4.0** — redistribute with attribution ✓ |
| Each *individual ClaimReview entry's text* (claim text, verdict text, rationale, headline) | Original publisher | **Whatever the publisher's site says** — usually "all rights reserved" |

Google's FAQ confirms this verbatim: *"The license on the structured data
of each ClaimReview markup is specified in the field `sdLicense`"* and
*"each publisher may have their own license terms for content on their
website."*

→ **CC BY 4.0 on the Data Commons compilation does not propagate down to
the underlying publisher texts.** That's a common misreading.

### What we can do safely under copyright (any jurisdiction)

- Store the **URL** to the publisher's fact-check article.
- Store the **publisher name** and **publication date**.
- Store **our own normalized rating** (our labelling work, our IP).
- Store the **post URI / claim it matches** (our matching work, our IP).
- Store **mandatory attribution text** ("Fact-checked by CORRECTIV, …").
- **Quote a short snippet** (a sentence or two) of the publisher's claim
  text under fair use / German *Zitatrecht* (§51 UrhG).

### What we cannot do without per-publisher permission

- Wholesale **mirror** the full claim text + verdict text + rationale
  text as permanent atproto records on our PDS, served to anyone for any
  purpose. That's republishing copyrighted text.
- **Cache verbatim full ratings + verdict text** beyond the technical
  minimum required for our matching pipeline.
- Build a public Faktencheck-search UI on top of mirrored content.

### Per-publisher reality (what was confirmable in this pass)

Direct license pages for several publishers couldn't be fetched (404 / 402
paywall / 403). The legal default — "all rights reserved unless a license
says otherwise" — applies. Practical posture per publisher:

| Publisher | What's confirmed | Posture |
| --- | --- | --- |
| **Snopes** | ToS page returned **HTTP 402 Payment Required** (sic), site is strictly copyrighted | **Citation only.** Don't mirror text. |
| **PolitiFact** | Tampa Bay Times property, all rights reserved by default | **Citation only.** |
| **AFP** | News agency, strict B2B commercial licensing | **Citation only.** |
| **dpa-Faktencheck** | Per §2.1: no public API, B2B paid only | **Citation only.** |
| **Full Fact** | About page footer: *"© Copyright 2010-2026 Full Fact"*. No CC declaration found in this pass. | **Citation only** (assume default). |
| **CORRECTIV** | Historically reported to use Creative Commons (anecdotally CC BY-SA); direct license page URLs returned 404 in this pass — **could not confirm**. | **Citation only by default**; verify their actual license before mirroring text. |
| **mimikama** | AGB endpoint returned 403; couldn't confirm. | **Citation only.** |
| **Google Data Commons compilation** | CC BY 4.0 on the aggregation (structure, joins) | Reuse OK with attribution — but does **not** cover underlying text. |
| **EUvsDisinfo Mendeley dump** | CC BY 4.0, includes the texts | **Mirror allowed** with attribution. |

### What this means for our lexicon

Our `dev.fact-labeler.claimReview` record can store **metadata, URL, our
own normalized rating, attribution, plus optionally a short fair-use
snippet of the claim text** — not the full publisher rationale or full
verdict text.

The **user-facing detail page** (whether HTTP or click-through from the
labeler-profile) **deep-links to the publisher's article**. Users get the
full rationale from the original source. We are the **index**, not the
content host.

This is also the right epistemic move: deferring to the publisher's
canonical text reinforces our "we don't decide truth, we route to who
did" stance from [`EPISTEMICS.md`](./EPISTEMICS.md).

### One important exception: EUvsDisinfo

The Mendeley dump (§3.1) is CC BY 4.0 on the actual text content
(disinformation text + factual disproofs). For these 14.5k cases we
**can** mirror the text into our records with attribution. Useful for
RAG.

### What about caching for internal processing?

Internally pulling the full ClaimReview JSON into our service DB to drive
the matching pipeline is fine — it's intermediate technical use, not
republishing. The constraint is **what we expose** (PDS records, public
APIs, our detail page). Internal cache: fine. Public mirror: not without
per-publisher OK.

## 13. Action items before any text-mirroring lands

1. **Email each publisher** we want to mirror beyond citation (CORRECTIV
   first — they're the most likely to grant a CC-style permission, given
   their history). Ask for a written reuse license covering atproto-labeler
   redistribution.
2. **Default our lexicon and ingest pipeline to citation-mode**: store URL
   + metadata + normalized rating only. Toggle text-mirror on per-publisher
   when explicit permission lands.
3. **Get CORRECTIV's actual license** (this pass couldn't fetch their
   stated terms — direct contact or deeper site crawl needed).
4. **For Google Data Commons feed**: include a verbatim attribution string
   in our lexicon (`attribution` field) — "Compiled from Google Data
   Commons Fact Check feed (CC BY 4.0), originally published by
   {publisher}." Even when we only store metadata, this is best-practice.
5. **Add a small `sdLicense` field** in our record so we propagate any
   per-entry license we see in the source ClaimReview down to our own
   records — future-proof for licence-aware tools.
