/**
 * Map publisher-native fact-check ratings ("Falsch", "Pants on Fire", ...) to our
 * internal verdict vocabulary.
 *
 * Cross-publisher agreement is high once a normalisation layer is applied: a
 * Harvard Misinformation Review study on Snopes vs PolitiFact found ~70 % of
 * ratings on matching claims agree, with only one genuine factual conflict in
 * the sample. Most divergence is taxonomy ("Pants on Fire" vs "False"), not
 * fact.
 *
 * This file is intentionally a pure data table + a small matcher. Easy to test,
 * easy to extend per publisher.
 */

export type Verdict = 'true' | 'false' | 'mixed' | 'unknown' | 'disputed' | 'outdated';

/** Normalised entry plus a coarse confidence (0..1) of the mapping. */
export interface NormalisedRating {
  verdict: Verdict;
  confidence: number;
  /** True when we matched a publisher-specific rule rather than the generic default. */
  publisherSpecific: boolean;
}

/**
 * Lowercase a string and strip diacritics + non-alpha so 'Größtenteils Falsch'
 * matches our table keys. German ß has no combining decomposition, so we expand
 * it to 'ss' explicitly before NFD.
 */
export function normaliseToken(s: string): string {
  return s
    .replace(/ß/g, 'ss')
    .replace(/Æ/g, 'AE')
    .replace(/æ/g, 'ae')
    .replace(/Œ/g, 'OE')
    .replace(/œ/g, 'oe')
    .replace(/Ø/g, 'O')
    .replace(/ø/g, 'o')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Rule {
  /** Lowercase tokens; matched as a whole-string after normalisation. */
  match: string[];
  verdict: Verdict;
  confidence: number;
}

/** Generic, cross-publisher fallback rules (English + a few common DACH terms). */
const GENERIC_RULES: Rule[] = [
  // hard false
  { match: ['false', 'falsch', 'faux', 'falso', 'falsa', 'fake'], verdict: 'false', confidence: 0.95 },
  { match: ['pants on fire', 'pants on fire!'], verdict: 'false', confidence: 0.99 },
  { match: ['mostly false', 'largely false', 'grostenteils falsch', 'eher falsch'], verdict: 'false', confidence: 0.8 },
  { match: ['nicht wahr', 'unwahr', 'untrue', 'ungenau'], verdict: 'false', confidence: 0.85 },
  { match: ['misleading', 'irreführend', 'irrefuhrend', 'trompeur'], verdict: 'false', confidence: 0.75 },
  { match: ['debunked', 'widerlegt', 'desmentido', 'demente', 'falsche behauptung'], verdict: 'false', confidence: 0.9 },
  { match: ['frei erfunden', 'erfunden', 'made up', 'fabricated'], verdict: 'false', confidence: 0.95 },

  // hard true
  { match: ['true', 'wahr', 'vrai', 'verdadero', 'verdadera', 'echt'], verdict: 'true', confidence: 0.95 },
  { match: ['mostly true', 'largely true', 'grostenteils wahr', 'eher wahr'], verdict: 'true', confidence: 0.8 },
  { match: ['accurate', 'korrekt', 'richtig', 'stimmt', 'bestatigt', 'bestaetigt'], verdict: 'true', confidence: 0.9 },
  { match: ['confirmed', 'verified', 'belegbar'], verdict: 'true', confidence: 0.85 },

  // mixed
  { match: ['mixture', 'mixed', 'half true', 'partly true', 'teilweise wahr', 'teilweise falsch'], verdict: 'mixed', confidence: 0.85 },
  { match: ['some truth', 'partly false', 'partially true', 'partially false'], verdict: 'mixed', confidence: 0.8 },

  // outdated
  { match: ['outdated', 'no longer true', 'veraltet', 'nicht mehr aktuell'], verdict: 'outdated', confidence: 0.85 },

  // disputed
  { match: ['disputed', 'umstritten', 'contested'], verdict: 'disputed', confidence: 0.8 },

  // unknown / not enough information
  { match: ['unproven', 'unverified', 'nicht belegt', 'unbelegt', 'unbestatigt', 'unbestaetigt'], verdict: 'unknown', confidence: 0.75 },
  { match: ['nicht genug informationen', 'not enough evidence', 'not enough information', 'insufficient evidence'], verdict: 'unknown', confidence: 0.8 },

  // satire / out of context — we mark as 'mixed' to flag without claiming false
  { match: ['satire', 'out of context', 'aus dem kontext', 'shach-dar'], verdict: 'mixed', confidence: 0.7 },
];

/**
 * Publisher-specific overrides. Keyed by lowercased publisher name substring.
 * Tested against (publisher.toLowerCase().includes(key)).
 */
const PUBLISHER_RULES: Record<string, Rule[]> = {
  politifact: [
    { match: ['pants on fire'], verdict: 'false', confidence: 1.0 },
    { match: ['false'], verdict: 'false', confidence: 0.95 },
    { match: ['mostly false'], verdict: 'false', confidence: 0.85 },
    { match: ['half true', 'half-true'], verdict: 'mixed', confidence: 0.85 },
    { match: ['mostly true'], verdict: 'true', confidence: 0.85 },
    { match: ['true'], verdict: 'true', confidence: 0.95 },
  ],
  snopes: [
    { match: ['false'], verdict: 'false', confidence: 0.95 },
    { match: ['mostly false'], verdict: 'false', confidence: 0.85 },
    { match: ['mixture'], verdict: 'mixed', confidence: 0.9 },
    { match: ['mostly true'], verdict: 'true', confidence: 0.85 },
    { match: ['true'], verdict: 'true', confidence: 0.95 },
    { match: ['outdated'], verdict: 'outdated', confidence: 0.95 },
    { match: ['unproven', 'research in progress'], verdict: 'unknown', confidence: 0.85 },
    { match: ['miscaptioned', 'misattributed'], verdict: 'false', confidence: 0.8 },
    { match: ['satire'], verdict: 'mixed', confidence: 0.7 },
  ],
  correctiv: [
    { match: ['falsch', 'frei erfunden'], verdict: 'false', confidence: 0.95 },
    { match: ['grostenteils falsch'], verdict: 'false', confidence: 0.85 },
    { match: ['teils richtig teils falsch', 'mixed'], verdict: 'mixed', confidence: 0.85 },
    { match: ['richtig'], verdict: 'true', confidence: 0.95 },
    { match: ['unbelegt'], verdict: 'unknown', confidence: 0.85 },
  ],
  dpa: [
    { match: ['falsch'], verdict: 'false', confidence: 0.95 },
    { match: ['weitgehend falsch'], verdict: 'false', confidence: 0.85 },
    { match: ['richtig'], verdict: 'true', confidence: 0.95 },
    { match: ['weitgehend richtig'], verdict: 'true', confidence: 0.85 },
    { match: ['nicht beweisbar', 'unbelegt'], verdict: 'unknown', confidence: 0.85 },
  ],
  afp: [
    { match: ['faux', 'false'], verdict: 'false', confidence: 0.95 },
    { match: ['trompeur', 'misleading'], verdict: 'false', confidence: 0.8 },
    { match: ['vrai', 'true'], verdict: 'true', confidence: 0.95 },
    { match: ['hors contexte', 'out of context'], verdict: 'mixed', confidence: 0.75 },
  ],
  mimikama: [
    { match: ['falsch'], verdict: 'false', confidence: 0.95 },
    { match: ['richtig'], verdict: 'true', confidence: 0.95 },
  ],
  'full fact': [
    { match: ['incorrect', 'wrong', 'false'], verdict: 'false', confidence: 0.9 },
    { match: ['correct', 'true'], verdict: 'true', confidence: 0.9 },
    { match: ['needs context', 'missing context'], verdict: 'mixed', confidence: 0.8 },
  ],
};

function findRule(rules: Rule[], rating: string): Rule | undefined {
  return rules.find((rule) => rule.match.some((m) => rating === m || rating.includes(m)));
}

/**
 * Normalise a publisher's native rating (e.g. "Pants on Fire", "Falsch", "Faux")
 * into our internal verdict vocabulary. Returns `null` if no rule matches and the
 * input is empty.
 */
export function normaliseRating(
  publisher: string | undefined | null,
  ratingNative: string | undefined | null,
): NormalisedRating | null {
  if (!ratingNative) return null;
  const rating = normaliseToken(ratingNative);
  if (!rating) return null;
  const publisherKey = (publisher ?? '').toLowerCase();

  for (const [key, rules] of Object.entries(PUBLISHER_RULES)) {
    if (publisherKey.includes(key)) {
      const hit = findRule(rules, rating);
      if (hit) {
        return { verdict: hit.verdict, confidence: hit.confidence, publisherSpecific: true };
      }
    }
  }

  const generic = findRule(GENERIC_RULES, rating);
  if (generic) {
    return { verdict: generic.verdict, confidence: generic.confidence, publisherSpecific: false };
  }

  // Unrecognised — surface as unknown with low confidence so HITL sees it.
  return { verdict: 'unknown', confidence: 0.2, publisherSpecific: false };
}

/**
 * When multiple publishers agree on the same claim, fold their normalised verdicts
 * into a single label using a simple majority+confidence vote.
 *
 * Returns the aggregated verdict and a coarse confidence in the aggregation.
 */
export interface Aggregated {
  verdict: Verdict;
  confidence: number;
  agreement: number; // share of publishers whose verdict equals the winner
  votes: number;
}

export function aggregateVerdicts(ratings: NormalisedRating[]): Aggregated | null {
  if (ratings.length === 0) return null;
  const weight = new Map<Verdict, number>();
  for (const r of ratings) {
    weight.set(r.verdict, (weight.get(r.verdict) ?? 0) + r.confidence);
  }
  const entries = [...weight.entries()].sort((a, b) => b[1] - a[1]);
  const top = entries[0]!;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const winnerVerdict = top[0];
  const winnerWeight = top[1];
  const winnerCount = ratings.filter((r) => r.verdict === winnerVerdict).length;

  // If the top two verdicts are similarly weighted, mark as 'disputed'.
  let verdict = winnerVerdict;
  if (entries.length > 1) {
    const second = entries[1]!;
    if (second[1] / Math.max(winnerWeight, 1e-9) > 0.65 && second[0] !== winnerVerdict) {
      verdict = 'disputed';
    }
  }

  return {
    verdict,
    confidence: Number((winnerWeight / Math.max(total, 1e-9)).toFixed(3)),
    agreement: Number((winnerCount / ratings.length).toFixed(3)),
    votes: ratings.length,
  };
}
