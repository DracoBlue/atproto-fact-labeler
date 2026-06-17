/**
 * Translations for the bot's Bluesky replies.
 *
 * We translate the user-facing strings the labeler posts when it answers a
 * mention. Internal log messages remain English. New languages can be added by
 * extending the TRANSLATIONS table — the lang picker is BCP-47 aware and falls
 * back to a configured default when the requested language isn't available.
 */

export const SUPPORTED_LANGS = ['en', 'de'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

export interface Strings {
  verdict_supported: string;
  verdict_refuted: string;
  verdict_mixed: string;
  verdict_disputed: string;
  verdict_outdated: string;
  verdict_unknown: string;
  verdict_label: string;
  sources_label: string;
  details_label: string;
  no_claim: string;
  no_match: string;
  no_target: string;
}

const TRANSLATIONS: Record<Lang, Strings> = {
  en: {
    verdict_supported: 'supported',
    verdict_refuted: 'refuted',
    verdict_mixed: 'mixed',
    verdict_disputed: 'disputed',
    verdict_outdated: 'outdated',
    verdict_unknown: 'not enough information',
    verdict_label: 'Verdict',
    sources_label: 'Sources',
    details_label: 'Details',
    no_claim:
      "I couldn't find a falsifiable factual claim in that post — nothing to fact-check.",
    no_match:
      "I checked, but no fact-check publisher I know of has covered that claim yet.",
    no_target:
      "I couldn't load the post you asked about — maybe it was deleted or unavailable.",
  },
  de: {
    verdict_supported: 'bestätigt',
    verdict_refuted: 'widerlegt',
    verdict_mixed: 'teils richtig, teils falsch',
    verdict_disputed: 'umstritten',
    verdict_outdated: 'veraltet',
    verdict_unknown: 'nicht genug Belege',
    verdict_label: 'Einschätzung',
    sources_label: 'Quellen',
    details_label: 'Details',
    no_claim:
      'Ich konnte in dem Beitrag keine prüfbare Tatsachenbehauptung finden — nichts zu prüfen.',
    no_match:
      'Ich habe geprüft, aber bislang hat keine mir bekannte Faktencheck-Quelle diese Aussage abgedeckt.',
    no_target:
      'Ich konnte den verlinkten Beitrag nicht laden — möglicherweise gelöscht oder nicht erreichbar.',
  },
};

/**
 * Pick a supported language for a translation lookup. Strategy:
 *
 *  1. Normalise BCP-47 to its primary subtag (`de-AT` → `de`).
 *  2. Return it if supported.
 *  3. Otherwise return the configured fallback.
 *
 * Pure / synchronous.
 */
export function pickLang(want: string | undefined, fallback: Lang = 'en'): Lang {
  if (!want) return fallback;
  const primary = want.slice(0, 2).toLowerCase();
  return (SUPPORTED_LANGS as readonly string[]).includes(primary) ? (primary as Lang) : fallback;
}

export function t(lang: string | undefined, key: keyof Strings, fallback: Lang = 'en'): string {
  return TRANSLATIONS[pickLang(lang, fallback)][key];
}

export function translateVerdict(verdict: string, lang: string | undefined, fallback: Lang = 'en'): string {
  const map: Record<string, keyof Strings> = {
    true: 'verdict_supported',
    false: 'verdict_refuted',
    mixed: 'verdict_mixed',
    disputed: 'verdict_disputed',
    outdated: 'verdict_outdated',
    unknown: 'verdict_unknown',
  };
  const key = map[verdict];
  return key ? t(lang, key, fallback) : verdict;
}
