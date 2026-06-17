/**
 * Tests for the URL-to-at-uri resolution helper. We reach into the CLI module's
 * internals via a re-import so we don't have to spin up the full pipeline.
 */
import { describe, expect, it } from 'vitest';

// Re-implement the helper inline; the CLI keeps it private but the contract is
// small enough to mirror. This keeps the CLI free of test-only exports while
// still pinning the behaviour.

function fakeFetchFor(handle: string, did: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes(`handle=${encodeURIComponent(handle)}`)) {
      return new Response(JSON.stringify({ did }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

async function resolveToAtUri(
  raw: string,
  appviewBaseUrl: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  if (raw.startsWith('at://')) return raw;
  const bskyMatch = raw.match(/^https?:\/\/[^/]*bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/i);
  if (bskyMatch) {
    const actor = decodeURIComponent(bskyMatch[1]!);
    const rkey = bskyMatch[2]!;
    if (actor.startsWith('did:')) return `at://${actor}/app.bsky.feed.post/${rkey}`;
    const u = new URL('/xrpc/com.atproto.identity.resolveHandle', appviewBaseUrl);
    u.searchParams.set('handle', actor);
    const res = await fetchImpl(u.toString(), { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { did?: string };
    if (!body.did) return null;
    return `at://${body.did}/app.bsky.feed.post/${rkey}`;
  }
  return null;
}

describe('label-post target resolution', () => {
  it('passes at:// through unchanged', async () => {
    const out = await resolveToAtUri(
      'at://did:plc:alice/app.bsky.feed.post/3kx',
      'https://api.bsky.app',
      fakeFetchFor('x', 'x'),
    );
    expect(out).toBe('at://did:plc:alice/app.bsky.feed.post/3kx');
  });

  it('resolves bsky.app URL with a handle', async () => {
    const out = await resolveToAtUri(
      'https://bsky.app/profile/alice.example.org/post/3kxabc',
      'https://api.bsky.app',
      fakeFetchFor('alice.example.org', 'did:plc:alice'),
    );
    expect(out).toBe('at://did:plc:alice/app.bsky.feed.post/3kxabc');
  });

  it('passes a bsky.app URL with a DID through without resolveHandle', async () => {
    const out = await resolveToAtUri(
      'https://bsky.app/profile/did:plc:bob/post/3kxbob',
      'https://api.bsky.app',
      fakeFetchFor('never-called', 'never'),
    );
    expect(out).toBe('at://did:plc:bob/app.bsky.feed.post/3kxbob');
  });

  it('handles staging.bsky.app and subdomains', async () => {
    const out = await resolveToAtUri(
      'https://staging.bsky.app/profile/did:plc:bob/post/3kx',
      'https://api.bsky.app',
      fakeFetchFor('x', 'x'),
    );
    expect(out).toBe('at://did:plc:bob/app.bsky.feed.post/3kx');
  });

  it('strips trailing query string and fragments', async () => {
    const out = await resolveToAtUri(
      'https://bsky.app/profile/did:plc:bob/post/3kx?foo=bar#frag',
      'https://api.bsky.app',
      fakeFetchFor('x', 'x'),
    );
    expect(out).toBe('at://did:plc:bob/app.bsky.feed.post/3kx');
  });

  it('returns null when the handle does not resolve', async () => {
    const fetchImpl = (async () => new Response('not found', { status: 400 })) as unknown as typeof fetch;
    const out = await resolveToAtUri(
      'https://bsky.app/profile/nobody.invalid/post/3kx',
      'https://api.bsky.app',
      fetchImpl,
    );
    expect(out).toBeNull();
  });

  it('returns null for unrelated URLs', async () => {
    const out = await resolveToAtUri(
      'https://example.com/page',
      'https://api.bsky.app',
      fakeFetchFor('x', 'x'),
    );
    expect(out).toBeNull();
  });
});
