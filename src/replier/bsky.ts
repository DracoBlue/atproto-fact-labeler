/**
 * Minimal authenticated Bluesky client. Used only for posting replies to
 * mention-triggered fact-checks; see docs/triggers/mentions.md § Reply-to-mention.
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

/**
 * Decode the `exp` claim from a JWT *without* verifying the signature.
 * The token came from bsky.social on a successful login; we trust it
 * to know its own expiry. Returns the Unix timestamp in seconds or
 * null when the JWT can't be parsed.
 */
function jwtExp(jwt: string): number | null {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    const claims = JSON.parse(json) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
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

export interface PostQuoteInput {
  text: string;
  /** The post we're embedding as a quote — the labeler's post stands on its own feed. */
  embed: { uri: string; cid: string };
  createdAt?: string;
  langs?: string[];
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

/**
 * Build a quote-post record. The labeler's post appears on the labeler's
 * own feed with the referenced post embedded — *not* threaded as a reply
 * under the original. Pure for testing.
 */
export function buildQuoteRecord(input: PostQuoteInput): Record<string, unknown> {
  return {
    $type: 'app.bsky.feed.post',
    text: input.text,
    createdAt: input.createdAt ?? new Date().toISOString(),
    langs: input.langs,
    embed: {
      $type: 'app.bsky.embed.record',
      record: { uri: input.embed.uri, cid: input.embed.cid },
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

  /** The current access JWT, or `null` if not logged in / session lost. */
  get accessJwt(): string | null {
    return this.session?.accessJwt ?? null;
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
    return this.createRecord(buildReplyRecord(input));
  }

  async postQuote(input: PostQuoteInput): Promise<PostReplyResult> {
    return this.createRecord(buildQuoteRecord(input));
  }

  /**
   * Check whether the author of `postUri` has disabled quote-posts on it.
   *
   * Returns `true` if quotes are allowed (no postgate record, or postgate
   * without the `disableRule` embedding rule), `false` if explicitly
   * disabled. The labeler honours `false` and skips the quote-post.
   *
   * Network errors / unknown failures resolve to `true` (fail-open) — a
   * transient public-api hiccup shouldn't prevent the labeler from
   * delivering its verdict. We accept the small risk of posting against an
   * author's wish during an outage in exchange for not silently dropping
   * the quote-post.
   */
  async quotesAllowed(postUri: string): Promise<boolean> {
    // at://did/collection/rkey → split into did + rkey, look up the matching
    // postgate record on the author's repo.
    const m = postUri.match(/^at:\/\/([^/]+)\/[^/]+\/(.+)$/);
    if (!m) return true;
    const [, did, rkey] = m;
    const url =
      `${this.serviceUrl}/xrpc/com.atproto.repo.getRecord` +
      `?repo=${encodeURIComponent(did!)}` +
      `&collection=app.bsky.feed.postgate` +
      `&rkey=${encodeURIComponent(rkey!)}`;
    try {
      const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
      if (res.status === 400 || res.status === 404) return true; // no postgate → allowed
      if (!res.ok) return true; // fail-open
      const body = (await res.json()) as {
        value?: {
          embeddingRules?: Array<{ $type?: string }>;
        };
      };
      const rules = body.value?.embeddingRules ?? [];
      const disabled = rules.some((r) => r.$type === 'app.bsky.feed.postgate#disableRule');
      return !disabled;
    } catch {
      return true; // fail-open on network / parsing error
    }
  }

  private async createRecord(record: Record<string, unknown>): Promise<PostReplyResult> {
    return this.callRepoMethod('createRecord', {
      collection: 'app.bsky.feed.post',
      record,
    });
  }

  /**
   * Create or replace a record at a known `(collection, rkey)` location on
   * the labeler's own repo. Idempotent for the lexicon-publication and
   * verdict-publication paths — re-running with the same rkey overwrites.
   */
  async putRecord(
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
  ): Promise<PostReplyResult> {
    return this.callRepoMethod('putRecord', {
      collection,
      rkey,
      record,
    });
  }

  /**
   * Create a record under an auto-generated rkey. Used by the verdict path
   * (each accepted verdict becomes its own claimVerdict record with a
   * fresh TID rkey).
   */
  async createRecordTyped(
    collection: string,
    record: Record<string, unknown>,
  ): Promise<PostReplyResult> {
    return this.callRepoMethod('createRecord', {
      collection,
      record,
    });
  }

  /**
   * Delete a record by rkey. Used on retire when the operator wants the
   * claimVerdict record removed entirely (vs. tombstoned via putRecord).
   */
  async deleteRecord(collection: string, rkey: string): Promise<void> {
    await this.callRepoMethod('deleteRecord', { collection, rkey });
  }

  /**
   * Is the cached access JWT about to expire? Bsky.social access tokens
   * have a ~2h lifetime; we refresh ~60 s before expiry so a long-running
   * downstream call doesn't trip over the boundary.
   *
   * Returns `true` (= treat as expired) when the JWT can't be decoded —
   * conservative because the alternative is a 400/ExpiredToken downstream
   * that the post-hoc retry has to clean up anyway.
   */
  private accessJwtExpired(safetySeconds = 60): boolean {
    if (!this.session) return true;
    const exp = jwtExp(this.session.accessJwt);
    if (exp === null) return false; // unparseable but present — let the call try, fall back to retry
    return exp <= Math.floor(Date.now() / 1000) + safetySeconds;
  }

  private async callRepoMethod(
    method: 'createRecord' | 'putRecord' | 'deleteRecord',
    extraBody: Record<string, unknown>,
  ): Promise<PostReplyResult> {
    if (!this.session) await this.login();
    if (!this.session) throw new Error('bsky session unavailable');

    // Proactive refresh: bsky.social returns 400 + ExpiredToken (not 401)
    // when the access JWT has aged out. Catching that post-hoc is possible
    // but burns a doomed round-trip. Cheaper to check the exp claim and
    // refresh before sending.
    if (this.accessJwtExpired()) {
      await this.refresh();
      if (!this.session) throw new Error('bsky re-auth failed');
    }

    const body = { repo: this.session.did, ...extraBody };
    const url = `${this.serviceUrl}/xrpc/com.atproto.repo.${method}`;
    const post = async (): Promise<Response> =>
      this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.session!.accessJwt}`,
        },
        body: JSON.stringify(body),
      });

    let res = await post();
    // Safety net: clock skew, a refresh that raced, or an edge case in the
    // exp check. 401 is the standard "token rejected"; bsky.social uses
    // 400 + ExpiredToken specifically when the JWT is well-formed but past
    // its expiry. Both warrant one retry after a refresh.
    let bodyText = '';
    if (!res.ok) bodyText = await res.text().catch(() => '');
    const expiredToken =
      res.status === 401 ||
      (res.status === 400 && bodyText.includes('ExpiredToken'));
    if (expiredToken) {
      await this.refresh();
      if (!this.session) throw new Error('bsky re-auth failed');
      res = await post();
      bodyText = '';
    }
    if (!res.ok) {
      if (!bodyText) bodyText = await res.text().catch(() => '');
      throw new Error(`${method} ${res.status}: ${bodyText}`);
    }
    // deleteRecord returns an empty body; parse-failure tolerated.
    return (await res
      .json()
      .catch(() => ({ uri: '', cid: '' }))) as PostReplyResult;
  }
}
