/**
 * Jetstream WebSocket client for atproto.
 *
 * - Subscribes to `app.bsky.feed.post` create events.
 * - Persists `cursor` so we can resume across restarts.
 * - Reconnects with exponential backoff.
 * - Calls `onPost` for every new post.
 *
 * Jetstream is the cheap JSON stream (vs. the signed CBOR firehose). See
 * docs/ARCHITECTURE.md §1 and docs/COMPONENTS.md for the rationale.
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
    record?: {
      $type?: string;
      text?: string;
      langs?: string[];
      createdAt?: string;
      reply?: unknown;
      embed?: { $type?: string };
    };
  };
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
  if (rec.reply) return null; // skip replies for now — keep top-level posts
  return {
    uri: `at://${evt.did}/${evt.commit.collection}/${evt.commit.rkey}`,
    cid: evt.commit.cid ?? '',
    did: evt.did,
    text: rec.text,
    lang: rec.langs?.[0],
    indexedAt: rec.createdAt ?? new Date(evt.time_us / 1000).toISOString(),
    kind: 'post',
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
