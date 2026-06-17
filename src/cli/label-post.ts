/**
 * pnpm cli:label <at-uri> [--reply] [--dry-run]
 *
 * One-shot labeling of a single post — no Jetstream, no HTTP server, no HITL.
 * Fetches the post via the public AppView, runs the pipeline, auto-accepts
 * the best proposal (operator IS the human review here), emits the label, and
 * optionally posts a Bluesky reply to the post.
 *
 * Use when you want to manually label one post without standing up the
 * full service.
 */
import { getConfig } from '../config/index.ts';
import { getDb, getDbAsync, closeDb } from '../store/db.ts';
import { logger } from '../util/logger.ts';
import { AppViewClient } from '../ingest/appview.ts';
import { processPost } from '../pipeline/orchestrator.ts';
import { createLabelerServer } from '../labels/server.ts';
import { verdictToLabel } from '../labels/vocabulary.ts';
import { BskyClient } from '../replier/bsky.ts';
import { buildReplyText } from '../replier/format.ts';

interface CliArgs {
  rawTarget: string;
  reply: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs | null {
  let rawTarget = '';
  let reply = false;
  let dryRun = false;
  for (const a of argv) {
    if (a === '--reply') reply = true;
    else if (a === '--dry-run' || a === '-n') dryRun = true;
    else if (a === '-h' || a === '--help') return null;
    else if (!a.startsWith('--') && !rawTarget) rawTarget = a;
    else if (a.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${a}\n`);
      return null;
    }
  }
  if (!rawTarget) return null;
  return { rawTarget, reply, dryRun };
}

/**
 * Normalise a user-supplied post reference into an `at://` URI:
 *   - already-at://       → returned as-is
 *   - bsky.app URLs       → resolve handle to DID via AppView
 *   - direct DID + rkey   → returned as-is
 *
 * Returns null when the input doesn't match a known shape.
 */
async function resolveToAtUri(
  raw: string,
  appviewBaseUrl: string,
): Promise<string | null> {
  if (raw.startsWith('at://')) return raw;

  // https://bsky.app/profile/<handle-or-did>/post/<rkey>
  // also accepts staging.bsky.app and any *.bsky.app subdomain
  const bskyMatch = raw.match(
    /^https?:\/\/[^/]*bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/i,
  );
  if (bskyMatch) {
    const actor = decodeURIComponent(bskyMatch[1]!);
    const rkey = bskyMatch[2]!;
    const did = actor.startsWith('did:')
      ? actor
      : await resolveHandle(actor, appviewBaseUrl);
    if (!did) return null;
    return `at://${did}/app.bsky.feed.post/${rkey}`;
  }

  return null;
}

async function resolveHandle(handle: string, appviewBaseUrl: string): Promise<string | null> {
  const u = new URL('/xrpc/com.atproto.identity.resolveHandle', appviewBaseUrl);
  u.searchParams.set('handle', handle);
  try {
    const res = await fetch(u.toString(), { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { did?: string };
    return body.did ?? null;
  } catch {
    return null;
  }
}

function printUsage(): void {
  process.stderr.write(`Usage: pnpm cli:label <target> [--reply] [--dry-run]

Fetch a single Bluesky post, run the fact-check pipeline, and emit the
resulting label. The operator IS the human review — proposals are
auto-accepted.

Accepted target formats:
  at://did:plc:.../app.bsky.feed.post/3kxabc
  https://bsky.app/profile/<handle>/post/<rkey>
  https://bsky.app/profile/<did>/post/<rkey>

Handles are resolved to DIDs via the public AppView.

Options:
  --reply     Additionally post a Bluesky reply to the post itself with
              the verdict + sources. Requires REPLY_TO_MENTIONS=true and
              the BSKY creds in .env.
  --dry-run   Print what would happen without emitting the label or
              posting the reply.
  -h, --help  This message.

Example:
  pnpm cli:label at://did:plc:alice/app.bsky.feed.post/3kxabc
  pnpm cli:label https://bsky.app/profile/alice.example.org/post/3kxabc --reply
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    printUsage();
    process.exit(args === null ? 1 : 0);
  }

  const cfg = getConfig();
  await getDbAsync();
  const db = getDb();

  const uri = await resolveToAtUri(args.rawTarget, cfg.APPVIEW_URL);
  if (!uri) {
    process.stderr.write(
      `\nCould not parse target "${args.rawTarget}".\n` +
        '  Accepted shapes:\n' +
        '    at://did:plc:.../app.bsky.feed.post/<rkey>\n' +
        '    https://bsky.app/profile/<handle-or-did>/post/<rkey>\n',
    );
    closeDb();
    process.exit(1);
  }
  if (uri !== args.rawTarget) {
    process.stderr.write(`  Resolved → ${uri}\n`);
  }

  // 1. Resolve the post via the AppView.
  const bsky =
    cfg.REPLY_TO_MENTIONS && cfg.LABELER_BSKY_IDENTIFIER && cfg.LABELER_BSKY_APP_PASSWORD
      ? new BskyClient({
          serviceUrl: cfg.LABELER_BSKY_SERVICE,
          identifier: cfg.LABELER_BSKY_IDENTIFIER,
          password: cfg.LABELER_BSKY_APP_PASSWORD,
        })
      : null;
  if (bsky && args.reply) {
    try {
      await bsky.login();
    } catch (err) {
      logger.error({ err }, 'BSKY login failed — --reply will be skipped');
    }
  }

  const appview = new AppViewClient({
    baseUrl: cfg.APPVIEW_URL,
    authedFallback: bsky
      ? { baseUrl: cfg.APPVIEW_AUTHED_URL, getJwt: () => bsky.accessJwt }
      : undefined,
  });

  process.stderr.write(`\n→ Fetching ${uri} ...\n`);
  const post = await appview.getPost(uri);
  if (!post) {
    process.stderr.write('  Could not load the post (404 or transient AppView failure).\n');
    closeDb();
    process.exit(1);
  }
  if (post.did === cfg.LABELER_DID) {
    process.stderr.write('  Refusing to label the labelers own post.\n');
    closeDb();
    process.exit(1);
  }
  process.stderr.write(`  Author : ${post.did}\n`);
  process.stderr.write(`  Text   : ${truncate(post.text, 200)}\n`);

  // 2. Run the pipeline (no triggerContext — it's a manual operator action).
  process.stderr.write('\n→ Running pipeline ...\n');
  const result = await processPost(post, {}, { reason: 'manual-cli' });

  process.stderr.write(
    `  Extracted ${result.extractedClaims} claim(s)` +
      `, ${result.falsifiableClaims} falsifiable` +
      `, ${result.claimsWithMatches} with a ClaimReview match.\n`,
  );

  if (result.proposals.length === 0) {
    process.stderr.write('\n  No labelable proposal — nothing to emit.\n');
    closeDb();
    return;
  }

  // 3. Take the highest-confidence proposal.
  const top = [...result.proposals].sort(
    (a, b) => (b.aggregated?.confidence ?? 0) - (a.aggregated?.confidence ?? 0),
  )[0]!;
  const val = verdictToLabel(top.verdict as Parameters<typeof verdictToLabel>[0]);
  if (!val) {
    process.stderr.write(`  Verdict ${top.verdict} has no label mapping. Skipping.\n`);
    closeDb();
    return;
  }
  process.stderr.write(
    `\n→ Proposal #${top.proposalId}\n` +
      `  Claim   : ${top.claimText}\n` +
      `  Verdict : ${top.verdict}` +
      ` (conf=${top.aggregated?.confidence ?? '?'}, votes=${top.aggregated?.votes ?? '?'})\n` +
      `  Label   : ${val}\n`,
  );
  process.stderr.write('  Sources :\n');
  for (const e of top.evidence.slice(0, 5)) {
    process.stderr.write(`    - ${e.publisher} — ${e.ratingNative ?? '?'}  ${e.sourceUrl}\n`);
  }

  if (args.dryRun) {
    process.stderr.write('\n  Dry-run — no label emitted, no reply posted.\n');
    closeDb();
    return;
  }

  // 4. Emit the label.
  const labeler = createLabelerServer();
  await labeler.start();
  try {
    await labeler.emitLabel({ uri: post.uri, cid: post.cid, val });
    db.prepare(
      `UPDATE claim   SET status = 'accepted' WHERE id = ?`,
    ).run(top.claimId);
    db.prepare(
      `UPDATE verdict SET status = 'accepted' WHERE id = ?`,
    ).run(top.verdictId);
    db.prepare(
      `UPDATE proposal SET decision = 'accept', decided_by = 'cli', decided_at = datetime('now') WHERE id = ?`,
    ).run(top.proposalId);
    db.prepare(
      `INSERT INTO label_emit (post_uri, post_cid, val, cts, verdict_id)
       VALUES (?, ?, ?, datetime('now'), ?)`,
    ).run(post.uri, post.cid, val, top.verdictId);
    process.stderr.write('\n  ✓ Label emitted.\n');

    // 5. Optional Bluesky reply.
    if (args.reply) {
      if (!bsky || !bsky.accessJwt) {
        process.stderr.write('  --reply skipped: no Bluesky session available.\n');
      } else {
        const detailUrl =
          (cfg.LABELER_DETAIL_BASE_URL ?? cfg.LABELER_HOSTNAME).replace(/\/$/, '') +
          `/posts?uri=${encodeURIComponent(post.uri)}`;
        const publishers = [...new Set(top.evidence.map((e) => e.publisher).filter(Boolean))];
        const primarySourceUrl = top.evidence[0]?.sourceUrl;
        const text = buildReplyText({
          verdict: top.verdict,
          publishers,
          detailUrl,
          primarySourceUrl,
          lang: post.lang,
          defaultLang: cfg.LABELER_REPLY_DEFAULT_LANG,
        });
        try {
          const reply = await bsky.postReply({
            text,
            parent: { uri: post.uri, cid: post.cid },
            root: { uri: post.uri, cid: post.cid },
          });
          db.prepare(
            `INSERT INTO mention_reply (proposal_id, reply_kind, reply_uri, reply_cid, replied_to_uri)
             VALUES (?, 'verdict', ?, ?, ?)`,
          ).run(top.proposalId, reply.uri, reply.cid, post.uri);
          process.stderr.write(`  ✓ Reply posted: ${reply.uri}\n`);
        } catch (err) {
          process.stderr.write(`  ✗ Reply failed: ${(err as Error).message ?? err}\n`);
        }
      }
    }
  } finally {
    await labeler.stop();
    closeDb();
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

main().catch((err: unknown) => {
  logger.error({ err }, 'cli:label crashed');
  process.exitCode = 1;
});
