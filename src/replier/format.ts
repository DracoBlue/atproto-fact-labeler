/**
 * Build the human-readable text body of a mention-reply.
 *
 * Constraints:
 *  - Bluesky posts are limited to 300 graphemes (we use a 280-char safe cap).
 *  - Plain text only; no facets — links are not auto-linkified but render as
 *    plain text URLs which clients still surface in most cases.
 */
import type { Verdict } from '../pipeline/normalise-rating.ts';

export interface ReplyInput {
  verdict: Verdict | string;
  publishers: string[];
  detailUrl: string;
}

const VERDICT_PHRASE: Record<string, string> = {
  true: 'Verdict: supported',
  false: 'Verdict: refuted',
  mixed: 'Verdict: mixed',
  disputed: 'Verdict: disputed',
  outdated: 'Verdict: outdated',
  unknown: 'Verdict: not enough information',
};

const MAX_LEN = 280;

export function buildReplyText(input: ReplyInput): string {
  const phrase = VERDICT_PHRASE[input.verdict] ?? `Verdict: ${input.verdict}`;
  const publishers = dedupe(input.publishers).filter(Boolean);

  const sources =
    publishers.length === 0
      ? ''
      : ` Sources: ${publishers.slice(0, 3).join(', ')}.`;
  const link = ` Details: ${input.detailUrl}`;

  let text = `${phrase}.${sources}${link}`;
  if (text.length > MAX_LEN) {
    const room = MAX_LEN - `${phrase}.${link}`.length;
    const shorterSources =
      publishers.slice(0, 1).join(', ').length + 11 /* " Sources: ." */ <= room
        ? ` Sources: ${publishers[0]}.`
        : '';
    text = `${phrase}.${shorterSources}${link}`;
  }
  if (text.length > MAX_LEN) {
    // Last resort — drop the link, keep verdict.
    text = `${phrase}.`;
  }
  return text;
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
