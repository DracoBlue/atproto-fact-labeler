/**
 * CLI: publish the app.kiesel.facts.* lexicon JSON files as
 * `com.atproto.lexicon.schema` records on the labeler's PDS.
 *
 * Idempotent — uses `putRecord` so re-runs after schema edits update in
 * place. rkey is the NSID, matching the atproto spec for Lexicon
 * resolution (DNS TXT → DID → repo record with rkey=NSID).
 *
 * Required env: LABELER_BSKY_SERVICE, LABELER_BSKY_IDENTIFIER,
 *               LABELER_BSKY_APP_PASSWORD.
 *
 *   pnpm lexicons:publish              # publish every lexicon under lexicons/
 *   pnpm lexicons:publish --dry-run    # print what would be written
 *   pnpm lexicons:publish --nsid app.kiesel.facts.claimReview   # one at a time
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfig } from '../config/index.ts';
import { BskyClient } from '../replier/bsky.ts';
import { logger } from '../util/logger.ts';

interface CliArgs {
  dryRun: boolean;
  nsidFilter: string | null;
  lexiconsDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  // Resolve the default lexicons directory relative to this file rather than
  // process.cwd, so the CLI works from any working directory.
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultDir = resolve(here, '..', '..', 'lexicons');
  const args: CliArgs = { dryRun: false, nsidFilter: null, lexiconsDir: defaultDir };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--nsid') args.nsidFilter = argv[++i] ?? null;
    else if (a.startsWith('--nsid=')) args.nsidFilter = a.slice('--nsid='.length);
    else if (a === '--dir') args.lexiconsDir = resolve(argv[++i] ?? defaultDir);
    else if (a.startsWith('--dir=')) args.lexiconsDir = resolve(a.slice('--dir='.length));
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      process.stderr.write(`unknown flag: ${a}\n`);
      printUsage();
      process.exit(1);
    }
  }
  return args;
}

function printUsage(): void {
  process.stderr.write(`Usage: pnpm lexicons:publish [--dry-run] [--nsid <nsid>] [--dir <path>]

Publishes every lexicon JSON file found under --dir as a
com.atproto.lexicon.schema record on the labeler's PDS, with rkey = NSID.

Options:
  --dry-run        Validate + print what would be published. No network writes.
  --nsid <nsid>    Publish only the lexicon with this id (e.g. app.kiesel.facts.claimReview).
  --dir <path>     Lexicons directory (default: <repo-root>/lexicons).
  -h, --help       This message.
`);
}

interface LexiconFile {
  path: string;
  nsid: string;
  body: Record<string, unknown>;
}

/** Walk a directory tree for *.json files. */
function findLexiconFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      throw new Error(`cannot read lexicons dir ${dir}: ${(err as Error).message}`);
    }
    for (const name of entries) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (name.endsWith('.json')) out.push(full);
    }
  }
  out.sort();
  return out;
}

function loadLexicon(path: string): LexiconFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`failed to read ${path}: ${(err as Error).message}`);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
  const id = body.id;
  if (typeof id !== 'string' || !id.includes('.')) {
    throw new Error(`lexicon ${path} missing or invalid "id" field`);
  }
  if (body.lexicon !== 1) {
    throw new Error(`lexicon ${path} must have "lexicon": 1`);
  }
  return { path, nsid: id, body };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getConfig();

  const files = findLexiconFiles(args.lexiconsDir);
  if (files.length === 0) {
    process.stderr.write(`No *.json files found under ${args.lexiconsDir}\n`);
    process.exitCode = 1;
    return;
  }

  const lexicons = files.map(loadLexicon);
  const filtered = args.nsidFilter
    ? lexicons.filter((l) => l.nsid === args.nsidFilter)
    : lexicons;
  if (filtered.length === 0) {
    process.stderr.write(`No lexicon matched --nsid=${args.nsidFilter ?? ''}\n`);
    process.exitCode = 1;
    return;
  }

  process.stderr.write(
    `Found ${filtered.length} lexicon(s) under ${args.lexiconsDir}:\n` +
      filtered.map((l) => `  - ${l.nsid}   ← ${l.path}\n`).join('') +
      '\n',
  );

  if (args.dryRun) {
    process.stderr.write(
      'Dry-run — no records written. To publish, re-run without --dry-run.\n',
    );
    return;
  }

  if (!cfg.LABELER_BSKY_IDENTIFIER || !cfg.LABELER_BSKY_APP_PASSWORD) {
    throw new Error(
      'LABELER_BSKY_IDENTIFIER + LABELER_BSKY_APP_PASSWORD are required to publish.',
    );
  }
  const bsky = new BskyClient({
    serviceUrl: cfg.LABELER_BSKY_SERVICE,
    identifier: cfg.LABELER_BSKY_IDENTIFIER,
    password: cfg.LABELER_BSKY_APP_PASSWORD,
  });
  await bsky.login();

  let ok = 0;
  let failed = 0;
  for (const lex of filtered) {
    try {
      const result = await bsky.putRecord('com.atproto.lexicon.schema', lex.nsid, lex.body);
      logger.info(
        { nsid: lex.nsid, uri: result.uri, cid: result.cid },
        'lexicon published',
      );
      ok++;
    } catch (err) {
      logger.error({ err: (err as Error).message, nsid: lex.nsid }, 'lexicon publish failed');
      failed++;
    }
  }

  process.stderr.write(
    `\n  Published: ${ok}\n  Failed:    ${failed}\n` +
      (failed > 0 ? '\n  Re-run after fixing the errors above.\n' : ''),
  );
  if (failed > 0) process.exitCode = 1;

  if (ok > 0 && failed === 0) {
    process.stderr.write(
      `\n  Don't forget the DNS TXT record so resolvers can find them:\n` +
        `    _lexicon.<your-authority>  IN TXT  "did=${cfg.LABELER_DID}"\n` +
        `  (See https://atproto.com/specs/lexicon#lexicon-publication-and-resolution)\n`,
    );
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'lexicons:publish crashed');
  process.exitCode = 1;
});
