/**
 * Map our internal verdict vocabulary to the labels we emit on the wire.
 *
 * Label values follow the kebab-case constraint from the atproto label spec
 * (see docs/ARCHITECTURE.md §1: ≤ 128 bytes, `[a-z]` + internal dashes).
 */
import type { Verdict } from '../pipeline/normalise-rating.ts';

export const FACT_LABEL_VALUES = [
  'fact-supported',
  'fact-refuted',
  'fact-disputed',
  'fact-unknown',
  'fact-outdated',
  'fact-mixed',
] as const;

export type FactLabelValue = (typeof FACT_LABEL_VALUES)[number];

const MAP: Record<Verdict, FactLabelValue | null> = {
  true: 'fact-supported',
  false: 'fact-refuted',
  mixed: 'fact-mixed',
  disputed: 'fact-disputed',
  outdated: 'fact-outdated',
  unknown: 'fact-unknown',
};

export function verdictToLabel(verdict: Verdict): FactLabelValue | null {
  return MAP[verdict];
}

/** Verify that all defined labels match the spec regex (test-friendly). */
const LABEL_REGEX = /^[a-z](?:[a-z-]*[a-z])?$/;
export function isSpecCompliantLabel(val: string): boolean {
  return val.length <= 128 && LABEL_REGEX.test(val);
}
