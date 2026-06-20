import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  readLifecycleStats,
  retireLiveLabels,
  selectLiveLabels,
} from '../src/labels/lifecycle.ts';

/**
 * Build an in-memory SQLite with the label_emit subset we need, seeded with the
 * rows the test wants. Adapter is a minimal wrapper around better-sqlite3.
 */
function withFreshDb(
  rows: Array<{
    post_uri: string;
    post_cid: string;
    val: string;
    neg: 0 | 1;
    cts: string;
  }>,
): { db: ReturnType<typeof asLike>; raw: Database.Database } {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE label_emit (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      post_uri  TEXT NOT NULL,
      post_cid  TEXT NOT NULL,
      val       TEXT NOT NULL,
      neg       INTEGER NOT NULL DEFAULT 0,
      cts       TEXT NOT NULL
    );
    -- retireLiveLabels also marks matching verdict rows as retired, so the
    -- minimal schema here needs the columns the UPDATE touches. Real DB has
    -- many more columns; only the ones the statement references matter.
    CREATE TABLE verdict (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      post_uri    TEXT NOT NULL,
      label       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'proposed',
      retired_at  TEXT,
      atproto_uri TEXT
    );
  `);
  const insert = raw.prepare(
    `INSERT INTO label_emit (post_uri, post_cid, val, neg, cts) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(r.post_uri, r.post_cid, r.val, r.neg, r.cts);
  }
  return { db: asLike(raw), raw };
}

function asLike(raw: Database.Database) {
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction: (fn: (...args: unknown[]) => unknown) => raw.transaction(fn as never),
    close: () => raw.close(),
    pragma: (v: string) => raw.pragma(v),
  };
}

describe('selectLiveLabels', () => {
  it('returns only labels whose most-recent row is positive', () => {
    const { db } = withFreshDb([
      { post_uri: 'at://a', post_cid: 'c1', val: 'fact-refuted', neg: 0, cts: '2026-01-01' },
      { post_uri: 'at://a', post_cid: 'c1', val: 'fact-refuted', neg: 1, cts: '2026-01-02' }, // negated
      { post_uri: 'at://b', post_cid: 'c2', val: 'fact-refuted', neg: 0, cts: '2026-01-01' }, // live
      { post_uri: 'at://c', post_cid: 'c3', val: 'fact-supported', neg: 0, cts: '2026-01-01' }, // live
    ]);
    const live = selectLiveLabels(db);
    expect(live.map((l) => l.postUri)).toEqual(['at://b', 'at://c']);
  });

  it('filters by val', () => {
    const { db } = withFreshDb([
      { post_uri: 'at://a', post_cid: 'c', val: 'fact-refuted',   neg: 0, cts: '2026-01-01' },
      { post_uri: 'at://b', post_cid: 'c', val: 'fact-supported', neg: 0, cts: '2026-01-01' },
    ]);
    const live = selectLiveLabels(db, { vals: ['fact-refuted'] });
    expect(live).toHaveLength(1);
    expect(live[0]!.val).toBe('fact-refuted');
  });

  it('filters by uri', () => {
    const { db } = withFreshDb([
      { post_uri: 'at://a', post_cid: 'c', val: 'fact-refuted', neg: 0, cts: '2026-01-01' },
      { post_uri: 'at://b', post_cid: 'c', val: 'fact-refuted', neg: 0, cts: '2026-01-01' },
    ]);
    const live = selectLiveLabels(db, { uris: ['at://a'] });
    expect(live).toHaveLength(1);
    expect(live[0]!.postUri).toBe('at://a');
  });
});

