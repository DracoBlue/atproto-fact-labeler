/**
 * Jetstream WebSocket client for atproto.
 *
 * - Subscribes to `app.bsky.feed.post` create events.
 * - Persists `cursor` so we can resume across restarts.
 * - Reconnects with exponential backoff.
 * - Calls `onPost` for every new post.
 *
 * Jetstream is the cheap JSON stream from Bluesky (much smaller than the signed
 * CBOR firehose). It is *not* self-authenticating, which is fine for our use
 * case: we re-fetch any post we are about to label via the AppView before
 * making decisions, so we never trust a Jetstream event in isolation.
 */
import WebSocket from 'ws';
import { logger } from '../util/logger.ts';
import type { IngestedPost, PostHandler } from './types.ts';

const COLLECTION = 'app.bsky.feed.post';

/** Loaded subset of the Jetstream `commit` event shape. */
interface JetstreamCommitEvent {
  did: string;
  time_us: number;
  kind: 'commit';
  commit: {
    rev: string;
    operation: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    cid?: string;
    record?: JetstreamPostRecord;
  };
}

interface JetstreamPostRecord {
  $type?: string;
  text?: string;
  langs?: string[];
  createdAt?: string;
  reply?: {
    parent?: { uri: string; cid?: string };
    root?: { uri: string; cid?: string };
  };
  facets?: Array<{
    index?: { byteStart: number; byteEnd: number };
    features?: Array<{ $type?: string; did?: string }>;
  }>;
  embed?: {
    $type?: string;
    /** Set for app.bsky.embed.record — single-quote. */
    record?: {
      uri?: string;
      cid?: string;
      /** Set for app.bsky.embed.recordWithMedia — wraps the actual quote. */
      record?: { uri?: string; cid?: string };
    };
  };
}

/** Extract a single quoted-record reference from a post's embed, if any. */
function extractQuotedRecord(
  embed: JetstreamPostRecord['embed'],
): { uri: string; cid?: string } | undefined {
  if (!embed) return undefined;
  if (embed.$type === 'app.bsky.embed.record' && embed.record?.uri) {
    return { uri: embed.record.uri, cid: embed.record.cid };
  }
  if (embed.$type === 'app.bsky.embed.recordWithMedia' && embed.record?.record?.uri) {
    return { uri: embed.record.record.uri, cid: embed.record.record.cid };
  }
  return undefined;
}

export interface JetstreamOptions {
  url: string;
  cursorMicros?: number;
  saveCursor?: (cursorMicros: number) => void;
  onPost: PostHandler;
  /** Stop the loop after this many events. Useful for tests. */
  maxEvents?: number;
  /** Abort signal to stop the connection. */
  signal?: AbortSignal;
}

/**
 * Run a long-lived Jetstream connection. Resolves when the connection terminates
 * naturally (signal aborted or maxEvents reached).
 */
export async function runJetstream(opts: JetstreamOptions): Promise<void> {
  let attempt = 0;
  let events = 0;
  const { signal } = opts;

  while (!signal?.aborted) {
    const url = buildUrl(opts.url, opts.cursorMicros);
    logger.info({ url, attempt }, 'jetstream connecting');
    const ws = new WebSocket(url);

    try {
      await new Promise<void>((resolveFn, reject) => {
        const onAbort = () => {
          ws.close();
          reject(new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        ws.on('open', () => {
          attempt = 0;
          logger.info('jetstream connected');
        });

        ws.on('message', async (data) => {
          let evt: JetstreamCommitEvent;
          try {
            evt = JSON.parse(data.toString()) as JetstreamCommitEvent;
          } catch (err) {
            logger.warn({ err }, 'jetstream parse error');
            return;
          }
          if (evt.kind !== 'commit') return;
          if (evt.commit.collection !== COLLECTION) return;
          if (evt.commit.operation !== 'create') return;

          opts.cursorMicros = evt.time_us;
          opts.saveCursor?.(evt.time_us);

          const post = toIngestedPost(evt);
          if (!post) return;
          try {
            await opts.onPost(post);
          } catch (err) {
            logger.error({ err, uri: post.uri }, 'onPost handler error');
          }

          events++;
          if (opts.maxEvents && events >= opts.maxEvents) {
            ws.close();
            resolveFn();
          }
        });

        ws.on('error', (err) => {
          logger.warn({ err: err.message }, 'jetstream socket error');
        });

        ws.on('close', () => {
          signal?.removeEventListener('abort', onAbort);
          resolveFn();
        });
      });
    } catch (err) {
      if ((err as Error).message === 'aborted') return;
      logger.warn({ err }, 'jetstream loop ended with error');
    }

    if (signal?.aborted) return;

    attempt++;
    const backoff = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    logger.info({ backoffMs: backoff }, 'reconnecting after backoff');
    await sleep(backoff, signal);
  }
}

function buildUrl(base: string, cursorMicros?: number): string {
  const u = new URL(base);
  u.searchParams.set('wantedCollections', COLLECTION);
  if (cursorMicros) u.searchParams.set('cursor', String(cursorMicros));
  return u.toString();
}

function toIngestedPost(evt: JetstreamCommitEvent): IngestedPost | null {
  const rec = evt.commit.record;
  if (!rec || rec.$type !== COLLECTION) return null;
  if (typeof rec.text !== 'string') return null;
  // Replies are preserved — mention-in-reply triggers need them. The trigger
  // layer is responsible for deciding whether to fact-check the reply itself
  // or its parent.

  const facets = (rec.facets ?? []).map((f) => ({
    index: f.index,
    features: (f.features ?? []).map((feat) => ({
      $type: feat.$type,
      did: typeof feat.did === 'string' ? feat.did : '',
    })),
  }));

  return {
    uri: `at://${evt.did}/${evt.commit.collection}/${evt.commit.rkey}`,
    cid: evt.commit.cid ?? '',
    did: evt.did,
    text: rec.text,
    lang: rec.langs?.[0],
    indexedAt: rec.createdAt ?? new Date(evt.time_us / 1000).toISOString(),
    kind: 'post',
    facets: facets.length ? facets : undefined,
    replyParent: rec.reply?.parent
      ? { uri: rec.reply.parent.uri, cid: rec.reply.parent.cid }
      : undefined,
    replyRoot: rec.reply?.root
      ? { uri: rec.reply.root.uri, cid: rec.reply.root.cid }
      : undefined,
    quotedRecord: extractQuotedRecord(rec.embed),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveFn) => {
    const t = setTimeout(resolveFn, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolveFn();
    });
  });
}
