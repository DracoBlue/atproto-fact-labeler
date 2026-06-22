/**
 * On-device language detection for ClaimReview rows.
 *
 * We deliberately rejected the URL/TLD heuristics that used to live in
 * `guessLanguage` — they stamped TLDs as language codes (`jp` instead of
 * `ja`, `cn` instead of `zh`, country codes like `au`/`in` as "languages")
 * and left 70 % of the index untagged because most fact-checkers don't
 * encode the language in their URL.
 *
 * Picked `eld` (medium dataset) after the side-by-side run in
 * `experiment/language/`. See `docs/pipeline/language-detection.md` for the why.
 */
import { eld } from 'eld/medium';

/**
 * Detect the BCP-47 / ISO 639-1 language of a fact-check claim text.
 *
 * Returns `null` for inputs that are too short or where the detector
 * itself isn't confident — letting downstream code treat them as
 * "unknown language" instead of mis-routing them to the wrong pool.
 */
export function detectLang(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  // eld's own minimum-reliable length is ~16 chars. Below that the
  // trigram histogram is too sparse to mean anything. Above it we rely
  // on the library's `isReliable()` check below to drop noisy calls.
  if (trimmed.length < 16) return null;

  const result = eld.detect(trimmed);
  if (!result.language) return null;
  if (typeof result.isReliable === 'function' && !result.isReliable()) return null;

  // eld returns ISO 639-1 (2-letter) directly. Lowercase, defensively.
  return result.language.toLowerCase();
}