describe('retireLiveLabels', () => {
  it('emits neg=true for every live label exactly once', async () => {
    const { db } = withFreshDb([
      { post_uri: 'at://a', post_cid: 'c1', val: 'fact-refuted', neg: 0, cts: '2026-01-01' },
      { post_uri: 'at://b', post_cid: 'c2', val: 'fact-refuted', neg: 0, cts: '2026-01-01' },
    ]);

    const emitted: Array<{ uri: string; val: string; neg: boolean }> = [];
    const result = await retireLiveLabels(db, {
      emit: async (label) => {
        emitted.push({ uri: label.uri, val: label.val, neg: label.neg });
      },
    });

    expect(result).toEqual({
      total: 2,
      negated: 2,
      verdictsRetired: 0,
      verdictsReconciled: 0,
      retiredAtprotoUris: [],
      dryRun: false,
    });
    expect(emitted).toEqual([
      { uri: 'at://a', val: 'fact-refuted', neg: true },
      { uri: 'at://b', val: 'fact-refuted', neg: true },
    ]);
    // Each label has 2 rows now: the original positive + a new negation.
    const live = selectLiveLabels(db);
    expect(live).toHaveLength(0);
  });

  it('is idempotent — re-running negates nothing', async () => {
    const { db } = withFreshDb([
      { post_uri: 'at://a', post_cid: 'c', val: 'fact-refuted', neg: 0, cts: '2026-01-01' },
    ]);
    const emit = async (): Promise<void> => {};

    const first = await retireLiveLabels(db, { emit });
    expect(first.negated).toBe(1);

    const second = await retireLiveLabels(db, { emit });
    expect(second.negated).toBe(0);
    expect(second.total).toBe(0);
  });

  it('--dry-run touches nothing', async () => {
    const { db, raw } = withFreshDb([
      { post_uri: 'at://a', post_cid: 'c', val: 'fact-refuted', neg: 0, cts: '2026-01-01' },
    ]);
    const before = (raw.prepare('SELECT COUNT(*) AS n FROM label_emit').get() as { n: number }).n;

    const result = await retireLiveLabels(db, { dryRun: true });
    expect(result).toEqual({
      total: 1,
      negated: 0,
      verdictsRetired: 0,
      verdictsReconciled: 0,
      retiredAtprotoUris: [],
      dryRun: true,
    });

    const after = (raw.prepare('SELECT COUNT(*) AS n FROM label_emit').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('catches up verdicts whose label was negated by a pre-retired_at build', async () => {
    // 'at://old' has a positive emit and then a negation already on the wire
    // (simulating a retire run before retired_at existed). Its verdict row
    // still says retired_at IS NULL — we want the next retire run to fix that.
    const { db, raw } = withFreshDb([
      { post_uri: 'at://old', post_cid: 'c1', val: 'fact-refuted', neg: 0, cts: '2026-01-01' },
      { post_uri: 'at://old', post_cid: 'c1', val: 'fact-refuted', neg: 1, cts: '2026-01-02' },
    ]);
    raw.exec(`INSERT INTO verdict (post_uri, label, status) VALUES ('at://old', 'false', 'accepted');`);

    const result = await retireLiveLabels(db, { emit: async () => {} });

    // Nothing live to negate, but the reconcile pass stamps the stale verdict.
    expect(result.negated).toBe(0);
    expect(result.verdictsReconciled).toBe(1);
    const retired = raw
      .prepare(`SELECT post_uri FROM verdict WHERE retired_at IS NOT NULL`)
      .all() as Array<{ post_uri: string }>;
    expect(retired).toEqual([{ post_uri: 'at://old' }]);
  });

  it('marks the matching accepted verdict as retired when one exists', async () => {
    const { db, raw } = withFreshDb([
      { post_uri: 'at://a', post_cid: 'c1', val: 'fact-refuted', neg: 0, cts: '2026-01-01' },
      { post_uri: 'at://b', post_cid: 'c2', val: 'fact-supported', neg: 0, cts: '2026-01-01' },
    ]);
    // 'at://a' has an accepted verdict (will be retired), 'at://b' has none.
    raw.exec(`
      INSERT INTO verdict (post_uri, label, status) VALUES
        ('at://a', 'false', 'accepted'),
        ('at://c', 'false', 'accepted');     -- unrelated post, must stay live
    `);

    const result = await retireLiveLabels(db, { emit: async () => {} });
    expect(result.verdictsRetired).toBe(1);

    const retired = raw
      .prepare(`SELECT post_uri FROM verdict WHERE retired_at IS NOT NULL`)
      .all() as Array<{ post_uri: string }>;
    expect(retired).toEqual([{ post_uri: 'at://a' }]);
  });

  it('rejects accidentally calling without emit when not dry-run', async () => {
    const { db } = withFreshDb([
      { post_uri: 'at://a', post_cid: 'c', val: 'fact-refuted', neg: 0, cts: '2026-01-01' },
    ]);
    await expect(retireLiveLabels(db, { dryRun: false })).rejects.toThrow(/emit\(\) is required/);
  });

  it('honours val filter', async () => {
    const { db } = withFreshDb([
      { post_uri: 'at://a', post_cid: 'c', val: 'fact-refuted',   neg: 0, cts: '2026-01-01' },
      { post_uri: 'at://b', post_cid: 'c', val: 'fact-supported', neg: 0, cts: '2026-01-01' },
    ]);
    const emitted: string[] = [];
    const result = await retireLiveLabels(db, {
      filter: { vals: ['fact-refuted'] },
      emit: async (l) => {
        emitted.push(l.val);
      },
    });
    expect(result.negated).toBe(1);
    expect(emitted).toEqual(['fact-refuted']);
    const stillLive = selectLiveLabels(db);
    expect(stillLive.map((l) => l.val)).toEqual(['fact-supported']);
  });
});

describe('readLifecycleStats', () => {
  it('counts live and retired by value', () => {
    const { db } = withFreshDb([
      { post_uri: 'at://a', post_cid: 'c', val: 'fact-refuted',   neg: 0, cts: '2026-01-01' },
      { post_uri: 'at://b', post_cid: 'c', val: 'fact-refuted',   neg: 0, cts: '2026-01-01' },
      { post_uri: 'at://b', post_cid: 'c', val: 'fact-refuted',   neg: 1, cts: '2026-01-02' },
      { post_uri: 'at://c', post_cid: 'c', val: 'fact-supported', neg: 0, cts: '2026-01-01' },
    ]);
    const stats = readLifecycleStats(db);
    expect(stats.emittedTotal).toBe(4);
    expect(stats.liveTotal).toBe(2);
    expect(stats.retiredTotal).toBe(1);
    expect(stats.byVal).toEqual([
      { val: 'fact-refuted', live: 1, retired: 1 },
      { val: 'fact-supported', live: 1, retired: 0 },
    ]);
  });

  it('handles an empty db', () => {
    const { db } = withFreshDb([]);
    const stats = readLifecycleStats(db);
    expect(stats.emittedTotal).toBe(0);
    expect(stats.byVal).toEqual([]);
  });
});
