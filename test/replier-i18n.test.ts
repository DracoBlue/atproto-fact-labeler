import { describe, expect, it } from 'vitest';

import {
  pickLang,
  SUPPORTED_LANGS,
  t,
  translateVerdict,
} from '../src/replier/i18n.ts';

describe('pickLang', () => {
  it('returns the requested lang when supported', () => {
    expect(pickLang('en')).toBe('en');
    expect(pickLang('de')).toBe('de');
  });

  it('normalises BCP-47 to the primary subtag', () => {
    expect(pickLang('de-AT')).toBe('de');
    expect(pickLang('en-GB')).toBe('en');
  });

  it('falls back when unsupported', () => {
    expect(pickLang('fr')).toBe('en');
    expect(pickLang('fr', 'de')).toBe('de');
  });

  it('falls back when undefined', () => {
    expect(pickLang(undefined)).toBe('en');
    expect(pickLang(undefined, 'de')).toBe('de');
  });

  it('all advertised SUPPORTED_LANGS map to themselves', () => {
    for (const lang of SUPPORTED_LANGS) {
      expect(pickLang(lang)).toBe(lang);
    }
  });
});

describe('t', () => {
  it('returns English strings by default', () => {
    expect(t('en', 'verdict_label')).toBe('Verdict');
    expect(t('en', 'sources_label')).toBe('Sources');
  });

  it('returns German strings when requested', () => {
    expect(t('de', 'verdict_label')).toBe('Einschätzung');
    expect(t('de', 'sources_label')).toBe('Quellen');
  });

  it('uses fallback when lang is unsupported', () => {
    expect(t('fr', 'verdict_label', 'de')).toBe('Einschätzung');
  });
});

describe('translateVerdict', () => {
  it('translates verdict words in English', () => {
    expect(translateVerdict('false', 'en')).toBe('refuted');
    expect(translateVerdict('true', 'en')).toBe('supported');
    expect(translateVerdict('unknown', 'en')).toBe('not enough information');
  });

  it('translates verdict words in German', () => {
    expect(translateVerdict('false', 'de')).toBe('widerlegt');
    expect(translateVerdict('true', 'de')).toBe('bestätigt');
    expect(translateVerdict('unknown', 'de')).toBe('nicht genug Belege');
  });

  it('passes through unknown verdicts', () => {
    expect(translateVerdict('weird-state', 'en')).toBe('weird-state');
  });
});
