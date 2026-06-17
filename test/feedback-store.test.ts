import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  isLabelerOwnUri,
  listFeedback,
  recordFeedback,
} from '../src/feedback/store.ts';

function freshDb() {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE feedback (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_uri       TEXT    NOT NULL,
      subject_cid       TEXT,
      reason_type       TEXT,
      reason            TEXT,
      count             INTEGER NOT NULL DEFAULT 1,
      first_reported_at TEXT    NOT NULL DEFAULT (datetime('now')),
      reported_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      resolved_at       TEXT,
      resolution        TEXT
    );
    CREATE UNIQUE INDEX ux_feedback_dedup
      ON feedback(subject_uri, COALESCE(reason_type, ''), COALESCE(reason, ''));
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

describe('isLabelerOwnUri', () => {
  it('matches when the URI authority is the labeler DID', () => {
    expect(
      isLabelerOwnUri(
        'at://did:plc:fact-labeler/app.bsky.feed.post/3kx',
        'did:plc:fact-labeler',
      ),
    ).toBe(true);
  });

  it('does not match a different DID', () => {
    expect(
      isLabelerOwnUri(
        'at://did:plc:alice/app.bsky.feed.post/3kx',
        'did:plc:fact-labeler',
      ),
    ).toBe(false);
  });

  it('does not partial-match a DID substring (anchored at authority)', () => {
    expect(
      isLabelerOwnUri(
        'at://did:plc:fact-labeler-evil-twin/app.bsky.feed.post/3kx',
        'did:plc:fact-labeler',
      ),
    ).toBe(false);
  });

  it('returns false for non-atproto URIs', () => {
    expect(
      isLabelerOwnUri('https://example.com/page', 'did:plc:fact-labeler'),
    ).toBe(false);
  });
});

describe('recordFeedback + listFeedback', () => {
  it('persists a row and returns it via list', () => {
    const { db } = freshDb();
    const id = recordFeedback(db, {
      subjectUri: 'at://did:plc:fact-labeler/app.bsky.feed.post/3kx',
      subjectCid: 'bafy-self',
      reasonType: 'com.atproto.moderation.defs#reasonOther',
      reason: 'your verdict is wrong',
    });
    expect(id).toBe(1);

    const rows = listFeedback(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      subjectUri: 'at://did:plc:fact-labeler/app.bsky.feed.post/3kx',
      reason: 'your verdict is wrong',
      resolvedAt: null,
    });
  });

  it('only-unresolved filter excludes resolved rows', () => {
    const { db, raw } = freshDb();
    recordFeedback(db, { subjectUri: 'at://x/y/z' });
    raw
      .prepare(`UPDATE feedback SET resolved_at = datetime('now'), resolution = 'fixed'`)
      .run();
    recordFeedback(db, { subjectUri: 'at://a/b/c' });

    const all = listFeedback(db);
    expect(all).toHaveLength(2);

    const open = listFeedback(db, { onlyUnresolved: true });
    expect(open).toHaveLength(1);
    expect(open[0]!.subjectUri).toBe('at://a/b/c');
  });

  it('respects limit + since filters', () => {
    const { db, raw } = freshDb();
    for (let i = 0; i < 5; i++) {
      recordFeedback(db, { subjectUri: `at://x/${i}` });
    }
    expect(listFeedback(db, { limit: 2 })).toHaveLength(2);

    const last = (raw.prepare('SELECT reported_at FROM feedback ORDER BY id DESC LIMIT 1').get() as
      | { reported_at: string }
      | undefined)?.reported_at;
    expect(last).toBeTruthy();
    const filtered = listFeedback(db, { since: last });
    expect(filtered.length).toBeGreaterThan(0);
  });

  it('dedupes duplicates and bumps count instead of creating new rows', () => {
    const { db, raw } = freshDb();
    const entry = {
      subjectUri: 'at://did:plc:fact-labeler/post/3kx',
      reasonType: 'com.atproto.moderation.defs#reasonOther',
      reason: 'verdict is wrong',
    };
    const a = recordFeedback(db, entry);
    const b = recordFeedback(db, entry);
    const c = recordFeedback(db, entry);
    expect(a).toBe(b);
    expect(b).toBe(c);
    const all = (raw.prepare('SELECT count FROM feedback').all() as Array<{ count: number }>);
    expect(all).toHaveLength(1);
    expect(all[0]!.count).toBe(3);
  });

  it('NULL-safe dedup on null reason_type / reason', () => {
    const { db, raw } = freshDb();
    recordFeedback(db, { subjectUri: 'at://x/y' });
    recordFeedback(db, { subjectUri: 'at://x/y' });
    const rows = raw.prepare('SELECT count FROM feedback').all() as Array<{ count: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
  });

  it('different (subject, reason_type, reason) tuples create separate rows', () => {
    const { db, raw } = freshDb();
    recordFeedback(db, { subjectUri: 'at://x/y', reason: 'first' });
    recordFeedback(db, { subjectUri: 'at://x/y', reason: 'second' });
    recordFeedback(db, { subjectUri: 'at://x/z', reason: 'first' });
    const n = (raw.prepare('SELECT COUNT(*) AS n FROM feedback').get() as { n: number }).n;
    expect(n).toBe(3);
  });
});
