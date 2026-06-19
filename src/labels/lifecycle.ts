/**
 * Lifecycle helpers — queries + the retire-content (negation) routine.
 *
 * Pure-DB shape so we can test it without spinning the LabelerServer up. The
 * actual on-wire `emitLabel` call is injected as `emit` so tests can stub it.
 */
import type { DbLike } from '../store/runtime-sqlite.ts';
import { labelToVerdict } from './vocabulary.ts';

export interface LiveLabel {
  postUri: string;
  postCid: string;
  val: string;
  cts: string;
}

export interface CountByVal {
  val: string;
  live: number;
  retired: number;
}

export interface LifecycleStats {
  byVal: CountByVal[];
  liveTotal: number;
  retiredTotal: number;
  emittedTotal: number;
  retiredAt: string | null;
}

export interface RetireFilter {
  vals?: string[];
  uris?: string[];
}

/**
 * Returns every (post_uri, val) pair whose **most-recent** label_emit row is
 * positive (neg=0). These are the labels currently visible to subscribers.
 *
 * If `filter.vals` or `filter.uris` is set, only matching pairs are returned.
 */
export function selectLiveLabels(db: DbLike, filter: RetireFilter = {}): LiveLabel[] {
  // Window-function approach: for every (post_uri, val), pick the latest row.
  const valClause = filter.vals?.length
    ? `AND val IN (${filter.vals.map(() => '?').join(',')})`
    : '';
  const uriClause = filter.uris?.length
    ? `AND post_uri IN (${filter.uris.map(() => '?').join(',')})`
    : '';

  const sql = `
    WITH ranked AS (
      SELECT post_uri, post_cid, val, neg, cts,
             ROW_NUMBER() OVER (PARTITION BY post_uri, val ORDER BY id DESC) AS rn
        FROM label_emit
       WHERE 1 = 1 ${valClause} ${uriClause}
    )
    SELECT post_uri, post_cid, val, cts
      FROM ranked
     WHERE rn = 1 AND neg = 0
     ORDER BY post_uri, val
  `;
  const params = [...(filter.vals ?? []), ...(filter.uris ?? [])];
  const rows = db.prepare(sql).all(...params) as Array<{
    post_uri: string;
    post_cid: string;
    val: string;
    cts: string;
  }>;
  return rows.map((r) => ({
    postUri: r.post_uri,
    postCid: r.post_cid,
    val: r.val,
    cts: r.cts,
  }));
}

/** Aggregate counts for the lifecycle status CLI. */
export function readLifecycleStats(db: DbLike): LifecycleStats {
  const totals = db
    .prepare(
      `SELECT SUM(CASE WHEN neg = 0 THEN 1 ELSE 0 END) AS pos,
              SUM(CASE WHEN neg = 1 THEN 1 ELSE 0 END) AS neg,
              COUNT(*)                                   AS total,
              MAX(CASE WHEN neg = 1 THEN cts END)        AS last_retired
         FROM label_emit`,
    )
    .get() as { pos: number | null; neg: number | null; total: number; last_retired: string | null };

  const byVal = db
    .prepare(
      `WITH ranked AS (
         SELECT post_uri, val, neg,
                ROW_NUMBER() OVER (PARTITION BY post_uri, val ORDER BY id DESC) AS rn
           FROM label_emit
       )
       SELECT val,
              SUM(CASE WHEN rn = 1 AND neg = 0 THEN 1 ELSE 0 END) AS live,
              SUM(CASE WHEN rn = 1 AND neg = 1 THEN 1 ELSE 0 END) AS retired
         FROM ranked
        GROUP BY val
        ORDER BY val`,
    )
    .all() as Array<{ val: string; live: number; retired: number }>;

  return {
    byVal,
    liveTotal: byVal.reduce((s, r) => s + r.live, 0),
    retiredTotal: byVal.reduce((s, r) => s + r.retired, 0),
    emittedTotal: totals.total,
    retiredAt: totals.last_retired,
  };
}

