import { describe, expect, it } from 'vitest';

import { parseExtractionResponse } from '../src/pipeline/extract.ts';

describe('parseExtractionResponse', () => {
  it('returns [] for empty input', () => {
    expect(parseExtractionResponse('')).toEqual([]);
    expect(parseExtractionResponse('   ')).toEqual([]);
  });

  it('strips markdown json fences', () => {
    const raw = '```json\n{"claims":[{"atomic_text":"x","decontextualized_text":"x","span_start":0,"span_end":1,"is_falsifiable":true,"entities":[],"confidence":0.9}]}\n```';
    const claims = parseExtractionResponse(raw);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.atomic_text).toBe('x');
  });

  it('returns [] on invalid JSON', () => {
    expect(parseExtractionResponse('{not json')).toEqual([]);
  });

  it('returns [] when schema does not match', () => {
    expect(parseExtractionResponse('{"oops": true}')).toEqual([]);
  });

  it('accepts the typical happy case', () => {
    const raw = JSON.stringify({
      claims: [
        {
          atomic_text: 'Die Erde ist flach',
          decontextualized_text: 'Die Erde ist flach',
          span_start: 0,
          span_end: 18,
          is_falsifiable: true,
          lang: 'de',
          entities: ['Erde'],
          confidence: 0.92,
        },
      ],
    });
    const claims = parseExtractionResponse(raw);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.is_falsifiable).toBe(true);
    expect(claims[0]!.confidence).toBeCloseTo(0.92);
    expect(claims[0]!.entities).toEqual(['Erde']);
  });

  it('handles non-falsifiable claims', () => {
    const raw = JSON.stringify({
      claims: [
        {
          atomic_text: 'I love coffee',
          decontextualized_text: 'I love coffee',
          span_start: null,
          span_end: null,
          is_falsifiable: false,
          entities: [],
          confidence: 0.99,
        },
      ],
    });
    const claims = parseExtractionResponse(raw);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.is_falsifiable).toBe(false);
  });
});
