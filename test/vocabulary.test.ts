import { describe, expect, it } from 'vitest';

import {
  FACT_LABEL_VALUES,
  isSpecCompliantLabel,
  verdictToLabel,
} from '../src/labels/vocabulary.ts';

describe('label vocabulary', () => {
  it('all values are spec-compliant', () => {
    for (const val of FACT_LABEL_VALUES) {
      expect(isSpecCompliantLabel(val), `${val} not compliant`).toBe(true);
    }
  });

  it('rejects bad values', () => {
    expect(isSpecCompliantLabel('UPPER')).toBe(false);
    expect(isSpecCompliantLabel('with space')).toBe(false);
    expect(isSpecCompliantLabel('claim:health')).toBe(false);
    expect(isSpecCompliantLabel('-leading')).toBe(false);
    expect(isSpecCompliantLabel('trailing-')).toBe(false);
    expect(isSpecCompliantLabel('')).toBe(false);
  });

  it('maps verdicts onto labels', () => {
    expect(verdictToLabel('true')).toBe('fact-supported');
    expect(verdictToLabel('false')).toBe('fact-refuted');
    expect(verdictToLabel('mixed')).toBe('fact-mixed');
    expect(verdictToLabel('disputed')).toBe('fact-disputed');
    expect(verdictToLabel('outdated')).toBe('fact-outdated');
    expect(verdictToLabel('unknown')).toBe('fact-unknown');
  });
});
