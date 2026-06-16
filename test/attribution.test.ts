import { describe, expect, it } from 'vitest';

import { buildAttribution } from '../src/ingest/claimreview-feed.ts';

describe('buildAttribution', () => {
  it('uses publisher name when available', () => {
    const s = buildAttribution({
      '@type': 'ClaimReview',
      author: { '@type': 'Organization', name: 'CORRECTIV' },
    });
    expect(s).toContain('CORRECTIV');
    expect(s).toContain('Google Data Commons');
    expect(s).toContain('CC BY 4.0');
  });

  it('falls back to publisher URL when no name', () => {
    const s = buildAttribution({
      '@type': 'ClaimReview',
      author: { '@type': 'Organization', url: 'https://snopes.com' },
    });
    expect(s).toContain('https://snopes.com');
  });

  it('uses "unknown publisher" when nothing available', () => {
    const s = buildAttribution({ '@type': 'ClaimReview' });
    expect(s).toContain('unknown publisher');
  });
});
