import { describe, expect, it, vi } from 'vitest';

import { BskyClient, buildQuoteRecord, buildReplyRecord } from '../src/replier/bsky.ts';

describe('buildReplyRecord', () => {
  it('produces a well-formed app.bsky.feed.post record', () => {
    const rec = buildReplyRecord({
      text: 'hello',
      parent: { uri: 'at://alice', cid: 'bafy-alice' },
      root: { uri: 'at://bob', cid: 'bafy-bob' },
      createdAt: '2026-06-17T10:00:00.000Z',
      langs: ['en'],
    });
    expect(rec).toEqual({
      $type: 'app.bsky.feed.post',
      text: 'hello',
      createdAt: '2026-06-17T10:00:00.000Z',
      langs: ['en'],
      reply: {
        parent: { uri: 'at://alice', cid: 'bafy-alice' },
        root: { uri: 'at://bob', cid: 'bafy-bob' },
      },
    });
  });

  it('defaults createdAt to now when omitted', () => {
    const before = Date.now();
    const rec = buildReplyRecord({
      text: 't',
      parent: { uri: 'at://a', cid: 'c' },
      root: { uri: 'at://a', cid: 'c' },
    }) as { createdAt: string };
    const ts = Date.parse(rec.createdAt);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});

describe('BskyClient', () => {
  function fakeFetch(handlers: Array<(req: Request) => Response | Promise<Response>>): typeof fetch {
    const queue = [...handlers];
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const handler = queue.shift();
      if (!handler) throw new Error('unexpected extra fetch call: ' + req.url);
      return handler(req);
    }) as unknown as typeof fetch;
  }

  it('logs in and posts a reply, sending Bearer with access JWT', async () => {
    const calls: { url: string; auth?: string; body?: unknown }[] = [];
    const fetchImpl = fakeFetch([
      async (req) => {
        calls.push({ url: req.url, body: await req.clone().json() });
        return new Response(
          JSON.stringify({ did: 'did:plc:labeler', accessJwt: 'a', refreshJwt: 'r' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
      async (req) => {
        calls.push({ url: req.url, auth: req.headers.get('authorization') ?? undefined, body: await req.clone().json() });
        return new Response(
          JSON.stringify({ uri: 'at://did:plc:labeler/app.bsky.feed.post/reply1', cid: 'bafy-reply1' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    ]);

    const client = new BskyClient({
      serviceUrl: 'https://bsky.social',
      identifier: 'facts.example.org',
      password: 'app-password',
      fetchImpl,
    });

    const result = await client.postReply({
      text: 'Verdict: refuted.',
      parent: { uri: 'at://alice', cid: 'bafy-alice' },
      root: { uri: 'at://alice', cid: 'bafy-alice' },
    });

    expect(result).toEqual({
      uri: 'at://did:plc:labeler/app.bsky.feed.post/reply1',
      cid: 'bafy-reply1',
    });
    expect(calls[0]!.url).toContain('/xrpc/com.atproto.server.createSession');
    expect(calls[0]!.body).toMatchObject({ identifier: 'facts.example.org', password: 'app-password' });
    expect(calls[1]!.url).toContain('/xrpc/com.atproto.repo.createRecord');
    expect(calls[1]!.auth).toBe('Bearer a');
  });

  it('refreshes the session on a 401 and retries the post', async () => {
    const fetchImpl = fakeFetch([
      // 1: createSession
      async () =>
        new Response(JSON.stringify({ did: 'did:plc:labeler', accessJwt: 'old', refreshJwt: 'r1' }), {
          status: 200,
        }),
      // 2: createRecord → 401
      async () => new Response('expired', { status: 401 }),
      // 3: refreshSession → new tokens
      async () =>
        new Response(JSON.stringify({ did: 'did:plc:labeler', accessJwt: 'new', refreshJwt: 'r2' }), {
          status: 200,
        }),
      // 4: createRecord retry with new bearer → success
      async (req) => {
        expect(req.headers.get('authorization')).toBe('Bearer new');
        return new Response(JSON.stringify({ uri: 'at://r', cid: 'bafy-r' }), { status: 200 });
      },
    ]);

    const client = new BskyClient({
      serviceUrl: 'https://bsky.social',
      identifier: 'x',
      password: 'y',
      fetchImpl,
    });
    const result = await client.postReply({
      text: 't',
      parent: { uri: 'at://a', cid: 'c' },
      root: { uri: 'at://a', cid: 'c' },
    });
    expect(result.uri).toBe('at://r');
  });

  it('throws on createSession failure', async () => {
    const fetchImpl = fakeFetch([async () => new Response('bad creds', { status: 401 })]);
    const client = new BskyClient({
      serviceUrl: 'https://bsky.social',
      identifier: 'x',
      password: 'y',
      fetchImpl,
    });
    await expect(client.login()).rejects.toThrow(/createSession 401/);
  });
});

describe('buildQuoteRecord', () => {
  it('produces a quote-post with embed.record', () => {
    const rec = buildQuoteRecord({
      text: 'Fact-supported. https://...',
      embed: { uri: 'at://did:plc:alice/app.bsky.feed.post/3k', cid: 'bafy-target' },
      createdAt: '2026-06-20T10:00:00.000Z',
      langs: ['en'],
    });
    expect(rec).toEqual({
      $type: 'app.bsky.feed.post',
      text: 'Fact-supported. https://...',
      createdAt: '2026-06-20T10:00:00.000Z',
      langs: ['en'],
      embed: {
        $type: 'app.bsky.embed.record',
        record: { uri: 'at://did:plc:alice/app.bsky.feed.post/3k', cid: 'bafy-target' },
      },
    });
    // Make sure we didn't accidentally also attach a `reply` field —
    // quote-posts go on the labeler's own feed, not in the target's thread.
    expect(rec.reply).toBeUndefined();
  });
});

describe('BskyClient.quotesAllowed', () => {
  function clientWithFetch(impl: typeof fetch): BskyClient {
    return new BskyClient({
      serviceUrl: 'https://bsky.social',
      identifier: 'x',
      password: 'y',
      fetchImpl: impl,
    });
  }

  it('returns true when postgate does not exist (404)', async () => {
    const c = clientWithFetch((async () => new Response('not found', { status: 404 })) as unknown as typeof fetch);
    const ok = await c.quotesAllowed('at://did:plc:alice/app.bsky.feed.post/abc');
    expect(ok).toBe(true);
  });

  it('returns false when postgate carries disableRule', async () => {
    const c = clientWithFetch((async () =>
      new Response(
        JSON.stringify({ value: { embeddingRules: [{ $type: 'app.bsky.feed.postgate#disableRule' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch);
    const ok = await c.quotesAllowed('at://did:plc:alice/app.bsky.feed.post/abc');
    expect(ok).toBe(false);
  });

  it('returns true when postgate has unrelated rules (no disableRule)', async () => {
    const c = clientWithFetch((async () =>
      new Response(
        JSON.stringify({ value: { embeddingRules: [{ $type: 'app.bsky.feed.postgate#allowOtherRule' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch);
    const ok = await c.quotesAllowed('at://did:plc:alice/app.bsky.feed.post/abc');
    expect(ok).toBe(true);
  });

  it('fails open on network error (treats absence of evidence as consent)', async () => {
    const c = clientWithFetch((async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch);
    const ok = await c.quotesAllowed('at://did:plc:alice/app.bsky.feed.post/abc');
    expect(ok).toBe(true);
  });

  it('returns true for malformed URIs (no crash)', async () => {
    const c = clientWithFetch((async () => new Response('', { status: 200 })) as unknown as typeof fetch);
    expect(await c.quotesAllowed('not-an-at-uri')).toBe(true);
  });
});
