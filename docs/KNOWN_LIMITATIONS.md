# Known limitations

What this labeler currently **cannot** do, with the evidence behind
each statement. This page exists because "looks like it works for the
demo but breaks on the long tail" is the default failure mode of
fact-checking systems, and pretending otherwise is worse than admitting
it.

Each item below lists:
- the symptom an operator would observe,
- the *measured* root cause (from the pool, the pipeline, or the
  upstream feed),
- the workaround if any.

All numbers come from the 88 k row corpus after `cleanup:claims` +
`lang-rebuild`, with the gemini-2.5-flash judge on Vercel AI Gateway.
Re-run `pnpm test:matching` to reproduce.

## 1. The English half of the pool is thin for niche conspiracies

**Symptom.** Posts like "the earth is round" / "Bill Gates wants to
microchip everyone" return either `uncovered` or rely on a single
publisher entry.

**Evidence.** The four polarity-matrix fixtures (`test/fixtures/matching-cases.json`
#1–#4) all return `uncovered`:

```
[1/14] the earth is round            uncovered (0 reranked)
[2/14] the earth is not flat         uncovered (1 reranked, 0 entail)
[3/14] the earth is flat             uncovered (1 reranked, 0 entail)
[4/14] the earth is not round        uncovered (0 reranked)
```

A direct DB probe for the keyword pair confirms the gap:

```bash
node -e "
const db = require('better-sqlite3')('data/labeler.sqlite', { readonly: true });
console.log(db.prepare(
  'SELECT COUNT(*) AS n FROM claim_review WHERE lang=? AND ('+
  'claim_reviewed LIKE ? OR claim_reviewed LIKE ?)'
).get('en', '%flat earth%', '%earth is round%'));
"
// → { n: 0 }
```

Meanwhile the **German** pool has a handful of flat-earth refutations
from dpa-Faktencheck (#3 cited "La Terre est plate" — French — as the
only same-language source before the lang filter was tightened). The
**Spanish** pool has Univision El Detector entries. They just don't
cross over into English in the Google FCT feed.

**Root cause.** Upstream coverage in the Google Data Commons Fact Check
feed. We can't fix it from here.

**Workaround.** None at the pipeline level. The honest behaviour is to
return `uncovered` so no label is emitted. A future cross-lingual NLI
path (see *Cross-lingual matching* below) would close this; that's a
real piece of design work, not a tuning knob.

## 2. Cross-lingual matching is intentionally off

**Symptom.** A German post about COVID vaccines won't pull in English
fact-checks even when the English pool has rich coverage and the German
pool is thin (e.g. case #13 "Impfstoffe enthalten Mikrochips" → `uncovered`,
while the English equivalent #5 returns `false conf=1.0` from three
entailed FactCheck.org / Reuters / Snopes entries).

**Evidence.** `src/pipeline/retrieve.ts` issues:

```sql
WHERE embedding IS NOT NULL
  AND embedding_model = ?
  AND (lang IN (?, ?) OR lang IS NULL)
```

The two `lang` slots are the post's declared lang and the detected lang
of the claim text; they are NOT the cartesian product of all languages.
Why: an earlier loose retrieval that allowed FR/NL/ES into the candidate
set for an EN claim produced confident-but-wrong verdicts on the polarity
matrix (see `docs/LANGUAGE_DETECTION.md`). Gemini-class judges flip
polarity on translated text far more often than on same-language pairs.

**Root cause.** NLI quality on cross-lingual pairs is below the
production bar for emitting signed labels.

**Workaround.** None today. Two paths for a future version:
1. Translate the candidate's `claim_reviewed` to the post's language
   before the NLI step. Adds an LLM call per candidate; embedding cost
   doubles.
2. Use a dedicated cross-lingual NLI model (e.g. `mDeBERTa-v3-base-xnli`)
   rather than a chat-model judge. Quality has been measured better
   ([Conneau et al. 2022][xnli]); deployment story is heavier.

[xnli]: https://arxiv.org/abs/2204.06487

Neither is required for the existing single-language coverage to be
useful, so they sit outside MVP.

## 3. Confidence calibration shifts with the publisher pool

**Symptom.** A claim that resolved to `verdict=false conf=0.94` six
months ago now resolves to `false conf=0.65` with the same model.

**Evidence.** Trump 2020 election (fixture #9) — confidence dropped
from ~0.94 to 0.655 after `cleanup:claims` removed the spam publishers
that previously inflated the count of corroborating "False" ratings.

```
[9/14] Donald Trump won the 2020 US presidential election
  PASS — verdict=false conf=0.655 (retrieved=8 reranked=5 entail=2 contradict=1 neutral=2)
```

The 2 entail / 1 contradict / 2 neutral split is honest: real US
fact-checkers reviewed this, mostly agreed, one publisher hedged.

**Root cause.** Spam removal exposed the legitimate-but-lower base
rate of agreement among real publishers.

**Workaround.** Don't tune thresholds against pre-cleanup numbers.
`HITL_AUTO_MIN_CONFIDENCE` sits at 0.6 in the recommended defaults
(`.env.example`); raise per deployment as you accumulate trust in
your specific pool. The `auto-telegram` HITL mode (see
`docs/LIFECYCLE.md § Phase 3.5`) is the right answer if you want
operator review of the 0.6–0.8 band rather than picking a hard line.

## 4. Single-publisher verdicts get full confidence

**Symptom.** When only one allowlisted publisher has reviewed a claim,
that publisher's verdict becomes the labeler's verdict at conf=1.0 —
even if a reasonable observer might want a second opinion before
emitting.

**Evidence.** Bill Gates microchips (fixture #8) — exactly one EN entry
matches (FactCheck.org, rating="False"). Pipeline output:

```
[8/14] Bill Gates wants to inject everyone with microchips
  PASS — verdict=false conf=1.000 (retrieved=8 reranked=3 entail=1 contradict=0 neutral=2)
```

1 entail, no contradict → effective verdict propagates with full
confidence. The 2 neutral candidates didn't pull the aggregator down
because the aggregator weights by entailed/contradicted only.

**Why this is not a bug.** The label this would emit is
`fact-refuted`, which is *correct* — FactCheck.org is on the allowlist
specifically because it's a trustworthy source. Propagating a single
trustworthy source verdict at conf=1.0 is the designed behaviour.

**Why this is still worth flagging.** Operators who want a two-source
quorum before auto-accepting should bump `HITL_AUTO_MIN_VOTES` from 2
to 2 (current default), 3 for stricter review queues, or move to
`HITL_MODE=auto-telegram` so single-source verdicts get a human
glance.

## 5. NLI judge handles English negation reliably, other languages less so

**Symptom.** Sentences with explicit negation in the *claim* ("X is
not Y") behave well in English but degrade in German / Spanish /
Portuguese.

**Evidence.** Not measured against a fixed benchmark in this repo —
this is the operator-observed risk on the boundary where the same-
language filter ends and the NLI judge starts. The English fixture
cases #2 and #4 ("the earth is not flat" / "the earth is not round")
return `uncovered` for the coverage reason in #1, so don't *exercise*
the negation path; the working negation cases in the fixture are
implicit (e.g. fixture #10 "Joe Biden won the 2020 election" needs
the polarity-flip on a "Trump won" candidate to land at `true`, and
it does at conf 0.832).

**Workaround.** Manual inspection on each new locale before adding it
to `LABELER_REPLY_DEFAULT_LANG`. The German cases #13/#14 in the
fixture exist specifically to catch regressions in German polarity
handling end-to-end.

## What is *not* a limitation here

To save the operator's time:

- **Wrong labels emitted from junk publishers.** Closed by
  [`docs/FEED_QUALITY.md`](FEED_QUALITY.md) — the allowlist rejects the
  blogspot/SEO/spam entries that the Google FCT feed bundles.
- **Stored XSS / `javascript:` URLs.** Closed by the URL-scheme
  allowlist and noindex headers in `src/detail/server.ts`
  (see [`SECURITY.md`](../SECURITY.md)).
- **Label key compromise via emitEvent.** Closed by the
  `auth: (did) => did === cfg.LABELER_DID` restriction on the
  LabelerServer (see same file).
- **Cross-lingual NLI mistakes propagating to the wire.** Closed by
  the same-language filter (item #2 above).
- **Stale labels after publisher delisting.** Closed by `pnpm
  cleanup:claims` + `pnpm retire`. The retire pass marks
  `verdict.retired_at` so the detail page stops surfacing the
  withdrawn evidence (see `docs/LIFECYCLE.md § Phase 3`).

If your deployment hits a *different* limit than the five listed
above, please open an issue with the same evidence shape as the items
here — the pool query, the fixture result, the proposed cause. The
issue templates under `.github/ISSUE_TEMPLATE/` ask for exactly
that.
