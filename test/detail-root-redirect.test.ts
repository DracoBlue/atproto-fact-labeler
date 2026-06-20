import { describe, expect, it } from 'vitest';

import { resolveRootRedirect } from '../src/detail/server.ts';

describe('resolveRootRedirect', () => {
  const realDid = 'did:plc:7elfhdwxzvsqib4wmfn3zra7';
  const placeholderDid = 'did:plc:placeholder-replace-after-setup';
  const repo = 'https://github.com/DracoBlue/atproto-fact-labeler';

  it('derives the bsky profile URL when no override is set and DID is real', () => {
    expect(resolveRootRedirect(undefined, realDid)).toBe(`https://bsky.app/profile/${realDid}`);
  });

  it('falls back to the project repo when DID is still the placeholder', () => {
    // Pre-setup deploys keep the placeholder DID; the redirect should still
    // point somewhere useful, not to a 404 bsky profile.
    expect(resolveRootRedirect(undefined, placeholderDid)).toBe(repo);
  });

  it('uses the explicit override when provided, even with a real DID', () => {
    expect(resolveRootRedirect('https://about.kiesel.app/facts', realDid)).toBe(
      'https://about.kiesel.app/facts',
    );
  });

  it('returns null when the override is an explicit empty string', () => {
    // Operator opted out — route should not be registered, root returns 404.
    expect(resolveRootRedirect('', realDid)).toBeNull();
    expect(resolveRootRedirect('', placeholderDid)).toBeNull();
  });

  it('treats undefined and a real DID as the happy path', () => {
    // Sanity: the typical production case yields a bsky URL, not the repo.
    const target = resolveRootRedirect(undefined, realDid);
    expect(target).toMatch(/^https:\/\/bsky\.app\/profile\/did:plc:/);
  });
});
