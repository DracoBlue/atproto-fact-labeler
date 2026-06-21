/**
 * CLI: declare the labeler's six `fact-*` label values on Bluesky.
 *
 * Writes (or updates) the `app.bsky.labeler.service` record on the labeler
 * account's PDS with the contents of `config/labels.json`. This is what
 * makes the labels appear in Bluesky moderation settings and lets users
 * pick per-label visibility (inform / warn / hide).
 *
 * Idempotent — uses `putRecord` at rkey=`self`, so re-running after a
 * `config/labels.json` edit overwrites in place.
 *
 * Replaces `pnpm dlx @skyware/labeler label edit`, which opens a text
 * editor and asks you to paste the same array. This CLI reads the file
 * directly. The DID-document update (`@skyware/labeler setup`) is the
 * separate one-off and still done via skyware.
 *
 *   pnpm labeler:declare              # write the record
 *   pnpm labeler:declare --dry-run    # validate + print, no network write
 *   pnpm labeler:declare --file PATH  # use a different labels JSON
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfig } from '../config/index.ts';
import { BskyClient } from '../replier/bsky.ts';
import { logger } from '../util/logger.ts';

interface CliArgs {
  dryRun: boolean;
  file: string;
}

const LABELER_SERVICE_NSID = 'app.bsky.labeler.service';
const LABELER_SERVICE_RKEY = 'self';

interface LabelValueDefinition {
  identifier: string;
  severity: 'inform' | 'alert' | 'none';
  blurs: 'content' | 'media' | 'none';
  defaultSetting?: 'ignore' | 'inform' | 'warn' | 'hide';
  adultOnly?: boolean;
  locales: Array<{ lang: string; name: string; description: string }>;
}

function parseArgs(argv: string[]): CliArgs {
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultFile = resolve(here, '..', '..', 'config', 'labels.json');
  const args: CliArgs = { dryRun: false, file: defaultFile };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--file') args.file = resolve(argv[++i] ?? defaultFile);
    else if (a.startsWith('--file=')) args.file = resolve(a.slice('--file='.length));
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
  process.stderr.write(`Usage: pnpm labeler:declare [--dry-run] [--file <path>]

Writes the labeler's six fact-* label values to the labeler account's
app.bsky.labeler.service record (rkey=self) on its PDS. Idempotent.

Options:
  --dry-run        Validate + print the record body. No network write.
  --file <path>    Path to the labels JSON array (default: config/labels.json).
  -h, --help       This message.

Required env:
  LABELER_BSKY_SERVICE
  LABELER_BSKY_IDENTIFIER
  LABELER_BSKY_APP_PASSWORD
`);
}

function loadLabels(path: string): LabelValueDefinition[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`failed to read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON array of label-value definitions`);
  }
  for (const [i, item] of parsed.entries()) {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`${path}[${i}] is not an object`);
    }
    const o = item as Record<string, unknown>;
    if (typeof o.identifier !== 'string' || !o.identifier) {
      throw new Error(`${path}[${i}] missing string identifier`);
    }
    if (typeof o.severity !== 'string') {
      throw new Error(`${path}[${i}] missing severity`);
    }
    if (!Array.isArray(o.locales) || o.locales.length === 0) {
      throw new Error(`${path}[${i}] needs at least one locale (en)`);
    }
  }
  return parsed as LabelValueDefinition[];
}

function buildServiceRecord(
  labels: LabelValueDefinition[],
): Record<string, unknown> {
  return {
    $type: LABELER_SERVICE_NSID,
    createdAt: new Date().toISOString(),
    policies: {
      labelValues: labels.map((l) => l.identifier),
      labelValueDefinitions: labels,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getConfig();

  const labels = loadLabels(args.file);
  const record = buildServiceRecord(labels);

  process.stderr.write(
    `Found ${labels.length} label(s) in ${args.file}:\n` +
      labels
        .map((l) => `  - ${l.identifier}   severity=${l.severity}   blurs=${l.blurs}\n`)
        .join('') +
      '\n',
  );

  if (args.dryRun) {
    process.stderr.write('Dry-run — record body that *would* be written:\n');
    process.stdout.write(JSON.stringify(record, null, 2));
    process.stdout.write('\n');
    return;
  }

  if (!cfg.LABELER_BSKY_IDENTIFIER || !cfg.LABELER_BSKY_APP_PASSWORD) {
    throw new Error(
      'LABELER_BSKY_IDENTIFIER + LABELER_BSKY_APP_PASSWORD are required.',
    );
  }
  const bsky = new BskyClient({
    serviceUrl: cfg.LABELER_BSKY_SERVICE,
    identifier: cfg.LABELER_BSKY_IDENTIFIER,
    password: cfg.LABELER_BSKY_APP_PASSWORD,
  });
  await bsky.login();

  const result = await bsky.putRecord(LABELER_SERVICE_NSID, LABELER_SERVICE_RKEY, record);

  logger.info(
    { uri: result.uri, cid: result.cid, labels: labels.length },
    'labeler service record declared',
  );
  process.stderr.write(
    `\n  ✓ Declared ${labels.length} label values\n` +
      `    Record: ${result.uri}\n` +
      `    CID:    ${result.cid}\n` +
      `\n  Bluesky moderation settings will pick up the new values on\n` +
      `  next AppView refresh (usually within a minute).\n`,
  );
}

main().catch((err: unknown) => {
  logger.error({ err }, 'labeler:declare crashed');
  process.exitCode = 1;
});
