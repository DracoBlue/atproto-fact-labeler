/**
 * Retire-side counterpart to publish-claim-verdict.ts. When a verdict is
 * being retracted, its `app.kiesel.facts.claimVerdict` record on the
 * labeler's PDS is either removed (`delete`) or kept with a top-level
 * `retiredAt` timestamp (`tombstone`).
 *
 * Selection is operator-controlled via `ATPROTO_RETIRE_MODE` — see
 * docs/PROPOSAL_lexicons/LEXICON_DESIGN.md.
 */
import { CLAIM_VERDICT_NSID } from './atproto-verdict.ts';
import type { BskyClient } from '../replier/bsky.ts';

const RKEY_RE = /^at:\/\/[^/]+\/[^/]+\/(.+)$/;

function extractRkey(atUri: string): string | null {
  const m = atUri.match(RKEY_RE);
  return m ? m[1]! : null;
}

export type RetireMode = 'delete' | 'tombstone';

export interface RetireResultItem {
  atUri: string;
  status: 'deleted' | 'tombstoned' | 'failed' | 'skipped-no-rkey';
  reason?: string;
}

/** `deleteRecord` the claimVerdict at this at-uri. 404 is treated as success. */
export async function deleteClaimVerdict(
  bsky: BskyClient,
  atUri: string,
): Promise<RetireResultItem> {
  const rkey = extractRkey(atUri);
  if (!rkey) return { atUri, status: 'skipped-no-rkey' };
  try {
    await bsky.deleteRecord(CLAIM_VERDICT_NSID, rkey);
    return { atUri, status: 'deleted' };
  } catch (err) {
    const msg = (err as Error).message;
    // 404 / RecordNotFound means the PDS already doesn't have this record.
    // Treat as success so retire is idempotent.
    if (/RecordNotFound|404/.test(msg)) {
      return { atUri, status: 'deleted', reason: 'already absent' };
    }
    return { atUri, status: 'failed', reason: msg };
  }
}

/**
 * `putRecord` the existing claimVerdict at `atUri` with a top-level
 * `retiredAt` field spliced in. Caller fetches the record body first (the
 * detail server has the fetch path; tombstone-on-retire CLI replays it).
 */
export async function tombstoneClaimVerdict(
  bsky: BskyClient,
  atUri: string,
  currentRecord: Record<string, unknown>,
  now: string,
): Promise<RetireResultItem> {
  const rkey = extractRkey(atUri);
  if (!rkey) return { atUri, status: 'skipped-no-rkey' };
  const updated = { ...currentRecord, retiredAt: now };
  try {
    await bsky.putRecord(CLAIM_VERDICT_NSID, rkey, updated);
    return { atUri, status: 'tombstoned' };
  } catch (err) {
    return { atUri, status: 'failed', reason: (err as Error).message };
  }
}

/** One-line summary across multiple result items. */
export function summariseRetireResults(results: RetireResultItem[]): string {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return [...counts].map(([k, v]) => `${v} ${k}`).join(', ');
}
