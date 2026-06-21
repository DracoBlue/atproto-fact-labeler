# Google Fact Check Tools API — live supplement

## Why this exists

The Google Data Commons bulk ClaimReview feed (`data.json`) is a
[deliberate subset](https://datacommons.org/factcheck/faq) of what's in
the Fact Check Explorer. Major English-language fact-checkers — Lead
Stories, USA Today, Snopes, AAP — publish ClaimReview JSON-LD on their
own pages but submit very little (or nothing) to the bulk feed.

Concrete measurement on our 88 k row corpus (June 2026):

| Publisher | rows in `data.json` | "flat earth" hits in Google Fact Check Explorer |
|---|---:|---:|
| Lead Stories | 0 | 8+ |
| Snopes | ~3 | 1+ |
| Full Fact | 1 | 1+ |
| USA Today | 106 | 10+ |

The pipeline answers "is the earth flat?" with `uncovered` from the
bulk feed alone, even though Lead Stories has half a dozen direct
refutations. Cross-language matching helps a little, but the cleanest
fix is to query the same source Google's own Explorer uses:
[Fact Check Tools API — `claims:search`](https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search).

## How it works

When `FACTCHECK_API_KEY` is set, every `matchClaim()` call:

1. Issues one `claims:search` per unique candidate language (declared
   + detected, deduped).
2. Filters each hit through
   [`config/claimreview-publishers-allowlist.txt`](../../config/claimreview-publishers-allowlist.txt) —
   same gate as bulk ingest. Garbage publishers from the API surface
   are dropped before they hit Stage 1.
3. `INSERT OR IGNORE` into `claim_review`. Already-cached hits skip
   straight to the next step. New rows get a language detection +
   inline embedding pass so Stage 1's cosine search picks them up in
   the same call.
4. Stage 1 retrieval, rerank, NLI continue as normal — the freshly
   cached rows participate via the same SQL path as bulk-feed entries.

Failure modes (API down, 429 quota, 403 bad key, timeout) are caught
and logged at `warn`. The pipeline falls back to the local pool —
worst-case behaviour is identical to running without the key.

Auth model: **API-key only**. The endpoint actively rejects Bearer
tokens (user OAuth, service-account JWT) with `400 invalid argument`,
including when a valid API key is *also* sent. Verified empirically;
no Service Account / ADC / `GOOGLE_APPLICATION_CREDENTIALS` setup will
make this work.

## Operator setup

```bash
# 1. Create or pick a GCP project (no billing required — the search
#    endpoint is free at our usage volumes)
gcloud projects create my-labeler-fc 2>/dev/null || true
gcloud config set project my-labeler-fc

# 2. Enable the API
gcloud services enable factchecktools.googleapis.com

# 3. Create a restricted API key — restriction means a leaked key
#    can ONLY be used against the fact-check API, not your wider
#    GCP project
gcloud alpha services api-keys create \
  --display-name=labeler-factcheck \
  --api-target=service=factchecktools.googleapis.com

# 4. Print the key
KEY_NAME=$(gcloud alpha services api-keys list \
  --filter='displayName=labeler-factcheck' --format='value(name)')
gcloud alpha services api-keys get-key-string "$KEY_NAME" \
  --format='value(keyString)'

# 5. Drop it into .env
echo 'FACTCHECK_API_KEY=<key from above>' >> .env
```

Restart the service. The next `matchClaim()` call will issue a live
API request; the second call against the same claim will hit the
local cache.

## Quota expectations

Google does not publish per-API rate limits for `claims:search`. In
testing, 10 consecutive requests landed `200 OK` with no
back-pressure. The pipeline issues at most one call per unique
candidate language per claim — so a typical bsky report with a
single English claim costs one API call, and the second report of the
same post costs zero.

If you do hit `429`, the client logs a `warn` line and returns an
empty live result. The `FACTCHECK_API_TIMEOUT_MS` (default 5 s) caps
individual calls so a stalled endpoint can't slow the pipeline.

## Caching behaviour

Hits land in `claim_review` like any other entry:

- `source_url` is the publisher's article URL, used as the dedup key.
- `publisher_url` is reconstructed as `https://<publisher_site>/`.
- `attribution` reads `Fact-checked by <publisher>. Sourced via Google
  Fact Check Tools API.` — distinguishable from bulk-feed rows for
  later audit.
- `lang` uses the API's `languageCode` if set, otherwise the local
  [`detectLang()`](../../src/ingest/detect-lang.ts) fallback.
- `embedding` / `embedding_dim` / `embedding_model` are populated
  inline so Stage 1 retrieval finds the row on the *same* `matchClaim`
  call — no need for a subsequent `embed-rebuild`.

Cached API rows are indistinguishable from bulk-feed rows downstream.
Same allowlist, same rerank, same NLI, same `cleanup:claims` semantics.

## What this does *not* do

- It does not replace `pnpm ingest data.json` — the bulk feed remains
  the backbone for languages and topics where coverage is already
  good. Live API supplements the gaps.
- It does not introduce a second auth secret to manage. The key is
  the only credential; no service account, no rotation choreography.
- It does not move the labeler off your own machine — every request
  to Google is made by your instance with your key.
- It does not work without the publisher allowlist. Live API
  responses go through the same gate as ingest; off-allowlist
  publishers (including ones not yet vetted) are silently dropped.
  Add publishers via the
  [allowlist Issue template](../../.github/ISSUE_TEMPLATE/publisher-add.yml).

## See also

- [`docs/sources/licensing.md § Path 3`](./licensing.md#path-3--google-fact-check-tools-api-claimssearch) — the Terms of Service governing API responses, caching posture, and the operator-responsibility model.
- [`docs/sources/feed-quality.md`](./feed-quality.md) — the publisher allowlist and the upstream feed's quality problems.
- [`docs/pipeline/language-detection.md`](../pipeline/language-detection.md) — the same-language filter that runs alongside the cross-feed merge.
- [`docs/pipeline/README.md`](../pipeline/README.md) — stages 1–4.
- [Google Fact Check Tools API reference](https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search).
- [Data Commons Fact Check FAQ](https://datacommons.org/factcheck/faq) — defines the bulk feed as a subset.
