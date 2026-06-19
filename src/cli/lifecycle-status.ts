/**
 * Print operational state of the labeler: how many labels are live on the wire,
 * how many have been retired (negated), and what the next safe step is.
 *
 *   pnpm tsx src/cli/lifecycle-status.ts
 */
import { existsSync } from 'node:fs';

import { getConfig } from '../config/index.ts';
import { getDb, getDbAsync, closeDb } from '../store/db.ts';
import { readLifecycleStats } from '../labels/lifecycle.ts';

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

async function main(): Promise<void> {
  const cfg = getConfig();
  await getDbAsync();
  const db = getDb();
  const stats = readLifecycleStats(db);

  const placeholderDid = cfg.LABELER_DID.includes('placeholder');
  const signingKeyPresent = !!cfg.LABELER_SIGNING_KEY;
  const labelDbPath = cfg.SQLITE_PATH.replace(/\.sqlite$/, '') + '-labels.db';
  const labelDbExists = existsSync(labelDbPath);

  process.stdout.write(`
Labeler lifecycle status
========================

Identity
  service DID         ${cfg.LABELER_DID}${placeholderDid ? '   ⚠ placeholder — not yet registered' : ''}
  signing key         ${signingKeyPresent ? 'present (' + cfg.LABELER_SIGNING_KEY.slice(0, 8) + '…)' : '⚠ missing — will be generated on next start'}
  label DB            ${labelDbExists ? labelDbPath : '⚠ not yet created (' + labelDbPath + ')'}
  public endpoint     ${cfg.LABELER_HOSTNAME}
  internal listen     port ${cfg.LABELER_PORT}

Wire counts
  total emissions     ${fmt(stats.emittedTotal)}
  currently live      ${fmt(stats.liveTotal)}
  currently retired   ${fmt(stats.retiredTotal)}
  last retire at      ${stats.retiredAt ?? '—'}

By label value
${stats.byVal.length === 0 ? '  (no labels emitted yet)\n' : stats.byVal.map((b) => `  ${b.val.padEnd(20)} live=${String(b.live).padStart(5)}   retired=${String(b.retired).padStart(5)}`).join('\n')}

Next steps
${nextSteps(stats.liveTotal, placeholderDid)}
`);

  closeDb();
}

function nextSteps(live: number, placeholder: boolean): string {
  const lines: string[] = [];
  if (placeholder) {
    lines.push('  • Service DID is a placeholder. To go live on Bluesky:');
    lines.push('      pnpm dlx @skyware/labeler setup');
    lines.push('      pnpm dlx @skyware/labeler label add   # declare each fact-* value');
  }
  if (live > 0) {
    lines.push('  • To temporarily pause emissions but keep existing labels visible:');
    lines.push('      stop `pnpm run start` — subscribers stay connected, no new emissions');
    lines.push('  • To retire all live labels (variant C — neg=true companions):');
    lines.push('      pnpm tsx src/cli/retire.ts --dry-run    # preview');
    lines.push('      pnpm tsx src/cli/retire.ts              # apply');
  }
  if (live === 0 && !placeholder) {
    lines.push('  • No live labels. Safe to clear the labeler declaration entirely (variant D):');
    lines.push('      pnpm dlx @skyware/labeler clear');
    lines.push('    This removes #atproto_label and #atproto_labeler from the DID document and');
    lines.push('    deletes the app.bsky.labeler.service record. The account becomes a normal Bsky user.');
  }
  if (live > 0 && !placeholder) {
    lines.push('  • To permanently retire the labeler:');
    lines.push('      1) pnpm tsx src/cli/retire.ts       # negate all live labels first');
    lines.push('      2) pnpm dlx @skyware/labeler clear  # then drop the declaration');
  }
  return lines.length ? lines.join('\n') : '  (no action needed)';
}

main().catch((err: unknown) => {
  process.stderr.write(`lifecycle-status failed: ${(err as Error).message ?? err}\n`);
  process.exitCode = 1;
});