export interface RetireOptions {
  dryRun?: boolean;
  filter?: RetireFilter;
  /**
   * Function that actually sends the negation on the wire. Required when
   * `dryRun` is false. Receives the same label tuple we'd write to `label_emit`.
   */
  emit?: (label: { uri: string; cid: string; val: string; neg: true }) => Promise<void> | void;
  /** Optional progress hook (per label). */
  onLabel?: (label: LiveLabel, index: number, total: number) => void;
}

export interface RetireResult {
  total: number;
  negated: number;
  verdictsRetired: number;
  verdictsReconciled: number;
  dryRun: boolean;
}

/**
 * Catch-up pass — mark `verdict.retired_at` for any post whose on-wire label
 * is currently negated but whose verdict row was emitted by a pre-`retired_at`
 * build of the labeler. Runs on every retire invocation, no-ops on a fresh
 * DB. Returns the number of verdict rows it updated.
 *
 * Exposed for tests; called automatically from `retireLiveLabels`.
 */
export function reconcileRetiredVerdicts(db: DbLike): number {
  const sql = `
    WITH ranked AS (
      SELECT post_uri, val, neg,
             ROW_NUMBER() OVER (PARTITION BY post_uri, val ORDER BY id DESC) AS rn
        FROM label_emit
    ),
    currently_negated AS (
      SELECT post_uri, val FROM ranked WHERE rn = 1 AND neg = 1
    )
    UPDATE verdict
       SET retired_at = datetime('now')
     WHERE retired_at IS NULL
       AND status = 'accepted'
       AND EXISTS (
         SELECT 1 FROM currently_negated cn
          WHERE cn.post_uri = verdict.post_uri
            AND cn.val = CASE verdict.label
                          WHEN 'true'     THEN 'fact-supported'
                          WHEN 'false'    THEN 'fact-refuted'
                          WHEN 'mixed'    THEN 'fact-mixed'
                          WHEN 'disputed' THEN 'fact-disputed'
                          WHEN 'outdated' THEN 'fact-outdated'
                          WHEN 'unknown'  THEN 'fact-unknown'
                        END
       )
  `;
  const res = db.prepare(sql).run();
  return Number(res.changes ?? 0);
}

/**
 * Variant C — emit `neg=true` for every currently-live label.
 *
 * Idempotent across runs: a row whose most-recent emit is already negative is
 * skipped. Safe to re-run after a partial crash.
 */
export async function retireLiveLabels(
  db: DbLike,
  opts: RetireOptions = {},
): Promise<RetireResult> {
  // Catch up: any verdict whose on-wire label is already negated but whose
  // retired_at is empty (because it was negated by a pre-retired_at build of
  // the labeler) gets stamped now.
  const verdictsReconciled = opts.dryRun ? 0 : reconcileRetiredVerdicts(db);

  const targets = selectLiveLabels(db, opts.filter ?? {});
  const insertNeg = db.prepare(
    `INSERT INTO label_emit (post_uri, post_cid, val, neg, cts)
     VALUES (?, ?, ?, 1, datetime('now'))`,
  );
  // Hide the source verdict from the detail page once its label is negated.
  // We match by (post_uri, internal verdict label) — multiple verdicts on the
  // same post are independent and only the matching one gets retired.
  const markVerdictRetired = db.prepare(
    `UPDATE verdict
        SET retired_at = datetime('now')
      WHERE post_uri = ?
        AND label = ?
        AND status = 'accepted'
        AND retired_at IS NULL`,
  );

  let negated = 0;
  let verdictsRetired = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    opts.onLabel?.(t, i, targets.length);
    if (opts.dryRun) continue;
    if (!opts.emit) {
      throw new Error('retireLiveLabels: emit() is required when dryRun is false');
    }
    await opts.emit({ uri: t.postUri, cid: t.postCid, val: t.val, neg: true });
    insertNeg.run(t.postUri, t.postCid, t.val);
    negated++;

    const internalLabel = labelToVerdict(t.val);
    if (internalLabel) {
      const res = markVerdictRetired.run(t.postUri, internalLabel);
      verdictsRetired += Number(res.changes ?? 0);
    }
  }

  return {
    total: targets.length,
    negated,
    verdictsRetired,
    verdictsReconciled,
    dryRun: !!opts.dryRun,
  };
}
