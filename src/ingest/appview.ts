/**
 * Read-only AppView helper. Used to materialise a post when we have only a URI
 * (mention-in-reply targets, report subjects).
 *
 * No auth required for public posts. We hit `app.bsky.feed.getPosts` which
 * accepts up to 25 URIs and returns the resolved `PostView` array.
 */
import { logger } from '../util/logger.ts';
import type { IngestedPost } from './types.ts';

interface PostView {
  uri: string;
  cid: string;
  author: { did: string; handle?: string };
  record: {
    $type?: string;
    text?: string;
    langs?: string[];
    createdAt?: string;
    reply?: { parent?: { uri: string; cid?: string }; root?: { uri: string; cid?: string } };
    facets?: Array<{
      index?: { byteStart: number; byteEnd: number };
      features?: Array<{ $type?: string; did?: string }>;
    }>;
  };
  indexedAt?: string;
}

export interface AppViewClientOptions {
  baseUrl: string;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

export class AppViewClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AppViewClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getPost(uri: string): Promise<IngestedPost | null> {
    if (!uri.startsWith('at://')) return null;
    const u = new URL('/xrpc/app.bsky.feed.getPosts', this.baseUrl);
    u.searchParams.set('uris', uri);

    let body: { posts?: PostView[] };
    try {
      const res = await this.fetchImpl(u.toString(), {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        logger.warn({ uri, status: res.status }, 'appview getPosts non-OK');
        return null;
      }
      body = (await res.json()) as { posts?: PostView[] };
    } catch (err) {
      logger.warn({ err, uri }, 'appview getPosts failed');
      return null;
    }

    const pv = body.posts?.[0];
    if (!pv) return null;
    return toIngested(pv);
  }
}

function toIngested(pv: PostView): IngestedPost | null {
  const rec = pv.record;
  if (typeof rec.text !== 'string') return null;
  return {
    uri: pv.uri,
    cid: pv.cid,
    did: pv.author.did,
    text: rec.text,
    lang: rec.langs?.[0],
    indexedAt: pv.indexedAt ?? rec.createdAt ?? new Date().toISOString(),
    kind: 'post',
    facets: rec.facets?.map((f) => ({
      index: f.index,
      features: (f.features ?? []).map((feat) => ({
        $type: feat.$type,
        did: typeof feat.did === 'string' ? feat.did : '',
      })),
    })),
    replyParent: rec.reply?.parent
      ? { uri: rec.reply.parent.uri, cid: rec.reply.parent.cid }
      : undefined,
    replyRoot: rec.reply?.root ? { uri: rec.reply.root.uri, cid: rec.reply.root.cid } : undefined,
  };
}
