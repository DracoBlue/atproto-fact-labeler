/**
 * Per-post detail HTTP endpoint.
 *
 * Registered on the same Fastify instance as the @skyware/labeler server so
 * everything is served on a single port (LABELER_PORT).
 *
 * Routes:
 *   GET /posts?uri=<at-uri>           HTML
 *   GET /posts?uri=<at-uri>&format=json   JSON
 *   GET /healthz                       liveness
 *
 * Architecture: when a verdict has been published as a canonical
 * app.kiesel.facts.claimVerdict atproto record (`verdict.atproto_uri`
 * is set), this server fetches that record and renders from it — the
 * same path every other consumer of our labeler uses. Pre-migration
 * verdicts fall back to the legacy SQL join with the local `evidence`
 * table.
 */
import { getConfig } from '../config/index.ts';
import { getDb } from '../store/db.ts';
import { verdictToLabel } from '../labels/vocabulary.ts';
import { logger } from '../util/logger.ts';
import type { LabelerApp } from '../labels/server.ts';

interface Row {
  claim_id: number;
  atomic_text: string;
  decontextualized_text: string;
  verdict_label: string;
  verdict_confidence: number | null;
  verdict_rationale: string | null;
  verified_at: string;
  valid_at: string | null;
  evidence: Array<{
    source_url: string;
    publisher: string;
    rating_native: string | null;
    reviewed_at: string | null;
    attribution: string;
  }>;
}

interface ClaimVerdictRecord {
  $type?: string;
  subject?: { uri?: string; cid?: string };
  claimText?: string;
  decontextualizedText?: string;
  verdict?: string;
  confidence?: number;
  rationale?: string;
  verifiedAt?: string;
  validAt?: string;
  emittedLabel?: string;
  evidence?: Array<{
    polarity?: string;
    intakePath?: string;
    attribution?: string;
    externalSource?: {
      publisherName?: string;
      publisherSite?: string;
      publisherUrl?: string;
      sourceUrl?: string;
      claimReviewed?: string;
      ratingNative?: string;
      reviewDate?: string;
      lang?: string;
    };
    claimReview?: { uri?: string; cid?: string };
  }>;
}

const RECORD_VERDICT_TO_INTERNAL: Record<string, string> = {
  supported: 'true',
  refuted: 'false',
  disputed: 'disputed',
  mixed: 'mixed',
  outdated: 'outdated',
  unknown: 'unknown',
};

async function fetchClaimVerdict(
  pdsBase: string,
  atUri: string,
): Promise<ClaimVerdictRecord | null> {
  // at://<did>/<collection>/<rkey>
  const m = atUri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, did, collection, rkey] = m;
  const url =
    `${pdsBase.replace(/\/$/, '')}/xrpc/com.atproto.repo.getRecord` +
    `?repo=${encodeURIComponent(did!)}` +
    `&collection=${encodeURIComponent(collection!)}` +
    `&rkey=${encodeURIComponent(rkey!)}`;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, atUri },
        'detail: getRecord returned non-2xx for claimVerdict',
      );
      return null;
    }
    const body = (await res.json()) as { value?: ClaimVerdictRecord };
    return body.value ?? null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, atUri }, 'detail: getRecord failed');
    return null;
  }
}

