/**
 * Minimal authenticated Bluesky client. Used only for posting replies to
 * mention-triggered fact-checks; see docs/TRIGGER_MENTIONS.md § Reply-to-mention.
 *
 * Auth flow:
 *   1. com.atproto.server.createSession with identifier + app password.
 *   2. Cache the access JWT in memory; refresh via refreshSession when needed.
 *   3. Use the accessJwt as Bearer to call com.atproto.repo.createRecord with an
 *      app.bsky.feed.post record shape.
 */
import { logger } from '../util/logger.ts';

interface Session {
  did: string;
  handle?: string;
  accessJwt: string;
  refreshJwt: string;
}

export interface BskyClientOptions {
  serviceUrl: string;
  identifier: string;
  password: string;
  fetchImpl?: typeof fetch;
}

export interface PostReplyInput {
  text: string;
  parent: { uri: string; cid: string };
  root: { uri: string; cid: string };
  /** ISO-8601; defaults to now. */
  createdAt?: string;
  /** BCP-47 language tags; small list is conventional. */
  langs?: string[];
}

export interface PostReplyResult {
  uri: string;
  cid: string;
}

/**
 * Build the record body for a Bluesky reply. Pure for testing.
 */
export function buildReplyRecord(input: PostReplyInput): Record<string, unknown> {
  return {
    $type: 'app.bsky.feed.post',
    text: input.text,
    createdAt: input.createdAt ?? new Date().toISOString(),
    langs: input.langs,
    reply: {
      parent: { uri: input.parent.uri, cid: input.parent.cid },
      root: { uri: input.root.uri, cid: input.root.cid },
    },
  };
}

export class BskyClient {
  private readonly serviceUrl: string;
  private readonly identifier: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private session: Session | undefined;

  constructor(opts: BskyClientOptions) {
    this.serviceUrl = opts.serviceUrl.replace(/\/$/, '');
    this.identifier = opts.identifier;
    this.password = opts.password;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async login(): Promise<void> {
    const res = await this.fetchImpl(`${this.serviceUrl}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ identifier: this.identifier, password: this.password }),
    });
    if (!res.ok) {
      throw new Error(`createSession ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const body = (await res.json()) as Session;
    this.session = body;
    logger.info({ did: body.did }, 'bsky session created');
  }

  private async refresh(): Promise<void> {
    if (!this.session) return this.login();
    const res = await this.fetchImpl(`${this.serviceUrl}/xrpc/com.atproto.server.refreshSession`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.session.refreshJwt}`,
        accept: 'application/json',
      },
    });
    if (!res.ok) {
      // Refresh failed — fall back to full login.
      logger.warn({ status: res.status }, 'bsky refresh failed, re-logging in');
      this.session = undefined;
      return this.login();
    }
    const body = (await res.json()) as Session;
    this.session = body;
  }

  async postReply(input: PostReplyInput): Promise<PostReplyResult> {
    if (!this.session) await this.login();
    if (!this.session) throw new Error('bsky session unavailable');

    const record = buildReplyRecord(input);
    const body = {
      repo: this.session.did,
      collection: 'app.bsky.feed.post',
      record,
    };

    let res = await this.fetchImpl(`${this.serviceUrl}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${this.session.accessJwt}`,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      // Access JWT expired — refresh and retry once.
      await this.refresh();
      if (!this.session) throw new Error('bsky re-auth failed');
      res = await this.fetchImpl(`${this.serviceUrl}/xrpc/com.atproto.repo.createRecord`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.session.accessJwt}`,
        },
        body: JSON.stringify(body),
      });
    }

    if (!res.ok) {
      throw new Error(`createRecord ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return (await res.json()) as PostReplyResult;
  }
}
