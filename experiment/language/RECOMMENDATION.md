# Language-detection library — recommendation

## TL;DR

**Pick `eld` (medium dataset).** Fastest of the four, never returns
"undefined", agrees with the rest of the field on ≥97 % of rows. Drop-in
replacement for the URL/TLD-based `guessLanguage()` heuristic that
currently leaves 70 % of the index untagged.

## How we evaluated

Ran every library against the first 100 `claim_reviewed` rows from the
local SQLite (`pnpm tsx experiment/language/compare.ts`). Sample mix:
English news-style claims, Telugu, Tamil, Farsi, Arabic, Dutch, German,
French, Portuguese — representative of the actual Data Commons feed.

Numbers come straight out of `report.md` (also in this folder).

## The four candidates

| Library | Approach | Pure JS | Datasets / size |
|---|---|---|---|
| `franc-min` | trigram statistics | ✓ | 82 most-common languages, ~30 KB |
| `franc-all` | trigram statistics | ✓ | all 414 supported languages, ~200 KB |
| `tinyld` | trigram + dictionary | ✓ | 134 languages, ~80 KB |
| `eld` (medium) | trigram, optimised | ✓ | ~60 languages, ~250 KB |

Excluded up front:
- **cld3** — needs a native binding; loses the "no install pain" property.
- **lingua-js** — referenced in some lists but no npm registry entry.

## Results

### Speed (mean per call, 100-row sample)

```
eld         51 µs     ← 2× faster than franc-min, 3-4× faster than the rest
franc-min  115 µs
tinyld     181 µs
franc-all  227 µs
```

For an 88 k row re-ingest the difference between 51 µs and 200 µs is
~13 s vs ~18 s — irrelevant. But it costs nothing to take the fast one.

### Confidence / "undefined" rate

```
eld          0 %     ← always answers
tinyld       0 %     ← always answers
franc-min   14 %     ← gives up on short / mixed-script texts
franc-all   31 %     ← even more conservative
```

For the *re-ingest* use case, "0 % undefined" beats "more conservative"
— a few mis-tags are recoverable via the strict same-language filter we
ship, but leaving 14 % null brings us back to the current 70 % null
problem at smaller scale.

### Agreement (excluding undefined)

All four agree on each other ≥ 95 %. The strongest pair is
`franc-min ↔ eld` at 98.8 %. When two-of-three or three-of-four agree
we can trust that label; the disagreements are almost always on
short, English-with-numbers strings (row 23: an English Navbharat
Times headline that `eld` calls Irish; row 88: "A Direct Way to
Register Public Complaints" that `franc` calls Portuguese).

### Where each one breaks

- **franc-min/-all**: very short English fragments often go to `'?'`
  (undefined) or wander to a romance language. Below ~50 chars it gives
  up reliably.
- **tinyld**: hallucinates a language for very short non-natural
  strings. Hashtag-only posts can come back as Vietnamese.
- **eld**: short headlines occasionally land in low-resource European
  languages (`ga` for Irish on row 23). Mitigated with a min-length
  guard (skip < 30 chars → leave NULL).
- **All four**: anything < 10 chars is meaningless to all of them.
  Don't try.

## Recommendation

Use `eld` with the medium dataset and a `text.length >= 30` guard:

```ts
import { eld } from 'eld/medium';

function detectLang(text: string): string | null {
  if (text.length < 30) return null;        // too short to be reliable
  const r = eld.detect(text);
  if (!r.language || !r.isReliable()) return null;
  return r.language;                         // already ISO 639-1
}
```

`isReliable()` is eld's own confidence gate — it weighs the n-gram
match strength against text length. Treating "not reliable" as NULL
lets the strict same-language SQL filter ignore those rows instead of
mis-routing them to the wrong language pool.

If we ever care about a language eld doesn't ship in the medium
dataset (Tamil, Telugu, Hindi, Farsi — all covered in our sample), we
can upgrade to `eld/large` in one line; same API.

### What this changes downstream

1. Re-ingest stamps every `claim_review` row with a 2-letter ISO 639-1
   `lang` (or NULL for the under-30-char or under-confidence cases).
2. The same-language filter in `src/pipeline/retrieve.ts` is then
   effective for the ~70 % of rows that today are NULL.
3. Cross-language matches stop reaching the NLI judge entirely on the
   happy path. Coverage drops slightly; verdict quality goes up.

## Next steps

1. Add `eld` to runtime deps; remove `franc-min`, `franc`, `tinyld`
   from devDeps (or keep them in this experiment folder only).
2. Replace the TLD-and-path heuristics in
   `src/ingest/claimreview-feed.ts` with the detector above.
3. Re-ingest the local DB; verify lang distribution looks sane
   (no more `in`, `au`, `cn` showing up as "languages").
4. Document the policy in `docs/PIPELINE.md` so future contributors
   see why retrieval is single-language by default.
