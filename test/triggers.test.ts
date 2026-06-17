import { describe, expect, it } from 'vitest';

import { evaluateTrigger, type TriggerConfig } from '../src/ingest/triggers.ts';
import type { IngestedPost } from '../src/ingest/types.ts';

const LABELER_DID = 'did:plc:fact-labeler';

function basePost(over: Partial<IngestedPost> = {}): IngestedPost {
  return {
    uri: 'at://did:plc:alice/app.bsky.feed.post/abc',
    cid: 'bafy-alice',
    did: 'did:plc:alice',
    text: 'hello world',
    indexedAt: '2026-06-16T00:00:00Z',
    kind: 'post',
    ...over,
  };
}

const ALL_OFF: TriggerConfig = {
  firehose: false,
  mentions: false,
  watchlist: [],
  labelerDid: LABELER_DID,
};

describe('evaluateTrigger', () => {
  it('drops every post when everything is disabled', () => {
    expect(evaluateTrigger(basePost(), ALL_OFF)).toBeNull();
  });

  it('firehose returns the post itself', () => {
    const hit = evaluateTrigger(basePost(), { ...ALL_OFF, firehose: true });
    expect(hit).toEqual({
      reason: 'firehose',
      targetUri: 'at://did:plc:alice/app.bsky.feed.post/abc',
      targetIsSourcePost: true,
    });
  });

  it('watchlist matches by author DID', () => {
    const hit = evaluateTrigger(basePost(), { ...ALL_OFF, watchlist: ['did:plc:alice'] });
    expect(hit?.reason).toBe('watchlist');
    expect(hit?.targetIsSourcePost).toBe(true);
  });

  it('watchlist does not match an unrelated DID', () => {
    expect(
      evaluateTrigger(basePost(), { ...ALL_OFF, watchlist: ['did:plc:other'] }),
    ).toBeNull();
  });

  it('mention in a top-level post targets the post itself', () => {
    const post = basePost({
      facets: [
        {
          features: [{ $type: 'app.bsky.richtext.facet#mention', did: LABELER_DID }],
        },
      ],
    });
    const hit = evaluateTrigger(post, { ...ALL_OFF, mentions: true });
    expect(hit).toEqual({
      reason: 'mention',
      targetUri: post.uri,
      targetIsSourcePost: true,
    });
  });

  it('mention in a reply targets the parent post', () => {
    const post = basePost({
      facets: [
        {
          features: [{ $type: 'app.bsky.richtext.facet#mention', did: LABELER_DID }],
        },
      ],
      replyParent: { uri: 'at://did:plc:bob/app.bsky.feed.post/parent', cid: 'bafy-bob' },
    });
    const hit = evaluateTrigger(post, { ...ALL_OFF, mentions: true });
    expect(hit).toEqual({
      reason: 'mention-reply',
      targetUri: 'at://did:plc:bob/app.bsky.feed.post/parent',
      targetIsSourcePost: false,
    });
  });

  it('mention requires the toggle to be on', () => {
    const post = basePost({
      facets: [
        {
          features: [{ $type: 'app.bsky.richtext.facet#mention', did: LABELER_DID }],
        },
      ],
    });
    expect(evaluateTrigger(post, ALL_OFF)).toBeNull();
  });

  it('firehose precedence: even a watchlisted post reports as firehose', () => {
    const hit = evaluateTrigger(basePost(), {
      ...ALL_OFF,
      firehose: true,
      watchlist: ['did:plc:alice'],
    });
    expect(hit?.reason).toBe('firehose');
  });

  it('text-fallback mention via configured handle', () => {
    const post = basePost({ text: 'is this true @factbot ?' });
    const hit = evaluateTrigger(post, {
      ...ALL_OFF,
      mentions: true,
      labelerHandle: 'factbot',
    });
    expect(hit?.reason).toBe('mention');
  });

  describe('self-mention protection', () => {
    it('drops a post authored by the labeler even on firehose', () => {
      const ours = basePost({ did: LABELER_DID, uri: 'at://did:plc:fact-labeler/x' });
      expect(evaluateTrigger(ours, { ...ALL_OFF, firehose: true })).toBeNull();
    });

    it('drops a post authored by the labeler even when watchlisted', () => {
      const ours = basePost({ did: LABELER_DID });
      const hit = evaluateTrigger(ours, { ...ALL_OFF, watchlist: [LABELER_DID] });
      expect(hit).toBeNull();
    });

    it('drops a labeler-authored post that mentions the labeler', () => {
      const ours = basePost({
        did: LABELER_DID,
        facets: [
          {
            features: [{ $type: 'app.bsky.richtext.facet#mention', did: LABELER_DID }],
          },
        ],
      });
      expect(evaluateTrigger(ours, { ...ALL_OFF, mentions: true })).toBeNull();
    });

    it('still triggers when the labeler is mentioned by a different author', () => {
      const them = basePost({
        did: 'did:plc:alice', // not the labeler
        facets: [
          {
            features: [{ $type: 'app.bsky.richtext.facet#mention', did: LABELER_DID }],
          },
        ],
      });
      expect(evaluateTrigger(them, { ...ALL_OFF, mentions: true })?.reason).toBe('mention');
    });
  });
});
