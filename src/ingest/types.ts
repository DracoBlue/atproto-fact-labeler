/**
 * Minimal shape we extract from each Jetstream `commit` event for an
 * `app.bsky.feed.post` create. Includes enough structure to detect mentions
 * and recover the parent post URI when the event is a reply.
 */
export interface MentionFacet {
  /** `app.bsky.richtext.facet#mention` */
  $type?: string;
  did: string;
}

export interface PostFacet {
  index?: { byteStart: number; byteEnd: number };
  features: Array<MentionFacet | { $type?: string }>;
}

export interface IngestedPost {
  uri: string;
  cid: string;
  did: string;
  text: string;
  lang?: string;
  indexedAt: string;
  /** Whether this post is a reply, repost, etc. */
  kind: 'post';
  /** Structured facets (mentions, links, tags) from the post record. */
  facets?: PostFacet[];
  /** Set when the post is a reply — used by mention-routing logic. */
  replyParent?: { uri: string; cid?: string };
  /** Set when the post is a reply — root of the thread (rarely useful for us). */
  replyRoot?: { uri: string; cid?: string };
}

export type PostHandler = (post: IngestedPost) => Promise<void> | void;
