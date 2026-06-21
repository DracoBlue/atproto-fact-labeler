# Licensing of the data you ingest

Three independent intake paths feed the labeler. Each has its own
licensing posture and operator responsibility. None override the
default rule below.

## The default rule

> **Per-entry publisher text remains under each publisher's own
> copyright.** The labeler stores only the URL, publisher metadata,
> normalised rating, and a verbatim per-entry attribution string. We
> *do not mirror* the publisher's full fact-check text. The detail
> page links users out to the publisher's article; the on-wire label
> is a short value (`fact-supported`, `fact-refuted`, …) that
> identifies the publisher's stance without reproducing their prose.

This is citation-only. Adjust per-publisher only with explicit
written permission from that publisher.

## Path 1 — Your own ClaimReview articles

Operators that publish their own ClaimReview-tagged articles and feed
them via `pnpm ingest` (see [`OWN_FACT_CHECKS.md`](./own-claimreviews.md))
own the licensing decision end-to-end. The operator's own posture on
licensing, attribution, redistribution, and downstream use governs
the entries from this path. No third-party Terms layer over it.

## Path 2 — Google Data Commons bulk feed

The [Data Commons Fact Check feed][gdc-fc] is the daily 60 MB public
JSON dump.

- **Compilation licence**: [CC BY 4.0][cc-by-4]. Redistribution
  permitted, attribution required. The per-entry `sdLicense` field is
  the mechanism a publisher can use to apply additional licensing to
  their individual entry — when set, honour it.
- **Per-entry text**: stays under each publisher's copyright (see the
  default rule above).
- **Attribution we embed**: each ingested row carries
  `Fact-checked by <publisher>. Compiled via Google Data Commons
  Fact Check feed (CC BY 4.0).` — surfaced on the detail page and in
  the JSON API.
- **Refresh + retention**: documented at
  [datacommons.org/factcheck/faq][gdc-fc-faq] and the
  [download page][gdc-fc-download].

[gdc-fc]: https://datacommons.org/factcheck/
[gdc-fc-faq]: https://datacommons.org/factcheck/faq
[gdc-fc-download]: https://datacommons.org/factcheck/download
[cc-by-4]: https://creativecommons.org/licenses/by/4.0/

## Path 3 — Google Fact Check Tools API (`claims:search`)

Activated when `FACTCHECK_API_KEY` is set. See
[`FACTCHECK_API.md`](./factcheck-api.md) for setup.

- **Governs**: [Google APIs Terms of Service][gapi-tos] plus the
  endpoint-specific [Fact Check Tools API terms][fctools-tos].
- **Operator responsibility, not project responsibility.** The API
  key is created and held by *the operator*, in *their* Google Cloud
  project. The operator accepts the GCP and API-specific Terms when
  they enable the API and create the key. The labeler is just an
  HTTP client.
- **Attribution we embed** for entries sourced this way:
  `Fact-checked by <publisher>. Sourced via Google Fact Check Tools API.`
  Surfaced on the detail page so the intake path is auditable.
- **Caching**: ToS § 5.e.1 forbids keeping cached copies longer than
  the response's cache headers permit. The labeler persists hits into
  `claim_review` for future cosine-retrieval. The labeler's posture
  is that the row stays cached for as long as it remains on the
  publisher's allowlist; remove the publisher from the allowlist + run
  `pnpm cleanup:claims` to drop their rows. If the operator's
  jurisdiction or auditor demands a hard expiry, add a periodic
  `DELETE FROM claim_review WHERE attribution LIKE '%Fact Check Tools
  API%' AND ingested_at < datetime('now', '-30 days');` job.
- **No third-party redistribution.** ToS § 5.c / § 5.e.2 prohibit
  redistributing retrieved content to other users / third parties
  without consent. The labeler emits signed atproto labels that
  identify the publisher's stance and surface the publisher URL —
  this is citation, not redistribution of the publisher's prose. The
  detail page shows the same per-entry attribution and short
  `rating_native` snippet (typically a single phrase like "False" or
  "Mostly False") with a link out to the publisher's article.
- **No substitute service.** ToS § 4.a.1 forbids building "an API
  Client that functions substantially the same as the APIs" for
  third-party use. The labeler is a downstream labeling pipeline, not
  a re-skinned Fact Check Explorer.

[gapi-tos]: https://developers.google.com/terms
[fctools-tos]: https://developers.google.com/fact-check/tools/api/terms

## What the labeler itself ships

- **The codebase** — MIT, see [`LICENSE`](../../LICENSE).
- **The normalised verdict + matching pipeline + the on-wire labels**
  — derivative work, MIT-licensed and redistributable.
- **The embeddings cached locally** — derived from publisher text,
  not redistributed. Stored only inside the operator's SQLite.
- **Verdict rationales** in the detail page (e.g. *"NLI: 1 entail, 2
  contradict, 3 neutral (dropped)"*) — MIT, our own.

## What the labeler does **not** ingest, and why

The Google Data Commons feed is open-submission and ships SEO spam,
blogspot blogs, and other junk alongside real fact-checkers — plus at
least one entry whose publisher name field carried an active XSS
payload. The labeler filters at ingest with a curated publisher
allowlist that applies to **both** Path 2 (bulk) and Path 3 (live
API), so the same editorial bar gates every entry regardless of
intake path. See [`FEED_QUALITY.md`](./allowlist.md) for the
allowlist criteria, how to add a publisher, and how to report bad
upstream entries back to Google.

This is an editorial decision, not a licensing one.

## Quick reference

| Question | Answer |
| --- | --- |
| Can I redistribute the bulk feed compilation? | Yes — CC BY 4.0 with attribution. |
| Can I redistribute individual fact-check articles verbatim? | No, per-publisher copyright. Cite + link out. |
| Can I use the Fact Check Tools API commercially? | Subject to the Google APIs ToS and the operator's GCP project. The labeler doesn't impose extra restrictions but the operator accepts those ToS when they create the key. |
| Do I have to attribute publishers per-entry? | Yes. The labeler already does this — `attribution` column on every row, rendered on the detail page. |
| Can I mirror the publisher's verdict text in my own UI? | Not by default — link out to the publisher. Adjust per-publisher only with explicit written permission. |
| Can I publish my own ClaimReviews and have them be part of this labeler? | Yes, via Path 1. The licensing decision is entirely yours. |
