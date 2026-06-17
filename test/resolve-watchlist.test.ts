import { describe, expect, it } from 'vitest';

import { resolveWatchlistToDids } from '../src/config/resolve-watchlist.ts';

function fakeFetch(handlers: Array<(req: Request) => Response>): typeof fetch {
  const queue = [...handlers];
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const handler = queue.shift();
    if (!handler) throw new Error('unexpected extra fetch: ' + req.url);
    return handler(req);
  }) as unknown as typeof fetch;
}

describe('resolveWatchlistToDids', () => {
  it('returns [] for an empty list', async () => {
    const out = await resolveWatchlistToDids([], { appviewUrl: 'https://x.test' });
    expect(out).toEqual([]);
  });

  it('passes DIDs through unchanged', async () => {
    const out = await resolveWatchlistToDids(['did:plc:abc', 'did:web:example.com'], {
      appviewUrl: 'https://x.test',
      fetchImpl: fakeFetch([]), // no calls expected
    });
    expect(out).toEqual(['did:plc:abc', 'did:web:example.com']);
  });

  it('resolves a bare handle via resolveHandle', async () => {
    const fetchImpl = fakeFetch([
      (req) => {
        expect(req.url).toContain('/xrpc/com.atproto.identity.resolveHandle');
        expect(req.url).toContain('handle=alice.example.org');
        return new Response(JSON.stringify({ did: 'did:plc:alice' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    ]);
    const out = await resolveWatchlistToDids(['alice.example.org'], {
      appviewUrl: 'https://x.test',
      fetchImpl,
    });
    expect(out).toEqual(['did:plc:alice']);
  });

  it('strips a leading @ from handles', async () => {
    const fetchImpl = fakeFetch([
      (req) => {
        expect(req.url).toContain('handle=alice.example.org');
        expect(req.url).not.toContain('@');
        return new Response(JSON.stringify({ did: 'did:plc:alice' }), { status: 200 });
      },
    ]);
    const out = await resolveWatchlistToDids(['@alice.example.org'], {
      appviewUrl: 'https://x.test',
      fetchImpl,
    });
    expect(out).toEqual(['did:plc:alice']);
  });

  it('throws when resolveHandle returns 400', async () => {
    const fetchImpl = fakeFetch([() => new Response('bad', { status: 400 })]);
    await expect(
      resolveWatchlistToDids(['alice.example.org'], { appviewUrl: 'https://x.test', fetchImpl }),
    ).rejects.toThrow(/TRIGGER_WATCHLIST/);
  });

  it('throws once with a summary listing all failures', async () => {
    const fetchImpl = fakeFetch([
      () => new Response('', { status: 400 }),
      () => new Response('', { status: 500 }),
    ]);
    await expect(
      resolveWatchlistToDids(['alice.example.org', 'bob.example.org'], {
        appviewUrl: 'https://x.test',
        fetchImpl,
      }),
    ).rejects.toThrow(/alice\.example\.org.*bob\.example\.org/s);
  });

  it('dedupes the final list', async () => {
    const fetchImpl = fakeFetch([
      () => new Response(JSON.stringify({ did: 'did:plc:alice' }), { status: 200 }),
    ]);
    const out = await resolveWatchlistToDids(['did:plc:alice', 'alice.example.org'], {
      appviewUrl: 'https://x.test',
      fetchImpl,
    });
    expect(out).toEqual(['did:plc:alice']);
  });

  it('lowercases did:plc method-specific ids', async () => {
    const out = await resolveWatchlistToDids(['did:plc:ABCDEF'], {
      appviewUrl: 'https://x.test',
      fetchImpl: fakeFetch([]),
    });
    expect(out).toEqual(['did:plc:abcdef']);
  });
});