function renderRowFromRecord(
  claimId: number,
  record: ClaimVerdictRecord,
  fallback: { verifiedAt: string | null; validAt: string | null; rationale: string | null },
): Row {
  const internalVerdict = record.verdict
    ? RECORD_VERDICT_TO_INTERNAL[record.verdict] ?? record.verdict
    : 'unknown';
  const label = verdictToLabel(internalVerdict as Parameters<typeof verdictToLabel>[0]) ?? 'fact-unknown';
  const evidence: Row['evidence'] = (record.evidence ?? []).map((e) => {
    const src = e.externalSource ?? {};
    return {
      source_url: src.sourceUrl ?? e.claimReview?.uri ?? '',
      publisher: src.publisherName ?? '',
      rating_native: src.ratingNative ?? null,
      reviewed_at: src.reviewDate ?? null,
      attribution: e.attribution ?? '',
    };
  });
  return {
    claim_id: claimId,
    atomic_text: record.claimText ?? '',
    decontextualized_text: record.decontextualizedText ?? record.claimText ?? '',
    verdict_label: label,
    verdict_confidence: record.confidence ?? null,
    verdict_rationale: record.rationale ?? fallback.rationale,
    verified_at: record.verifiedAt ?? fallback.verifiedAt ?? '',
    valid_at: record.validAt ?? fallback.validAt,
    evidence,
  };
}

