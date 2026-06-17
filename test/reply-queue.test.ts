import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  clearQueueRow,
  enqueueReply,
  hasQueuedReply,
  MAX_ATTEMPTS,
  recordFailure,
  takeReadyBatch,
} from '../src/replier/queue.ts';

function freshDb() {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE reply_queue (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_uri      TEXT NOT NULL UNIQUE,
      parent_cid      TEXT NOT NULL,
      root_uri        TEXT NOT NULL,
      root_cid        TEXT NOT NULL,
      text            TEXT NOT NULL,
      reply_kind      TEXT NOT NULL,
      proposal_id     INTEGER,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error      TEXT,
      status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','failed')),
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return {
    db: {
      exec: (s: string) => raw.exec(s),
      prepare: (s: string) => raw.prepare(s),
      transaction: (fn: (...a: never[]) => unknown) => raw.transaction(fn as never),
      close: () => raw.close(),
      pragma: (s: string) => raw.pragma(s),
    },
    raw,
  };
}

const JOB = {
  parentUri: 'at://did:plc:alice/app.bsky.feed.post/3kx',
  parentCid: 'bafy-alice',
  rootUri: 'at://did:plc:bob/app.bsky.feed.post/3kxbob',
  rootCid: 'bafy-bob',
  text: 'Verdict: refuted. Details: https://x.test/x',
  replyKind: 'verdict' as const,
  proposalId: 42,
};

describe('reply_queue', () => {
  it('enqueueReply inserts and is idempotent on parent_uri', () => {
    const { db, raw } = freshDb();
    expect(enqueueReply(db, JOB)).toBe(true);
    expect(enqueueReply(db, JOB)).toBe(false);
    const n = (raw.prepare('SELECT COUNT(*) AS n FROM reply_queue').get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('hasQueuedReply returns true for queued jobs', () => {
    const { db } = freshDb();
    expect(hasQueuedReply(db, JOB.parentUri)).toBe(false);
    enqueueReply(db, JOB);
    expect(hasQueuedReply(db, JOB.parentUri)).toBe(true);
  });

  it('takeReadyBatch returns pending jobs whose next_attempt_at has elapsed', () => {
    const { db } = freshDb();
    enqueueReply(db, JOB);
    const batch = takeReadyBatch(db);
    expect(batch).toHaveLength(1);
    expect(batch[0]!.parentUri).toBe(JOB.parentUri);
    expect(batch[0]!.attempts).toBe(0);
  });

  it('does not return jobs whose next_attempt_at is in the future', () => {
    const { db, raw } = freshDb();
    enqueueReply(db, JOB);
    raw
      .prepare(`UPDATE reply_queue SET next_attempt_at = datetime('now', '+1 hour')`)
      .run();
    expect(takeReadyBatch(db)).toHaveLength(0);
  });

  it('does not return rows in status=failed', () => {
    const { db, raw } = freshDb();
    enqueueReply(db, JOB);
    raw.prepare(`UPDATE reply_queue SET status = 'failed'`).run();
    expect(takeReadyBatch(db)).toHaveLength(0);
  });

  it('clearQueueRow removes a delivered row', () => {
    const { db, raw } = freshDb();
    enqueueReply(db, JOB);
    const [job] = takeReadyBatch(db);
    clearQueueRow(db, job!.id);
    const n = (raw.prepare('SELECT COUNT(*) AS n FROM reply_queue').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('recordFailure schedules an exponentially later retry', () => {
    const { db, raw } = freshDb();
    enqueueReply(db, JOB);
    const [job] = takeReadyBatch(db);
    recordFailure(db, job!.id, job!.attempts, 'first error');

    const row = raw.prepare('SELECT * FROM reply_queue').get() as {
      attempts: number;
      last_error: string;
      status: string;
      next_attempt_at: string;
    };
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('first error');
    expect(row.status).toBe('pending');
    // SQLite datetime('now') is TZ-naive UTC; parse it as such before comparing.
    expect(Date.parse(`${row.next_attempt_at}Z`)).toBeGreaterThan(Date.now());

    // takeReadyBatch should not return it yet — backoff in the future.
    expect(takeReadyBatch(db)).toHaveLength(0);
  });

  it('parks the row as failed after MAX_ATTEMPTS', () => {
    const { db, raw } = freshDb();
    enqueueReply(db, JOB);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      recordFailure(db, 1, i, 'still broken');
    }
    const row = raw.prepare('SELECT status, attempts FROM reply_queue').get() as {
      status: string;
      attempts: number;
    };
    expect(row.status).toBe('failed');
    expect(row.attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
  });

  it('truncates very long error messages to 1000 chars', () => {
    const { db, raw } = freshDb();
    enqueueReply(db, JOB);
    recordFailure(db, 1, 0, 'x'.repeat(5000));
    const row = raw.prepare('SELECT last_error FROM reply_queue').get() as {
      last_error: string;
    };
    expect(row.last_error.length).toBeLessThanOrEqual(1000);
  });
});
