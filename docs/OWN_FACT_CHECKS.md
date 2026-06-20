# Hosting your own fact-checks

Some operators run this labeler as a feed for **their own** fact-checks —
a newsroom or NGO that publishes ClaimReview-tagged articles and wants
them surfaced as Bluesky labels. The ingest path that pulls in Google's
bulk feed accepts your own JSON-LD too; same code path, same allowlist,
same retrieval pipeline downstream.

## Quick start — a single fact-check

The ingest CLI reads any [schema.org `DataFeed`][df] containing
`ClaimReview` items. A feed with one item is a perfectly valid feed:

```json
{
  "@context": "http://schema.org",
  "@type": "DataFeed",
  "dataFeedElement": [
    {
      "@type": "DataFeedItem",
      "dateCreated": "2026-06-19T14:32:00Z",
      "item": [
        {
          "@context": "http://schema.org",
          "@type": "ClaimReview",
          "url": "https://example.org/fact-check/heat-pumps-banned-2024",
          "claimReviewed": "The government banned all heat pumps in 2024.",
          "datePublished": "2026-06-19",
          "inLanguage": "en",
          "author": {
            "@type": "Organization",
            "name": "Example Fact Check",
            "url": "https://example.org/"
          },
          "reviewRating": {
            "@type": "Rating",
            "alternateName": "False",
            "ratingValue": "1",
            "bestRating": "5",
            "worstRating": "1"
          },
          "itemReviewed": {
            "@type": "Claim",
            "author": { "@type": "Person", "name": "Social media users" }
          }
        }
      ]
    }
  ]
}
```

Save as `my-claim.json`, then:

```bash
pnpm ingest my-claim.json
pnpm cli:embed-rebuild     # picks up the new row's missing embedding
```

That's it. The next `matchClaim()` call sees your claim as a regular
candidate.

[df]: https://schema.org/DataFeed

## Required fields

Only three are load-bearing; the rest of the schema is optional but
useful for downstream rendering.

| Field | Required | Notes |
|---|---|---|
| `url` | ✓ | Unique identifier for this fact-check. Reused as the dedup key on re-ingest. |
| `claimReviewed` | ✓ | The atomic claim text. This is what gets embedded for cosine retrieval. Keep it concise (~1500 chars max). |
| `reviewRating.alternateName` (or `.name`) | ✓ | Free-text verdict. Mapped to an internal verdict via `src/pipeline/normalise-rating.ts` (False/Fake/Falso → `false`, True/Correct → `true`, etc.). |
| `author.name` | recommended | Publisher display name shown in the detail page. |
| `author.url` | recommended | Publisher host. Used by the [publisher allowlist](FEED_QUALITY.md). If the host doesn't match an allowlist line the entry is dropped at ingest. |
| `datePublished` | recommended | Used downstream for "current as of" rendering and supersedes-by-newer logic. |
| `inLanguage` | recommended | BCP-47 lang. When absent, `detectLang()` infers from the text. See [LANGUAGE_DETECTION.md](LANGUAGE_DETECTION.md). |

## Bulk import — many claims

Same shape, more items:

```json
{
  "@context": "http://schema.org",
  "@type": "DataFeed",
  "dataFeedElement": [
    { "@type": "DataFeedItem", "item": [ /* claim 1 */ ] },
    { "@type": "DataFeedItem", "item": [ /* claim 2 */ ] },
    { "@type": "DataFeedItem", "item": [ /* claim 3 */ ] }
  ]
}
```

The ingester streams the array, so size doesn't matter — the 60 MB
Google Data Commons file goes through the same code path as a 1-item
feed. Insert-or-replace on `url` makes re-ingest idempotent: re-publish
the same file after editing a verdict and only the changed row updates.

## Allowlist — add yourself

Ingest checks `author.url` against
[`config/claimreview-publishers-allowlist.txt`](../config/claimreview-publishers-allowlist.txt).
A row from `example.org` will be silently dropped unless `example.org`
is on the list. For your own deployment, just add yourself:

