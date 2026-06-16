import type { Proposal } from '../pipeline/orchestrator.ts';

export type Decision = 'accept' | 'reject' | 'defer';

export interface HitlDecision {
  proposalId: number;
  decision: Decision;
  by: string;
}

export type DecisionHandler = (decision: HitlDecision) => Promise<void> | void;

export interface HitlSurface {
  /** Push a proposal into the HITL queue. */
  enqueue(proposal: Proposal): Promise<void> | void;
  /** Optional: start a long-lived loop (e.g. polling Telegram). */
  start?(signal: AbortSignal): Promise<void> | void;
  /** Optional: graceful shutdown. */
  stop?(): Promise<void> | void;
}
