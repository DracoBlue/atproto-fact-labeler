import { describe, expect, it } from 'vitest';

import { buildNoClaimReply, buildNoMatchReply, buildReplyText } from '../src/replier/format.ts';

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

  it('localises into German when requested', () => {
    const text = buildReplyText({
      verdict: 'false',
      publishers: ['CORRECTIV'],
      detailUrl: 'https://x.test/p',
      lang: 'de',
    });
    expect(text).toContain('Einschätzung');
    expect(text).toContain('widerlegt');
    expect(text).toContain('Quellen');
    expect(text).toContain('Details');
  });

  it('honours BCP-47 subtags like de-AT', () => {
    const text = buildReplyText({
      verdict: 'true',
      publishers: [],
      detailUrl: 'https://x.test/p',
      lang: 'de-AT',
    });
    expect(text).toContain('bestätigt');
  });

  it('falls back to defaultLang for unsupported languages', () => {
    const text = buildReplyText({
      verdict: 'false',
      publishers: [],
      detailUrl: 'https://x.test/p',
      lang: 'fr',
      defaultLang: 'de',
    });
    expect(text).toContain('widerlegt');
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

describe('buildNoClaimReply', () => {
  it('produces an English diagnostic by default', () => {
    const text = buildNoClaimReply();
    expect(text).toContain("couldn't find");
    expect(text).toContain('falsifiable');
  });

  it('localises into German', () => {
    const text = buildNoClaimReply({ lang: 'de' });
    expect(text).toContain('Tatsachenbehauptung');
  });

  it('falls back to defaultLang when source lang unsupported', () => {
    const text = buildNoClaimReply({ lang: 'jp', defaultLang: 'de' });
    expect(text).toContain('Tatsachenbehauptung');
  });
});

describe('buildNoMatchReply', () => {
  it('produces an English diagnostic by default', () => {
    const text = buildNoMatchReply();
    expect(text).toContain('checked');
    expect(text).toContain('publisher');
  });

  it('localises into German', () => {
    const text = buildNoMatchReply({ lang: 'de' });
    expect(text).toContain('Faktencheck-Quelle');
  });
});
