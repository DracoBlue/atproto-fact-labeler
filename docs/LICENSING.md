# Licensing of the data you ingest

- **[Google Data Commons Fact Check feed][gdc-fc]** compilation: CC BY 4.0
  (attribution required, redistribution permitted). Feed endpoint, refresh
  cadence, and the per-entry `sdLicense` mechanism are documented at
  [datacommons.org/factcheck/faq][gdc-fc-faq] and the
  [download page][gdc-fc-download].

[gdc-fc]: https://datacommons.org/factcheck/
[gdc-fc-faq]: https://datacommons.org/factcheck/faq
[gdc-fc-download]: https://datacommons.org/factcheck/download

- **Individual ClaimReview entries**: the *text* (claim, verdict, rationale)
  remains under each publisher's own copyright. We store only the URL,
  metadata, normalised rating, and a verbatim attribution string. We do not
  mirror publisher text. Default posture for every publisher is therefore
  citation-only — link users out to the publisher's article, never reproduce
  it. Adjust per publisher only with explicit written permission.
- Our own normalised verdict + matching work + labels are MIT-licensed and
  redistributable.

The labeler code itself is MIT — see [`LICENSE`](../LICENSE).

## What we *don't* ingest, and why

The Google Data Commons feed is open-submission and ships SEO spam,
blogspot blogs and other junk alongside real fact-checkers. We filter
at ingest with a curated publisher allowlist — an editorial decision,
not a licensing one. See [`FEED_QUALITY.md`](FEED_QUALITY.md) for the
allowlist criteria, the trade-offs, how to add a publisher, and how to
report bad upstream entries back to Google.
