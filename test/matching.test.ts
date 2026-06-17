import { describe, expect, it } from 'vitest';

import { flipVerdict } from '../src/pipeline/matching.ts';
import type { Verdict } from '../src/pipeline/normalise-rating.ts';

describe('flipVerdict — polarity-aware aggregation', () => {
  const cases: Array<[Verdict, Verdict]> = [
    ['false', 'true'],
    ['true', 'false'],
    ['mixed', 'mixed'],
    ['outdated', 'unknown'],
    ['disputed', 'disputed'],
    ['unknown', 'unknown'],
  ];
  it.each(cases)('flips %s → %s', (input, expected) => {
    expect(flipVerdict(input)).toBe(expected);
  });
});
