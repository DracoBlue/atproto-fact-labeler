import { describe, expect, it } from 'vitest';

import { buildReplyText } from '../src/replier/format.ts';

describe('buildReplyText', () => {
  it('formats a refuted verdict with sources and link', () => {
    const text = buildReplyText({
      verdict: 'false',
      publishers: ['CORRECTIV', 'AFP', 'Snopes'],
      detailUrl: 'https://facts.example.org/posts?uri=at://x',
    });
    expect(text).toContain('refuted');
    expect(text).toContain('CORRECTIV');
    expect(text).toContain('AFP');
    expect(text).toContain('Snopes');
    expect(text).toContain('https://facts.example.org/posts?uri=at://x');
  });

  it('uses a human-readable phrase for "unknown"', () => {
    const text = buildReplyText({
      verdict: 'unknown',
      publishers: [],
      detailUrl: 'https://x.test/p',
    });
    expect(text).toContain('not enough information');
  });

  it('dedupes publishers', () => {
    const text = buildReplyText({
      verdict: 'true',
      publishers: ['CORRECTIV', 'CORRECTIV', 'AFP'],
      detailUrl: 'https://x.test/p',
    });
    // Should not contain CORRECTIV twice.
    expect(text.match(/CORRECTIV/g)).toHaveLength(1);
  });

  it('omits sources block when none provided', () => {
    const text = buildReplyText({
      verdict: 'false',
      publishers: [],
      detailUrl: 'https://x.test/p',
    });
    expect(text).not.toContain('Sources:');
    expect(text).toContain('Details:');
  });

  it('caps text length at 280 chars', () => {
    const publishers = Array.from({ length: 20 }, (_, i) => `Publisher-${i}-with-long-name`);
    const text = buildReplyText({
      verdict: 'false',
      publishers,
      detailUrl: 'https://facts.example.org/posts?uri=at://did:plc:very-long-author/app.bsky.feed.post/3kxabcdef',
    });
    expect(text.length).toBeLessThanOrEqual(280);
  });
});
