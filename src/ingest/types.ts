/**
 * Minimal shape we extract from each Jetstream `commit` event for an
 * `app.bsky.feed.post` create.
 */
export interface IngestedPost {
  uri: string;
  cid: string;
  did: string;
  text: string;
  lang?: string;
  indexedAt: string;
  /** Whether this post is a reply, repost, etc. We pre-filter those out. */
  kind: 'post';
}

export type PostHandler = (post: IngestedPost) => Promise<void> | void;
