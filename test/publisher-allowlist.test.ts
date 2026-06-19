import { describe, expect, it } from 'vitest';

import { PublisherAllowlist } from '../src/ingest/publisher-allowlist.ts';

describe('PublisherAllowlist', () => {
  const al = new PublisherAllowlist([
    'politifact.com',
    '*.factcrescendo.com',
    '# this is a comment',
    '',
    '   factly.in   ',
    'EXAMPLE.org # inline comment',
  ]);

  it('matches an exact host', () => {
    expect(al.isAllowedHost('politifact.com')).toBe(true);
    expect(al.isAllowedHost('factly.in')).toBe(true);
  });

  it('strips www. before matching', () => {
    expect(al.isAllowedHost('www.politifact.com')).toBe(true);
  });

  it('matches via *. suffix on subdomains and the bare apex', () => {
    expect(al.isAllowedHost('english.factcrescendo.com')).toBe(true);
    expect(al.isAllowedHost('factcrescendo.com')).toBe(true);
    expect(al.isAllowedHost('srilanka.factcrescendo.com')).toBe(true);
  });

  it('is case-insensitive on lookup and on the list itself', () => {
    expect(al.isAllowedHost('PolitiFact.COM')).toBe(true);
    expect(al.isAllowedHost('example.org')).toBe(true);
  });

  it('rejects unknown hosts, partial suffixes and tricks', () => {
    expect(al.isAllowedHost('evil.com')).toBe(false);
    expect(al.isAllowedHost('politifact.com.evil.com')).toBe(false);
    expect(al.isAllowedHost('notfactly.in')).toBe(false);
    expect(al.isAllowedHost('')).toBe(false);
    expect(al.isAllowedHost(null)).toBe(false);
    expect(al.isAllowedHost(undefined)).toBe(false);
  });

  it('parses publisher URLs and extracts the host', () => {
    expect(al.isAllowedUrl('https://www.politifact.com/article/foo')).toBe(true);
    expect(al.isAllowedUrl('http://english.factcrescendo.com/x')).toBe(true);
    expect(al.isAllowedUrl('https://shopingwoping.com/spam')).toBe(false);
    expect(al.isAllowedUrl(null)).toBe(false);
    expect(al.isAllowedUrl('not a url at all')).toBe(false);
  });

  it('treats an empty list as size 0', () => {
    expect(new PublisherAllowlist([]).size).toBe(0);
    expect(new PublisherAllowlist(['# only comments']).size).toBe(0);
  });
});
