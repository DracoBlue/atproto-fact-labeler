/**
 * Hybrid HITL surface.
 *
 * - High-confidence proposals (≥ minConfidence AND ≥ minVotes) auto-accept
 *   without operator interaction — same path as plain `auto`.
 * - Anything below the bar is forwarded to the Telegram surface for an
 *   accept/reject/defer button press.
 *
 * Operator gets the unattended throughput of auto with the safety net of
 * Telegram review on the uncertain cases.
 */
import { logger } from '../util/logger.ts';
import { TelegramHitl } from './telegram.ts';
import type { AutoPolicy } from './auto.ts';
import type { DecisionHandler, HitlSurface } from './types.ts';
import type { Proposal } from '../pipeline/orchestrator.ts';

export class AutoTelegramHitl implements HitlSurface {
  private readonly telegram: TelegramHitl;

  constructor(
    private readonly onDecision: DecisionHandler,
    private readonly policy: AutoPolicy = { minConfidence: 0.8, minVotes: 1 },
  ) {
    this.telegram = new TelegramHitl(onDecision);
  }

  async enqueue(proposal: Proposal): Promise<void> {
    const conf = proposal.aggregated?.confidence ?? 0;
    const votes = proposal.aggregated?.votes ?? 0;
    const aboveBar = conf >= this.policy.minConfidence && votes >= this.policy.minVotes;
    if (aboveBar) {
      logger.info(
        { proposalId: proposal.proposalId, decision: 'accept', conf, votes, verdict: proposal.verdict },
        'auto-telegram HITL: auto-accept',
      );
      await this.onDecision({ proposalId: proposal.proposalId, decision: 'accept', by: 'auto' });
      return;
    }
    logger.info(
      { proposalId: proposal.proposalId, conf, votes, verdict: proposal.verdict },
      'auto-telegram HITL: forwarding to Telegram for manual review',
    );
    await this.telegram.enqueue(proposal);
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.telegram.start(signal);
  }

  async stop(): Promise<void> {
    await this.telegram.stop();
  }
}
