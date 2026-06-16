/**
 * Replay posts from a local JSONL file. Used for tests and offline dev so the
 * pipeline can run without the live Jetstream.
 *
 * File format: one JSON object per line. Each line must minimally have
 * { text: string }, the rest is filled in with defaults.
 */
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

import type { IngestedPost, PostHandler } from './types.ts';

export interface FixtureOptions {
  path: string;
  onPost: PostHandler;
  signal?: AbortSignal;
}

export async function runFixture(opts: FixtureOptions): Promise<void> {
  const rl = createInterface({
    input: createReadStream(opts.path),
    crlfDelay: Infinity,
  });

  let index = 0;
  for await (const rawLine of rl) {
    if (opts.signal?.aborted) break;
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    let parsed: Partial<IngestedPost> & { text?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed.text !== 'string' || !parsed.text) continue;

    const post: IngestedPost = {
      uri: parsed.uri ?? `at://did:plc:fixture/${index}/app.bsky.feed.post/${index}`,
      cid: parsed.cid ?? `bafyfixture${index}`,
      did: parsed.did ?? `did:plc:fixture-${index}`,
      text: parsed.text,
      lang: parsed.lang,
      indexedAt: parsed.indexedAt ?? new Date().toISOString(),
      kind: 'post',
    };
    await opts.onPost(post);
    index++;
  }
}
