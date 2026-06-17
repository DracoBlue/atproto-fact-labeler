/**
 * Resolve each TRIGGER_WATCHLIST entry to a canonical DID at startup.
 *
 * Entries that already start with `did:` are passed through unchanged. Anything
 * else is treated as a Bluesky handle and resolved via
 * `com.atproto.identity.resolveHandle` against the public AppView.
 *
 * If *any* entry fails to resolve, startup aborts — a half-resolved watchlist
 * silently misses posts and produces hard-to-debug behaviour. Better to surface
 * the bad config immediately.
 */
import { logger } from '../util/logger.ts';

export interface ResolveWatchlistOptions {
  appviewUrl: string;
  fetchImpl?: typeof fetch;
}

const DID_PREFIX = 'did:';

export async function resolveWatchlistToDids(
  watchlist: readonly string[],
  opts: ResolveWatchlistOptions,
): Promise<string[]> {
  if (watchlist.length === 0) return [];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.appviewUrl.replace(/\/$/, '');

  const resolved: string[] = [];
  const failures: Array<{ handle: string; reason: string }> = [];

  for (const raw of watchlist) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith(DID_PREFIX)) {
      resolved.push(normaliseDid(entry));
      continue;
    }
    const handle = entry.replace(/^@/, '');
    try {
      const did = await resolveHandle(handle, baseUrl, fetchImpl);
      if (!did) {
        failures.push({ handle, reason: 'resolveHandle returned no did' });
        continue;
      }
      logger.info({ handle, did }, 'resolved watchlist handle');
      resolved.push(normaliseDid(did));
    } catch (err) {
      failures.push({ handle, reason: (err as Error).message ?? String(err) });
    }
  }

  if (failures.length) {
    const summary = failures
      .map((f) => `  - ${f.handle}: ${f.reason}`)
      .join('\n');
    throw new Error(
      `TRIGGER_WATCHLIST could not be resolved (${failures.length} entr${failures.length === 1 ? 'y' : 'ies'}):\n${summary}`,
    );
  }

  // Dedup while preserving order.
  return [...new Set(resolved)];
}

function normaliseDid(did: string): string {
  // DIDs are case-sensitive by spec but the PLC/web methods convention is
  // lowercase. We don't lowercase the method-specific id because that would
  // break did:web. Only the prefix is folded.
  if (did.startsWith('did:plc:')) return 'did:plc:' + did.slice(8).toLowerCase();
  return did;
}

async function resolveHandle(
  handle: string,
  appviewUrl: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const u = new URL('/xrpc/com.atproto.identity.resolveHandle', appviewUrl);
  u.searchParams.set('handle', handle);
  const res = await fetchImpl(u.toString(), {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`resolveHandle HTTP ${res.status}`);
  }
  const body = (await res.json()) as { did?: string };
  return body.did ?? null;
}
