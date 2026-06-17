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
  /** Public (unauthenticated) AppView, e.g. https://public.api.bsky.app. */
  baseUrl: string;
  /**
   * Authed fallback used when the public AppView is rate-limited / transiently
   * unavailable. Typically `https://api.bsky.app` plus a getJwt callback that
   * returns the current access token from the BskyClient.
   */
  authedFallback?: {
    baseUrl: string;
    getJwt: () => string | null;
  };
  /** For tests. */
  fetchImpl?: typeof fetch;
}

export class AppViewClient {
  private readonly baseUrl: string;
  private readonly authedFallback: AppViewClientOptions['authedFallback'];
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AppViewClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.authedFallback = opts.authedFallback
      ? { ...opts.authedFallback, baseUrl: opts.authedFallback.baseUrl.replace(/\/$/, '') }
      : undefined;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getPost(uri: string): Promise<IngestedPost | null> {
    if (!uri.startsWith('at://')) return null;

    // First try the public read endpoint.
    const publicResult = await this.tryFetch(this.baseUrl, uri);
    if (publicResult.kind === 'ok') return publicResult.post;
    if (publicResult.kind === 'definitive-miss') return null;

    // Public failed transiently. If an authed fallback is configured, retry.
    if (!this.authedFallback) return null;
    const jwt = this.authedFallback.getJwt();
    if (!jwt) {
      logger.debug({ uri }, 'authed AppView fallback available but no JWT yet');
      return null;
    }
    logger.info({ uri, reason: publicResult.kind }, 'falling back to authed AppView');
    const authedResult = await this.tryFetch(this.authedFallback.baseUrl, uri, jwt);
    if (authedResult.kind === 'ok') return authedResult.post;
    return null;
  }

  private async tryFetch(
    baseUrl: string,
    uri: string,
    bearer?: string,
  ): Promise<
    | { kind: 'ok'; post: IngestedPost }
    | { kind: 'definitive-miss' }
    | { kind: 'transient'; status?: number }
  > {
    const u = new URL('/xrpc/app.bsky.feed.getPosts', baseUrl);
    u.searchParams.set('uris', uri);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;

    let body: { posts?: PostView[] };
    try {
      const res = await this.fetchImpl(u.toString(), { headers });
      if (!res.ok) {
        // 4xx other than rate-limit usually means the post is genuinely gone.
        // 5xx and 429 are transient — caller can fall back.
        if (res.status === 404 || res.status === 400) {
          logger.warn({ uri, status: res.status, baseUrl }, 'appview getPosts definitive miss');
          return { kind: 'definitive-miss' };
        }
        logger.warn({ uri, status: res.status, baseUrl }, 'appview getPosts non-OK');
        return { kind: 'transient', status: res.status };
      }
      body = (await res.json()) as { posts?: PostView[] };
    } catch (err) {
      logger.warn({ err, uri, baseUrl }, 'appview getPosts threw');
      return { kind: 'transient' };
    }

    const pv = body.posts?.[0];
    if (!pv) {
      // Successful response with empty list = post not found.
      return { kind: 'definitive-miss' };
    }
    const post = toIngested(pv);
    return post ? { kind: 'ok', post } : { kind: 'definitive-miss' };
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
