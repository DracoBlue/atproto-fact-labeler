import { describe, expect, it } from 'vitest';

import { AppViewClient } from '../src/ingest/appview.ts';

interface FetchCall {
  url: string;
  auth?: string;
}

function fakeFetch(handlers: Array<(req: Request) => Response>): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const queue = [...handlers];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, auth: req.headers.get('authorization') ?? undefined });
    const handler = queue.shift();
    if (!handler) throw new Error('unexpected extra fetch: ' + req.url);
    return handler(req);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const SAMPLE_POST = {
  uri: 'at://did:plc:bob/app.bsky.feed.post/3kx',
  cid: 'bafy-bob',
  author: { did: 'did:plc:bob' },
  record: {
    $type: 'app.bsky.feed.post',
    text: 'hello',
    createdAt: '2026-06-17T10:00:00.000Z',
  },
};

describe('AppViewClient authed fallback', () => {
  it('does not fall back when the public AppView succeeds', async () => {
    const { fn, calls } = fakeFetch([
      () =>
        new Response(JSON.stringify({ posts: [SAMPLE_POST] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const client = new AppViewClient({
      baseUrl: 'https://public.api.bsky.app',
      authedFallback: { baseUrl: 'https://api.bsky.app', getJwt: () => 'never-used' },
      fetchImpl: fn,
    });
    const post = await client.getPost(SAMPLE_POST.uri);
    expect(post?.uri).toBe(SAMPLE_POST.uri);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('public.api.bsky.app');
    expect(calls[0]!.auth).toBeUndefined();
  });

  it('falls back to authed when public returns 429', async () => {
    const { fn, calls } = fakeFetch([
      // public — rate limited
      () => new Response('rate limited', { status: 429 }),
      // authed — success
      () =>
        new Response(JSON.stringify({ posts: [SAMPLE_POST] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const client = new AppViewClient({
      baseUrl: 'https://public.api.bsky.app',
      authedFallback: { baseUrl: 'https://api.bsky.app', getJwt: () => 'ey.fake.jwt' },
      fetchImpl: fn,
    });
    const post = await client.getPost(SAMPLE_POST.uri);
    expect(post?.uri).toBe(SAMPLE_POST.uri);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('public.api.bsky.app');
    expect(calls[1]!.url).toContain('api.bsky.app');
    expect(calls[1]!.auth).toBe('Bearer ey.fake.jwt');
  });

  it('does not fall back on a definitive 404', async () => {
    const { fn, calls } = fakeFetch([
      () => new Response('not found', { status: 404 }),
    ]);
    const client = new AppViewClient({
      baseUrl: 'https://public.api.bsky.app',
      authedFallback: { baseUrl: 'https://api.bsky.app', getJwt: () => 'ey.fake.jwt' },
      fetchImpl: fn,
    });
    const post = await client.getPost(SAMPLE_POST.uri);
    expect(post).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('returns null when authed fallback also fails', async () => {
    const { fn, calls } = fakeFetch([
      () => new Response('rate limited', { status: 429 }),
      () => new Response('still failing', { status: 500 }),
    ]);
    const client = new AppViewClient({
      baseUrl: 'https://public.api.bsky.app',
      authedFallback: { baseUrl: 'https://api.bsky.app', getJwt: () => 'ey.fake.jwt' },
      fetchImpl: fn,
    });
    const post = await client.getPost(SAMPLE_POST.uri);
    expect(post).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('skips fallback when no JWT is available', async () => {
    const { fn, calls } = fakeFetch([
      () => new Response('rate limited', { status: 429 }),
    ]);
    const client = new AppViewClient({
      baseUrl: 'https://public.api.bsky.app',
      authedFallback: { baseUrl: 'https://api.bsky.app', getJwt: () => null },
      fetchImpl: fn,
    });
    const post = await client.getPost(SAMPLE_POST.uri);
    expect(post).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('handles a transient network error before falling back', async () => {
    const { fn, calls } = fakeFetch([
      () => {
        throw new Error('ECONNRESET');
      },
      () =>
        new Response(JSON.stringify({ posts: [SAMPLE_POST] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const client = new AppViewClient({
      baseUrl: 'https://public.api.bsky.app',
      authedFallback: { baseUrl: 'https://api.bsky.app', getJwt: () => 'ey.fake.jwt' },
      fetchImpl: fn,
    });
    const post = await client.getPost(SAMPLE_POST.uri);
    expect(post?.uri).toBe(SAMPLE_POST.uri);
    expect(calls).toHaveLength(2);
  });

  it('drops non-at:// URIs immediately', async () => {
    const { fn, calls } = fakeFetch([]);
    const client = new AppViewClient({
      baseUrl: 'https://public.api.bsky.app',
      fetchImpl: fn,
    });
    const post = await client.getPost('https://example.com/page');
    expect(post).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
