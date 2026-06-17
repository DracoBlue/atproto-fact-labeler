/**
 * Capture and query feedback — user reports filed against the labeler's own
 * posts. We never run the fact-check pipeline on our own work; instead we
 * record the report so an operator can review and correct verdicts that were
 * wrong.
 */
import type { DbLike } from '../store/runtime-sqlite.ts';

export interface FeedbackEntry {
  subjectUri: string;
  subjectCid?: string;
  reasonType?: string;
  reason?: string;
}

export interface StoredFeedback extends FeedbackEntry {
  id: number;
  reportedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

/** Persist a single piece of feedback. Returns the inserted row id. */
export function recordFeedback(db: DbLike, entry: FeedbackEntry): number {
  const result = db
    .prepare(
      `INSERT INTO feedback (subject_uri, subject_cid, reason_type, reason)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      entry.subjectUri,
      entry.subjectCid ?? null,
      entry.reasonType ?? null,
      entry.reason ?? null,
    );
  return Number(result.lastInsertRowid);
}

export interface ListFeedbackOptions {
  since?: string;
  onlyUnresolved?: boolean;
  limit?: number;
}

export function listFeedback(db: DbLike, opts: ListFeedbackOptions = {}): StoredFeedback[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.since) {
    clauses.push('reported_at >= ?');
    params.push(opts.since);
  }
  if (opts.onlyUnresolved) {
    clauses.push('resolved_at IS NULL');
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT id, subject_uri, subject_cid, reason_type, reason, reported_at,
              resolved_at, resolution
         FROM feedback
         ${where}
         ORDER BY id DESC
         LIMIT ?`,
    )
    .all(...params) as Array<{
    id: number;
    subject_uri: string;
    subject_cid: string | null;
    reason_type: string | null;
    reason: string | null;
    reported_at: string;
    resolved_at: string | null;
    resolution: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    subjectUri: r.subject_uri,
    subjectCid: r.subject_cid ?? undefined,
    reasonType: r.reason_type ?? undefined,
    reason: r.reason ?? undefined,
    reportedAt: r.reported_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
  }));
}

/**
 * Quick check: does an atproto URI belong to the labeler account? URIs are
 * `at://<did>/<collection>/<rkey>` so a substring check on the DID is enough
 * and cheap — no parsing, no AppView round-trip.
 */
export function isLabelerOwnUri(uri: string, labelerDid: string): boolean {
  return uri.startsWith(`at://${labelerDid}/`);
}
