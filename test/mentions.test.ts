import { describe, expect, it } from 'vitest';

import { detectMention } from '../src/ingest/mentions.ts';

const DID = 'did:plc:fact-labeler';

describe('detectMention', () => {
  it('returns no match for an empty post', () => {
    expect(detectMention({ text: '' }, { did: DID })).toEqual({ matched: false, via: null });
  });

  it('matches via structured facet', () => {
    const post = {
      text: 'hey check this',
      facets: [
        {
          features: [{ $type: 'app.bsky.richtext.facet#mention', did: DID }],
        },
      ],
    };
    expect(detectMention(post, { did: DID })).toEqual({ matched: true, via: 'facet' });
  });

  it('does not match a facet for a different DID', () => {
    const post = {
      text: '@someoneelse',
      facets: [
        {
          features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:other' }],
        },
      ],
    };
    expect(detectMention(post, { did: DID })).toEqual({ matched: false, via: null });
  });

  it('matches via plain-text handle fallback when no facets', () => {
    const post = { text: 'is this true @factbot ?' };
    expect(detectMention(post, { did: DID, handle: 'factbot' })).toEqual({
      matched: true,
      via: 'text',
    });
  });

  it('is case-insensitive on the text fallback', () => {
    const post = { text: 'hello @FactBot' };
    expect(detectMention(post, { did: DID, handle: 'factbot' })).toEqual({
      matched: true,
      via: 'text',
    });
  });

  it('does not text-match when handle is not configured', () => {
    const post = { text: '@factbot please check' };
    expect(detectMention(post, { did: DID })).toEqual({ matched: false, via: null });
  });

  it('prefers facet over text when both present', () => {
    const post = {
      text: '@factbot please check',
      facets: [
        {
          features: [{ $type: 'app.bsky.richtext.facet#mention', did: DID }],
        },
      ],
    };
    expect(detectMention(post, { did: DID, handle: 'factbot' })).toEqual({
      matched: true,
      via: 'facet',
    });
  });

  it('ignores non-mention facet features', () => {
    const post = {
      text: 'cool link',
      facets: [
        {
          features: [{ $type: 'app.bsky.richtext.facet#link' }],
        },
      ],
    };
    expect(detectMention(post, { did: DID })).toEqual({ matched: false, via: null });
  });
});
