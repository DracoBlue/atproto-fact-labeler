import type { Proposal } from '../pipeline/orchestrator.ts';

/** Human-readable, terminal-friendly summary of a proposal. */
export function renderProposalText(p: Proposal): string {
  const lines: string[] = [];
  lines.push(`── Proposal #${p.proposalId} ─────────────────────────────────────`);
  lines.push(`Post:  ${p.postUri}`);
  lines.push(`Text:  ${truncate(p.postText, 240)}`);
  lines.push('');
  lines.push(`Claim:        ${p.claimText}`);
  if (p.decontextualized && p.decontextualized !== p.claimText) {
    lines.push(`Standalone:   ${p.decontextualized}`);
  }
  lines.push(`Verdict:      ${p.verdict}  (confidence=${p.aggregated?.confidence ?? 0}, votes=${p.aggregated?.votes ?? 0}, agreement=${p.aggregated?.agreement ?? 0})`);
  lines.push('');
  lines.push('Evidence:');
  p.evidence.slice(0, 5).forEach((e, i) => {
    const flip = e.publisherVerdict !== e.effectiveVerdict
      ? ` → flipped to ${e.effectiveVerdict}`
      : '';
    lines.push(
      `  ${i + 1}. [${e.nliLabel} ${e.nliConfidence.toFixed(2)}, cos=${e.cosine.toFixed(2)}] ${e.publisher} — "${truncate(e.ratingNative ?? '?', 40)}"${flip}`,
    );
    lines.push(`     P: ${truncate(e.claimReviewed, 120)}`);
    lines.push(`     ${e.sourceUrl}`);
  });
  lines.push('');
  return lines.join('\n');
}

/** Telegram MarkdownV2-friendly version. */
export function renderProposalMarkdown(p: Proposal): string {
  const escape = (s: string) => s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
  const lines: string[] = [];
  lines.push(`*Proposal #${p.proposalId}*`);
  lines.push(`Post: \`${escape(p.postUri)}\``);
  lines.push(`Text: ${escape(truncate(p.postText, 240))}`);
  lines.push('');
  lines.push(`*Claim:* ${escape(p.claimText)}`);
  lines.push(`*Verdict:* \`${escape(p.verdict)}\``);
  lines.push(`(confidence=${escape(String(p.aggregated?.confidence ?? 0))}, ` +
    `votes=${escape(String(p.aggregated?.votes ?? 0))})`);
  lines.push('');
  lines.push('*Evidence:*');
  p.evidence.slice(0, 5).forEach((e, i) => {
    lines.push(
      `${i + 1}\\. ${escape(e.publisher)} — _${escape(truncate(e.ratingNative ?? '?', 40))}_`,
    );
    lines.push(`  ${escape(e.sourceUrl)}`);
  });
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
