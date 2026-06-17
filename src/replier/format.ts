/**
 * Build the human-readable text body of a mention-reply.
 *
 * Three reply kinds:
 *   * verdict   — accepted proposal: "<verdict label>. Sources: …. Details: <url>."
 *   * no-claim  — extraction returned no falsifiable claim.
 *   * no-match  — claim extracted but no ClaimReview match found.
 *
 * Constraints:
 *  - Bluesky posts are limited to 300 graphemes; we use a 280-char safe cap.
 *  - Plain text only; no facets — URLs render as plain text in most clients.
 *  - Output language is BCP-47 driven (see src/replier/i18n.ts).
 */
import { type Lang, t, translateVerdict } from './i18n.ts';

export interface VerdictReplyInput {
  verdict: string;
  publishers: string[];
  /**
   * Our own detail page for this post — shows the full evidence and
   * normalised rating. Used as the link when no primary source URL is
   * available or when the verdict is `disputed`.
   */
  detailUrl: string;
  /**
   * URL of the top-ranked publisher's original fact-check article. When set
   * and the verdict is not `disputed`, this is the link the reply points
   * at — one click closer to the underlying journalism. For `disputed`
   * we fall back to `detailUrl` so the user sees all conflicting sources.
   */
  primarySourceUrl?: string;
  /** BCP-47 of the source post; falls back to `defaultLang`. */
  lang?: string;
  /** Configured default; defaults to English. */
  defaultLang?: Lang;
}

export interface DiagnosticReplyInput {
  lang?: string;
  defaultLang?: Lang;
}

const MAX_LEN = 280;

export function buildReplyText(input: VerdictReplyInput): string {
  const fallback = input.defaultLang ?? 'en';
  const verdictWord = translateVerdict(input.verdict, input.lang, fallback);
  const verdictLabel = t(input.lang, 'verdict_label', fallback);
  const sourcesLabel = t(input.lang, 'sources_label', fallback);
  const detailsLabel = t(input.lang, 'details_label', fallback);

  const publishers = dedupe(input.publishers).filter(Boolean);
  // Prefer the publisher's original article unless the verdict is `disputed`,
  // in which case the detail page is more honest because it surfaces every
  // conflicting source rather than anchoring on one.
  const preferSource = !!input.primarySourceUrl && input.verdict !== 'disputed';
  const linkUrl = preferSource ? input.primarySourceUrl! : input.detailUrl;
  const link = ` ${detailsLabel}: ${linkUrl}`;
  const head = `${verdictLabel}: ${verdictWord}.`;

  const buildWith = (n: number): string => {
    const src =
      n === 0 || publishers.length === 0
        ? ''
        : ` ${sourcesLabel}: ${publishers.slice(0, n).join(', ')}.`;
    return `${head}${src}${link}`;
  };

  // Try with as many sources as fit, down to zero.
  for (const n of [3, 2, 1, 0]) {
    const text = buildWith(n);
    if (text.length <= MAX_LEN) return text;
  }
  // Last resort — drop the link too.
  return head;
}

export function buildNoClaimReply(input: DiagnosticReplyInput = {}): string {
  const fallback = input.defaultLang ?? 'en';
  const body = t(input.lang, 'no_claim', fallback);
  return clamp(body);
}

export function buildNoMatchReply(input: DiagnosticReplyInput = {}): string {
  const fallback = input.defaultLang ?? 'en';
  const body = t(input.lang, 'no_match', fallback);
  return clamp(body);
}

export function buildNoTargetReply(input: DiagnosticReplyInput = {}): string {
  const fallback = input.defaultLang ?? 'en';
  const body = t(input.lang, 'no_target', fallback);
  return clamp(body);
}

function clamp(s: string): string {
  return s.length <= MAX_LEN ? s : s.slice(0, MAX_LEN - 1) + '…';
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