async function loadDetail(postUri: string): Promise<{ postText: string | null; claims: Row[] }> {
  const db = getDb();
  const cfg = getConfig();
  const post = db
    .prepare('SELECT text FROM post_cache WHERE uri = ?')
    .get(postUri) as { text: string } | undefined;

  // Public detail view only surfaces verdicts that actually went on-wire:
  // status='accepted' AND retired_at IS NULL. Proposed verdicts are
  // operator-internal; retired verdicts are hidden because they were taken
  // off the wire — exposing them again here would re-publish text we
  // already chose to retract.
  const rows = db
    .prepare(
      `SELECT c.id              AS claim_id,
              c.atomic_text     AS atomic_text,
              c.decontextualized_text,
              v.id              AS verdict_id,
              v.label           AS verdict_label,
              v.confidence      AS verdict_confidence,
              v.rationale       AS verdict_rationale,
              v.verified_at,
              v.valid_at,
              v.atproto_uri     AS atproto_uri
         FROM claim c
         JOIN verdict v ON v.claim_id = c.id
        WHERE c.post_uri = ?
          AND v.status = 'accepted'
          AND v.retired_at IS NULL
        ORDER BY v.id DESC`,
    )
    .all(postUri) as Array<
      Row & { verdict_id: number; atproto_uri: string | null }
    >;

  const evidenceStmt = db.prepare(
    `SELECT source_url, publisher, rating_native, reviewed_at, attribution
       FROM evidence
      WHERE verdict_id = ?
      ORDER BY id`,
  );

  const claims = await Promise.all(
    rows.map(async (r): Promise<Row> => {
      // Canonical path: verdict is published as an atproto record. Fetch it
      // and render from there — same data path every other consumer of our
      // labeler uses.
      if (r.atproto_uri) {
        const record = await fetchClaimVerdict(cfg.LABELER_BSKY_SERVICE, r.atproto_uri);
        if (record) {
          return renderRowFromRecord(r.claim_id, record, {
            verifiedAt: r.verified_at,
            validAt: r.valid_at,
            rationale: r.verdict_rationale,
          });
        }
        logger.warn(
          { atUri: r.atproto_uri, claimId: r.claim_id },
          'detail: atproto fetch failed, falling back to legacy SQL render',
        );
      }
      // Legacy fallback: read the evidence rows from SQLite. Used for
      // pre-migration verdicts and as a degradation path if the PDS is
      // momentarily unreachable.
      const evidence = evidenceStmt.all(r.verdict_id) as Row['evidence'];
      return {
        claim_id: r.claim_id,
        atomic_text: r.atomic_text,
        decontextualized_text: r.decontextualized_text,
        verdict_label: r.verdict_label,
        verdict_confidence: r.verdict_confidence,
        verdict_rationale: r.verdict_rationale,
        verified_at: r.verified_at,
        valid_at: r.valid_at,
        evidence,
      };
    }),
  );

  return { postText: post?.text ?? null, claims };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const REPO_URL = 'https://github.com/DracoBlue/atproto-fact-labeler';
const PLACEHOLDER_DID_PREFIX = 'did:plc:placeholder';

/**
 * Resolve where `GET /` should redirect to. Exported for tests.
 *
 *   - `override` is the raw `LABELER_ROOT_REDIRECT` env value.
 *     `undefined` means the operator didn't set it; the empty string
 *     means they explicitly set it to disable the redirect.
 *   - `did` is `LABELER_DID`. When it's still the placeholder we fall
 *     back to the repo URL so the route always lands somewhere useful.
 *
 * Returns `null` when the route should not be registered at all.
 */
export function resolveRootRedirect(
  override: string | undefined,
  did: string,
): string | null {
  if (override === '') return null;          // explicit disable
  if (override !== undefined) return override; // explicit override
  if (did && !did.startsWith(PLACEHOLDER_DID_PREFIX)) {
    return `https://bsky.app/profile/${did}`;
  }
  return REPO_URL;
}

// Only http(s) URLs land in `href`. Anything else (`javascript:`, `data:`,
// `vbscript:`, scheme-relative, …) is rendered as plain text. The detail page
// echoes URLs from the Google Data Commons Fact Check feed, which has
// historically included XSS payloads in publisher fields; treating any
// non-http(s) URL as opaque text is the cheapest defence.
function isSafeHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function renderHtml(postUri: string, postText: string | null, claims: Row[]): string {
  const claimsHtml = claims
    .map((c) => {
      const evHtml = c.evidence
        .map(
          (e) => `
        <li>
          <strong>${escapeHtml(e.publisher)}</strong>
          ${e.rating_native ? `— <em>${escapeHtml(e.rating_native)}</em>` : ''}
          ${e.reviewed_at ? `<span class="date">(${escapeHtml(e.reviewed_at)})</span>` : ''}
          <br>
          ${
            isSafeHttpUrl(e.source_url)
              ? `<a href="${escapeHtml(e.source_url)}" rel="noopener nofollow" target="_blank">${escapeHtml(e.source_url)}</a>`
              : `<span class="unsafe-url" title="non-http(s) URL — rendered as text">${escapeHtml(e.source_url)}</span>`
          }
          <div class="attribution">${escapeHtml(e.attribution)}</div>
        </li>`,
        )
        .join('');
      return `
      <section class="claim">
        <h2>${escapeHtml(c.atomic_text)}</h2>
        <div class="verdict">Verdict: <span class="v-${escapeHtml(c.verdict_label)}">${escapeHtml(c.verdict_label)}</span>
          ${c.verdict_confidence ? `<span class="confidence">conf=${c.verdict_confidence}</span>` : ''}
        </div>
        ${c.verdict_rationale ? `<p class="rationale">${escapeHtml(c.verdict_rationale)}</p>` : ''}
        <h3>Sources</h3>
        <ul>${evHtml}</ul>
      </section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<title>Fact-check detail · ${escapeHtml(postUri)}</title>
<style>
 body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 760px; margin: 2em auto; padding: 0 1em; color: #111; }
 a { color: #0066c0; }
 .post { background: #f7f7f7; padding: 1em; border-radius: 8px; }
 .claim { margin-top: 2em; border-top: 1px solid #ddd; padding-top: 1.5em; }
 .verdict { font-weight: 600; margin: 0.5em 0; }
 .v-fact-refuted   { color: #b00020; }
 .v-fact-supported { color: #1a7a2a; }
 .v-fact-disputed  { color: #b76700; }
 .v-fact-outdated  { color: #555; }
 .v-fact-unknown   { color: #555; }
 .v-fact-mixed     { color: #b76700; }
 .confidence { color: #555; font-weight: normal; margin-left: .5em; }
 .rationale  { color: #444; }
 .date       { color: #777; font-size: 90%; }
 .attribution { font-size: 80%; color: #666; margin: .25em 0 1em 0; }
 footer { margin-top: 4em; color: #888; font-size: 90%; }
</style>
</head>
<body>
<header>
  <p><small>Fact-check detail for an atproto post.</small></p>
  <h1 style="font-size: 1.1em; color: #555;">${escapeHtml(postUri)}</h1>
  ${postText ? `<div class="post">${escapeHtml(postText)}</div>` : '<p><em>Post text not cached locally.</em></p>'}
</header>
${claims.length ? claimsHtml : '<p><em>No fact-check entries match this post (yet).</em></p>'}
<footer>
  <p>This labeler does not decide what is true. It surfaces verdicts that
     independent fact-checkers have already published, matches them against the
     post, and shows you the evidence. Click each source above for the original
     article — per-entry text remains under the publisher's own copyright; the
     attribution line under each source names the publisher and how we obtained
     the entry.</p>
  <p>Sources may come from the Google Data Commons Fact Check bulk feed
     (CC BY 4.0 compilation), the Google Fact Check Tools API, or fact-checks
     the labeler operator hosts directly. Each entry's <em>attribution</em>
     line above states which path it came from.</p>
  <p>Who counts as a fact-checker, how the list is curated, and how to
     report a bad entry —
     <a href="https://github.com/DracoBlue/atproto-fact-labeler/blob/main/docs/FEED_QUALITY.md"
        rel="noopener" target="_blank">docs/FEED_QUALITY.md</a>.
     Full project documentation —
     <a href="https://github.com/DracoBlue/atproto-fact-labeler"
        rel="noopener" target="_blank">github.com/DracoBlue/atproto-fact-labeler</a>.</p>
</footer>
</body>
</html>`;
}

export function registerDetailRoutes(app: LabelerApp): void {
  app.get('/healthz', async () => ({ ok: true }));

  // `GET /` has no useful payload to return — the labeler's surfaces are
  // /posts, /healthz, /robots.txt, and the xrpc endpoints. Send anyone who
  // lands on the root somewhere informative.
  //
  // Resolution: explicit env override > derived from LABELER_DID > project
  // repo as a last-resort. An *explicitly* empty `LABELER_ROOT_REDIRECT`
  // (the string `""`) disables the route entirely so the root returns 404.
  const cfg = getConfig();
  const rootRedirect = resolveRootRedirect(cfg.LABELER_ROOT_REDIRECT, cfg.LABELER_DID);
  if (rootRedirect) {
    app.get('/', async (_req, reply) => {
      // 302 (Found) — the redirect target may change per deployment and
      // shouldn't be cached by intermediaries.
      reply.header('x-robots-tag', 'noindex, nofollow');
      reply.redirect(rootRedirect, 302);
    });
  }

  // Block every crawler at the document level. The detail pages quote
  // attacker-controlled URLs (from posts being labeled and from third-party
  // fact-check sources) — even as plain text these can drag the host's
  // reputation in Search. We don't want this host in any index.
  app.get('/robots.txt', async (_req, reply) => {
    reply.header('content-type', 'text/plain; charset=utf-8');
    reply.header('x-robots-tag', 'noindex, nofollow');
    return 'User-agent: *\nDisallow: /\n';
  });

  app.get<{ Querystring: { uri?: string; format?: string } }>(
    '/posts',
    async (req, reply) => {
      // Belt and suspenders alongside the <meta name="robots"> tag in the HTML
      // — the header reaches non-HTML formats (JSON) and is harder to strip
      // by intermediate proxies.
      reply.header('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet');
      const uri = req.query.uri ?? '';
      if (!uri || !uri.startsWith('at://')) {
        reply.code(400);
        return { error: 'missing or invalid uri (must start with at://)' };
      }
      const data = await loadDetail(uri);
      const wantsJson =
        req.query.format === 'json' || (req.headers.accept ?? '').includes('application/json');
      if (wantsJson) {
        reply.header('content-type', 'application/json; charset=utf-8');
        return { uri, ...data };
      }
      reply.header('content-type', 'text/html; charset=utf-8');
      return renderHtml(uri, data.postText, data.claims);
    },
  );
}