```diff
+ # === Self-hosted ===
+ example.org
```

If you're contributing your domain back to the public repo, use the
[Publisher addition Issue template](../.github/ISSUE_TEMPLATE/publisher-add.yml)
— same evidence bar as any other inclusion request.

## Putting it on the wire — JSON-LD on your articles

If you also embed the same `ClaimReview` JSON-LD as a `<script
type="application/ld+json">` block in your own article HTML, you get
two things "for free":

1. Google's Fact Check Tools API picks it up and serves it as a live
   hit to *other* labeler deployments that have set
   `FACTCHECK_API_KEY` — see [`FACTCHECK_API.md`](FACTCHECK_API.md).
   Your fact-checks reach more operators without any deal.
2. Search engines may render the rich result (note: Google [phased out
   the dedicated UI in 2025][gserp], but the structured data is still
   indexed and used by their tools).

The JSON inside the `<script>` tag and the `item` object in
`my-claim.json` above are the *same shape* — paste either into
[Google's Rich Results Test][grt] to validate.

[gserp]: https://www.searchenginejournal.com/google-changes-eligibility-for-fact-check-rich-results/414887/
[grt]: https://search.google.com/test/rich-results

## Operating notes

- **No HTTP push endpoint.** Ingest is file-based by design — easier
  to vet, easier to git-version, replayable on a fresh DB.
- **Re-running `pnpm ingest`** with the same file is safe. Identical
  rows are noops; edits overwrite the existing record (matched on
  `url`). New `url`s get appended.
- **Each ingest needs a follow-up `pnpm cli:embed-rebuild`** so the
  fresh `claim_review` rows get their cosine vectors. The CLI is
  model-aware and skips rows that are already embedded.
- **`pnpm cleanup:claims`** still applies — if you later remove your
  domain from the allowlist (revoking a contributor, etc.), running
  cleanup drops the orphaned rows.

## Native atproto records (in progress)

The publisher half of the project's
[`lexicons/`](../lexicons/) is `app.kiesel.facts.claimReview` — an
atproto-native record type mirroring schema.org/ClaimReview
field-for-field, designed for fact-checkers who already operate on
atproto and want to publish reviews as first-class records on their
own PDS instead of (or alongside) JSON-LD-in-articles. Discoverable
via [Constellation](https://constellation.microcosm.blue/) backlinks
on the subject Bluesky post.

This is **additional** to the bulk-DataFeed path documented above,
not a replacement. The bulk JSON ingest still works exactly as
described. Use the atproto-record path when:

- You operate a fact-check newsroom on atproto and want full record
  control (correct, supersede, retire).
- You want your reviews to be discoverable by *other* labelers, not
  just this one — Constellation indexes records by subject URI, so
  any labeler can query "which fact-checkers have reviewed this
  post?".

Design + schema:
[`docs/PROPOSAL_lexicons/LEXICON_DESIGN.md`](PROPOSAL_lexicons/LEXICON_DESIGN.md)
and [`lexicons/app/kiesel/facts/claimReview.json`](../lexicons/app/kiesel/facts/claimReview.json).

## See also

- [`docs/PROPOSAL_lexicons/LEXICON_DESIGN.md`](PROPOSAL_lexicons/LEXICON_DESIGN.md) — atproto-native record types (one for publishers, one for labelers).
- [`docs/LICENSING.md § Path 1`](LICENSING.md#path-1--your-own-claimreview-articles) — when you host your own ClaimReviews you own the licensing posture end-to-end; the labeler doesn't layer extra terms.
- [`docs/FEED_QUALITY.md`](FEED_QUALITY.md) — the allowlist that
  filters every ingest, including yours.
- [`docs/FACTCHECK_API.md`](FACTCHECK_API.md) — using the Google live
  API alongside or instead of your own bulk file.
- [schema.org `ClaimReview`](https://schema.org/ClaimReview) — the
  canonical field reference.
- [Google's ClaimReview markup docs](https://developers.google.com/search/docs/appearance/structured-data/factcheck) — practical examples for the JSON-LD block on your articles.
