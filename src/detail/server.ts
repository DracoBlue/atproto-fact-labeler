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
 */
import { getDb } from '../store/db.ts';
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

function loadDetail(postUri: string): { postText: string | null; claims: Row[] } {
  const db = getDb();
  const post = db
    .prepare('SELECT text FROM post_cache WHERE uri = ?')
    .get(postUri) as { text: string } | undefined;

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
              v.valid_at
         FROM claim c
         JOIN verdict v ON v.claim_id = c.id
        WHERE c.post_uri = ?
          AND v.status IN ('proposed','accepted')
          AND v.retired_at IS NULL
        ORDER BY v.id DESC`,
    )
    .all(postUri) as Array<Row & { verdict_id: number }>;

  const evidenceStmt = db.prepare(
    `SELECT source_url, publisher, rating_native, reviewed_at, attribution
       FROM evidence
      WHERE verdict_id = ?
      ORDER BY id`,
  );

  const claims = rows.map((r) => {
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
  });

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
  <p>This labeler does not decide what is true. It surfaces the verdicts that
     third-party fact-checkers (CORRECTIV, dpa, AFP, Snopes, PolitiFact, ...)
     have already published. Click each source above for the original article.</p>
  <p>Compiled via Google Data Commons Fact Check feed (CC BY 4.0).
     Per-entry text remains under the publisher's own copyright.</p>
</footer>
</body>
</html>`;
}

export function registerDetailRoutes(app: LabelerApp): void {
  app.get('/healthz', async () => ({ ok: true }));

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
      const data = loadDetail(uri);
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
