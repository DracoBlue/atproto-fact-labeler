import { describe, expect, it } from 'vitest';

import { cosine, vectorToBlob, blobToVector } from '../src/embedding/client.ts';

describe('embedding client helpers', () => {
  it('cosine identity is 1.0', () => {
    const v = new Float32Array([0.6, 0.8]);
    expect(cosine(v, v)).toBeCloseTo(1.0);
  });

  it('cosine orthogonal vectors is 0', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosine(a, b)).toBeCloseTo(0);
  });

  it('cosine opposite vectors is -1', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosine(a, b)).toBeCloseTo(-1);
  });

  it('blob round-trips a float32 vector', () => {
    const orig = new Float32Array([0.1, -0.2, 3.14159, 1e-10]);
    const blob = vectorToBlob(orig);
    const back = blobToVector(blob);
    expect(back.length).toBe(orig.length);
    for (let i = 0; i < orig.length; i++) {
      expect(back[i]).toBeCloseTo(orig[i]!, 6);
    }
  });

  it('cosine throws on dim mismatch', () => {
    expect(() => cosine(new Float32Array([1, 2]), new Float32Array([1, 2, 3]))).toThrow(/dim mismatch/);
  });
});
