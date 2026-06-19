# Language detection

## Why this matters

Stage 1 retrieval (`src/pipeline/retrieve.ts`) restricts candidate
fact-checks to the **same language as the incoming claim**. Cross-lingual
NLI is fragile — even strong LLM judges flip polarity on translated
text far more often than on same-language pairs, and the cosine
similarity between multilingual embeddings happily pulls topically
related but semantically unrelated rows into the candidate set.

The single-language filter is the cheapest defence. It only works if
the `claim_review.lang` column is populated *and correct*.

## What we had before

`src/ingest/claimreview-feed.ts` used to compute `lang` via two URL
heuristics:

```ts
// /fa/, /de/, /es/, ... in the path:
url.match(/\/(?:fa|de|en|es|fr|pt|it|nl|...)/);
// publisher TLD as a fallback:
publisher.match(/\.(de|fr|es|jp|kr|cn|br|au|in)/);
```

Two bugs:

1. **TLDs are not BCP-47.** `jp` is a country code; the language is `ja`.
   Same for `cn`→`zh`, `kr`→`ko`, `br`→`pt`. `au` and `in` aren't
   languages at all — both stamped real rows as language=`au` / `in`.
2. **Most publishers don't encode language in their URL.** ~70 % of the
   88 k row corpus ended up with `lang = NULL`, which the same-language
   filter then either ignores (loose mode) or discards (strict mode).

Verified in `data/labeler.sqlite` pre-fix:

```
NULL    61 444
in      19 866   ← Indian fact-checkers, not a language
br       2 730   ← Brazilian, the language is pt
es       1 920
de         935
jp         776   ← Japanese, the language is ja
...
```

## What we use now

[`src/ingest/detect-lang.ts`](../src/ingest/detect-lang.ts) wraps the
**[eld] library** (medium dataset) with a confidence + length guard:

```ts
import { eld } from 'eld/medium';

export function detectLang(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length < 16) return null;            // eld's reliable floor
  const r = eld.detect(trimmed);
  if (!r.language) return null;
  if (typeof r.isReliable === 'function' && !r.isReliable()) return null;
  return r.language.toLowerCase();                  // already ISO 639-1
}
```

[eld]: https://github.com/nitotm/efficient-language-detector-js

`isReliable()` is eld's own confidence gate; treating a non-reliable
detection as `NULL` lets the SQL filter ignore that row rather than
mis-route it. The 16-character guard matches eld's documented reliable
minimum — below that the trigram histogram is too sparse for any
detector to be meaningful.

## How we chose this library

See [`experiment/language/RECOMMENDATION.md`](../experiment/language/RECOMMENDATION.md)
for the side-by-side run of `franc-min`, `franc-all`, `tinyld`, and
`eld/medium` against the first 100 ClaimReview rows. Headline:

| detector | undefined % | µs / call |
|---|---:|---:|
| eld | 0 % | 51 |
| tinyld | 0 % | 181 |
| franc-min | 14 % | 115 |
| franc-all | 31 % | 227 |

eld won on both speed and confidence, with ≥95 % pair-wise agreement
against every other library on the cases they all answered.
[`experiment/language/report.md`](../experiment/language/report.md) has
the row-by-row data; `experiment/language/compare.ts` is the script.

## Mis-tagged posts — declared ∪ detected

Bluesky posts carry an optional `langs` facet that the user (or their
client) sets. In practice this is unreliable:

- Many clients leave the system locale (often `en`) regardless of body.
- Power-users sometimes set `langs` deliberately to a different
  language for visibility / niche-feed reasons.
- Composer drafts in one language can be sent without an updated tag.

If retrieval honoured only the *declared* lang, a German post tagged
`en` would search the English fact-check pool and miss the actual
German verdicts (and vice versa). So `src/pipeline/matching.ts`
**unions** the declared lang with `detectLang(claim_text)` and passes
both to the SQL filter:

```ts
const langs = [...new Set([declared, detectLang(claim)].filter(Boolean))];
// SQL: AND (lang IN (?, ?) OR lang IS NULL)
```

When they agree it's a no-op (one effective lang). When they disagree
the candidate pool grows by one language — still narrow enough to keep
cross-lingual NLI errors at bay, wide enough that mis-tagged posts
still find their real verdicts. NULL-tagged rows stay reachable from
every claim so a single under-confidence detection never blocks them.

## Operator workflow

### New ingest — automatic

`pnpm ingest` (and the periodic refresh job from
[DEPLOY.md § Periodic re-ingest](DEPLOY.md#7-periodic-re-ingest)) call
`detectLang()` for every row. Nothing extra to do.

### Existing index — one-shot rebuild

Older databases were ingested before this change and still carry the
URL-heuristic codes. Walk every row and rewrite:

```bash
# Preview the rewrite (no DB changes; prints new distribution)
pnpm cli:lang-rebuild --dry-run

# Touch only the rows that are currently NULL
pnpm cli:lang-rebuild --null-only

# Rewrite every row — the default
pnpm cli:lang-rebuild
```

Idempotent — re-running on a freshly-ingested DB is a no-op.

**No `embed-rebuild` needed afterwards.** `lang-rebuild` only writes
to the `claim_review.lang` column. The `embedding`, `embedding_dim`,
and `embedding_model` columns are untouched, so Stage 1 retrieval
keeps using the same vectors it already had — only the same-language
filter that runs alongside the cosine match now has correct data to
filter against. Embeddings need to be recomputed only when the
`EMBEDDING_MODEL` itself changes (see
[`DEPLOY.md` § Periodic re-ingest](DEPLOY.md#7-periodic-re-ingest)).

After the rebuild, the same-language filter in
`src/pipeline/retrieve.ts` becomes meaningful. The retrieve query then
narrows by `claim_review.lang = ? OR lang IS NULL`; rows where eld
genuinely couldn't decide stay reachable from any language so they're
not silently lost.

### Verifying the distribution

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/labeler.sqlite', { readonly: true });
console.log(db.prepare(
  'SELECT COALESCE(lang, ?) AS lang, COUNT(*) AS n FROM claim_review GROUP BY lang ORDER BY n DESC LIMIT 12'
).all('<null>'));
"
```

Sane post-rebuild output for the current corpus: `en` should be the
largest bucket, followed by `pt`, `es`, `ta`, `te`, `hi`, `fa`, `ar`,
`de`, `fr`, `nl`. No more `in`, `au`, `cn`. NULL bucket falls from
~70 % to a few percent (the short / under-confidence tail).

## Where this is referenced

- [`src/ingest/claimreview-feed.ts`](../src/ingest/claimreview-feed.ts) — `guessLanguage()`, the ingest call site.
- [`src/cli/lang-rebuild.ts`](../src/cli/lang-rebuild.ts) — the one-shot rebuild CLI.
- [`src/pipeline/retrieve.ts`](../src/pipeline/retrieve.ts) — the same-language SQL filter that depends on this column being correct.
- [`docs/PIPELINE.md`](PIPELINE.md) — explains the cross-lingual NLI weakness that motivated the filter.
- [`docs/DEPLOY.md`](DEPLOY.md) — periodic-refresh checklist now includes `cli:lang-rebuild` for upgrades from older indices.
- [`experiment/language/`](../experiment/language/) — the comparison data behind the eld pick.
