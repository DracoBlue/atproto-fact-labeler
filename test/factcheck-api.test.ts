import { describe, expect, it } from 'vitest';

import { searchFactCheckApi } from '../src/ingest/factcheck-api.ts';

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('searchFactCheckApi', () => {
  it('normalises a typical claims:search response', async () => {
    const hits = await searchFactCheckApi('test-key', 'earth is flat', {
      lang: 'en',
      fetchImpl: fakeFetch({
        claims: [
          {
            text: 'NASA admits earth is flat',
            claimant: 'Social media',
            claimReview: [
              {
                publisher: { name: 'USA Today', site: 'usatoday.com' },
                url: 'https://usatoday.com/factcheck/earth-flat-fake',
                title: 'False claim NASA admits earth is flat',
                reviewDate: '2024-08-12T12:34:56Z',
                textualRating: 'False',
                languageCode: 'en',
              },
            ],
          },
        ],
      }),
    });
    expect(hits).toEqual([
      {
        sourceUrl: 'https://usatoday.com/factcheck/earth-flat-fake',
        publisher: 'USA Today',
        publisherSite: 'usatoday.com',
        claimReviewed: 'NASA admits earth is flat',
        ratingNative: 'False',
        reviewDate: '2024-08-12T12:34:56Z',
        lang: 'en',
        title: 'False claim NASA admits earth is flat',
      },
    ]);
  });

  it('flattens multiple claimReviews per claim and skips entries without url/site', async () => {
    const hits = await searchFactCheckApi('test-key', 'q', {
      fetchImpl: fakeFetch({
        claims: [
          {
            text: 'Earth flat',
            claimReview: [
              { publisher: { name: 'A', site: 'a.com' }, url: 'https://a.com/1', textualRating: 'False' },
              { publisher: { name: 'B' /* no site → dropped */ }, url: 'https://b.com/1' },
              { publisher: { site: 'c.com' }, url: 'https://c.com/1', textualRating: 'Mostly False' },
            ],
          },
          {
            // empty text → whole claim dropped
            text: '   ',
            claimReview: [{ publisher: { name: 'D', site: 'd.com' }, url: 'https://d.com/1' }],
          },
        ],
      }),
    });
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.publisherSite)).toEqual(['a.com', 'c.com']);
    // missing publisher name falls back to site
    expect(hits[1]!.publisher).toBe('c.com');
  });

  it('returns [] on non-2xx — the pipeline keeps using the local pool', async () => {
    const hits = await searchFactCheckApi('test-key', 'q', { fetchImpl: fakeFetch({}, 429) });
    expect(hits).toEqual([]);
  });

  it('returns [] when fetch itself throws (timeout, network error, ...)', async () => {
    const hits = await searchFactCheckApi('test-key', 'q', {
      fetchImpl: (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });
    expect(hits).toEqual([]);
  });

  it('builds the right URL — query, languageCode, pageSize, key', async () => {
    let captured = '';
    await searchFactCheckApi('the-key', 'earth flat', {
      lang: 'de',
      pageSize: 7,
      fetchImpl: (async (url: string | URL | Request) => {
        captured = String(url);
        return new Response('{"claims":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    expect(captured).toContain('query=earth+flat');
    expect(captured).toContain('languageCode=de');
    expect(captured).toContain('pageSize=7');
    expect(captured).toContain('key=the-key');
  });
});
