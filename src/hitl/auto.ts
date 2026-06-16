/**
 * Auto-accept HITL surface. Decides immediately without human input — useful
 * for non-interactive smoke tests and (with a tight policy) for production
 * shadow-mode runs that emit labels at low rates.
 *
 * Policy: accept iff aggregated confidence >= threshold AND votes >= minVotes.
 * Otherwise defer.
 */
import { logger } from '../util/logger.ts';
import type { DecisionHandler, HitlSurface } from './types.ts';
import type { Proposal } from '../pipeline/orchestrator.ts';

export interface AutoPolicy {
  minConfidence: number;
  minVotes: number;
}

export class AutoHitl implements HitlSurface {
  constructor(
    private readonly onDecision: DecisionHandler,
    private readonly policy: AutoPolicy = { minConfidence: 0.8, minVotes: 1 },
  ) {}

  async enqueue(proposal: Proposal): Promise<void> {
    const conf = proposal.aggregated?.confidence ?? 0;
    const votes = proposal.aggregated?.votes ?? 0;
    const ok = conf >= this.policy.minConfidence && votes >= this.policy.minVotes;
    const decision = ok ? 'accept' : 'defer';
    logger.info(
      { proposalId: proposal.proposalId, decision, conf, votes, verdict: proposal.verdict },
      'auto HITL decision',
    );
    await this.onDecision({ proposalId: proposal.proposalId, decision, by: 'auto' });
  }
}
