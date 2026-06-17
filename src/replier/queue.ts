/**
 * Persistent retry queue for mention replies the Bluesky API refused to take
 * synchronously. A small drain worker re-attempts pending rows with
 * exponential backoff; after the cap, rows go to `status = 'failed'` and stop
 * retrying.
 *
 * Survives service restarts — that's the whole point. If the labeler crashes
 * between "label emitted" and "reply posted", the queued reply is still tried
 * on the next start-up.
 */
import type { DbLike } from '../store/runtime-sqlite.ts';

export type ReplyKind = 'verdict' | 'no-claim' | 'no-match' | 'no-target';

export interface ReplyJob {
  parentUri: string;
  parentCid: string;
  rootUri: string;
  rootCid: string;
  text: string;
  replyKind: ReplyKind;
  proposalId?: number;
}

export interface QueuedReply extends ReplyJob {
  id: number;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  status: 'pending' | 'failed';
  createdAt: string;
}

const INITIAL_BACKOFF_SEC = 60;
const MAX_BACKOFF_SEC = 3600;
export const MAX_ATTEMPTS = 7;

/**
 * Enqueue a reply for later delivery. Idempotent on `parent_uri` — duplicate
 * jobs for the same mention update nothing (UNIQUE constraint absorbs them).
 *
 * Returns true when a new row was inserted, false when one already existed.
 */
export function enqueueReply(db: DbLike, job: ReplyJob): boolean {
  const result = db
    .prepare(
      `INSERT INTO reply_queue
         (parent_uri, parent_cid, root_uri, root_cid, text, reply_kind, proposal_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(parent_uri) DO NOTHING`,
    )
    .run(
      job.parentUri,
      job.parentCid,
      job.rootUri,
      job.rootCid,
      job.text,
      job.replyKind,
      job.proposalId ?? null,
    );
  return result.changes > 0;
}

/** Is a reply already queued (pending or failed) against this mention URI? */
export function hasQueuedReply(db: DbLike, parentUri: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM reply_queue WHERE parent_uri = ? LIMIT 1`)
    .get(parentUri);
}

/** Pull a small batch of pending rows ready for retry. */
export function takeReadyBatch(db: DbLike, limit = 10): QueuedReply[] {
  const rows = db
    .prepare(
      `SELECT id, parent_uri, parent_cid, root_uri, root_cid, text, reply_kind,
              proposal_id, attempts, next_attempt_at, last_error, status, created_at
         FROM reply_queue
        WHERE status = 'pending' AND next_attempt_at <= datetime('now')
        ORDER BY id
        LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    parent_uri: string;
    parent_cid: string;
    root_uri: string;
    root_cid: string;
    text: string;
    reply_kind: ReplyKind;
    proposal_id: number | null;
    attempts: number;
    next_attempt_at: string;
    last_error: string | null;
    status: 'pending' | 'failed';
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    parentUri: r.parent_uri,
    parentCid: r.parent_cid,
    rootUri: r.root_uri,
    rootCid: r.root_cid,
    text: r.text,
    replyKind: r.reply_kind,
    proposalId: r.proposal_id ?? undefined,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    status: r.status,
    createdAt: r.created_at,
  }));
}

/** Drop a row from the queue after a successful delivery. */
export function clearQueueRow(db: DbLike, id: number): void {
  db.prepare(`DELETE FROM reply_queue WHERE id = ?`).run(id);
}

/**
 * Record a failed attempt, schedule the next retry with exponential backoff.
 * After {@link MAX_ATTEMPTS}, the row is parked as `failed` and stops trying.
 */
export function recordFailure(db: DbLike, id: number, attempts: number, lastError: string): void {
  const nextAttempts = attempts + 1;
  const status: 'pending' | 'failed' = nextAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  const delay = Math.min(
    MAX_BACKOFF_SEC,
    INITIAL_BACKOFF_SEC * 2 ** Math.min(nextAttempts - 1, 6),
  );
  db.prepare(
    `UPDATE reply_queue
        SET attempts        = ?,
            next_attempt_at = datetime('now', ? || ' seconds'),
            last_error      = ?,
            status          = ?
      WHERE id = ?`,
  ).run(nextAttempts, `+${delay}`, lastError.slice(0, 1000), status, id);
}
