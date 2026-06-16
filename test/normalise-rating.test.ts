import { describe, expect, it } from 'vitest';

import {
  aggregateVerdicts,
  normaliseRating,
  normaliseToken,
} from '../src/pipeline/normalise-rating.ts';

describe('normaliseToken', () => {
  it('strips diacritics and lowercases', () => {
    expect(normaliseToken('Größtenteils Falsch!')).toBe('grosstenteils falsch');
  });
  it('collapses whitespace', () => {
    expect(normaliseToken('  pants  on   fire  ')).toBe('pants on fire');
  });
});

describe('normaliseRating', () => {
  it('returns null when rating empty', () => {
    expect(normaliseRating('correctiv', '')).toBeNull();
    expect(normaliseRating('correctiv', null)).toBeNull();
    expect(normaliseRating('correctiv', undefined)).toBeNull();
  });

  it('maps PolitiFact ratings via publisher-specific rule', () => {
    const r = normaliseRating('PolitiFact', 'Pants on Fire')!;
    expect(r.verdict).toBe('false');
    expect(r.publisherSpecific).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('maps CORRECTIV ratings to false', () => {
    const r = normaliseRating('CORRECTIV.Faktencheck', 'Falsch')!;
    expect(r.verdict).toBe('false');
    expect(r.publisherSpecific).toBe(true);
  });

  it('maps CORRECTIV "Frei erfunden" to false', () => {
    const r = normaliseRating('CORRECTIV', 'Frei erfunden')!;
    expect(r.verdict).toBe('false');
  });

  it('falls back to generic rules for unknown publishers', () => {
    const r = normaliseRating('SomeNewSite', 'False')!;
    expect(r.verdict).toBe('false');
    expect(r.publisherSpecific).toBe(false);
  });

  it('maps AFP French "Faux" to false', () => {
    const r = normaliseRating('AFP', 'Faux')!;
    expect(r.verdict).toBe('false');
  });

  it('marks unrecognised as unknown with low confidence', () => {
    const r = normaliseRating('Whatever', 'gobbledygook')!;
    expect(r.verdict).toBe('unknown');
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('maps "Half True" to mixed', () => {
    const r = normaliseRating('PolitiFact', 'Half True')!;
    expect(r.verdict).toBe('mixed');
  });
});

describe('aggregateVerdicts', () => {
  it('returns null for empty input', () => {
    expect(aggregateVerdicts([])).toBeNull();
  });

  it('picks the heaviest verdict', () => {
    const agg = aggregateVerdicts([
      { verdict: 'false', confidence: 0.95, publisherSpecific: true },
      { verdict: 'false', confidence: 0.9, publisherSpecific: true },
      { verdict: 'unknown', confidence: 0.2, publisherSpecific: false },
    ])!;
    expect(agg.verdict).toBe('false');
    expect(agg.votes).toBe(3);
    expect(agg.agreement).toBeCloseTo(2 / 3, 2);
  });

  it('marks two close-but-different verdicts as disputed', () => {
    const agg = aggregateVerdicts([
      { verdict: 'true', confidence: 0.9, publisherSpecific: true },
      { verdict: 'false', confidence: 0.85, publisherSpecific: true },
    ])!;
    expect(agg.verdict).toBe('disputed');
  });

  it('does not mark as disputed when one side dominates', () => {
    const agg = aggregateVerdicts([
      { verdict: 'false', confidence: 0.95, publisherSpecific: true },
      { verdict: 'false', confidence: 0.95, publisherSpecific: true },
      { verdict: 'false', confidence: 0.95, publisherSpecific: true },
      { verdict: 'true', confidence: 0.5, publisherSpecific: false },
    ])!;
    expect(agg.verdict).toBe('false');
  });
});
