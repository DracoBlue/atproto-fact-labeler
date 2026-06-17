/**
 * Detect whether a post mentions our labeler.
 *
 * Two channels:
 *  1. Structured facets — `app.bsky.richtext.facet#mention` features whose
 *     `did` equals the labeler DID. This is the authoritative path: a
 *     well-formed Bluesky client produces facets for every mention.
 *  2. Plain-text fallback — `@<handle>` substring match. Only used when no
 *     facets are present (e.g. older clients, future tooling) and only when a
 *     handle is configured. Substring match is loose by design; the trigger
 *     layer uses this as a hint, not a hard signal.
 */
import type { IngestedPost } from './types.ts';

const MENTION_FACET = 'app.bsky.richtext.facet#mention';

export interface MentionDetectionOptions {
  did: string;
  /** Without leading `@`. Optional. */
  handle?: string;
}

export interface MentionDetection {
  matched: boolean;
  via: 'facet' | 'text' | null;
}

export function detectMention(
  post: Pick<IngestedPost, 'text' | 'facets'>,
  opts: MentionDetectionOptions,
): MentionDetection {
  const facetHit = (post.facets ?? []).some((f) =>
    (f.features ?? []).some((feat) => feat.$type === MENTION_FACET && (feat as { did?: string }).did === opts.did),
  );
  if (facetHit) return { matched: true, via: 'facet' };

  if (opts.handle && post.text) {
    const needle = `@${opts.handle.toLowerCase()}`;
    if (post.text.toLowerCase().includes(needle)) {
      return { matched: true, via: 'text' };
    }
  }

  return { matched: false, via: null };
}
