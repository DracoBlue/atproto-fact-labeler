/**
 * Stdin HITL surface — default for local development.
 *
 * Prints each proposal to stderr (so log lines on stdout don't get mixed up) and
 * waits for a single keystroke: a/y to accept, r/n to reject, d to defer, q to
 * quit, anything else = defer.
 *
 * Sequential by design: we don't multiplex. The reviewer goes one at a time.
 */
import { logger } from '../util/logger.ts';
import { renderProposalText } from './format.ts';
import type { DecisionHandler, HitlSurface } from './types.ts';
import type { Proposal } from '../pipeline/orchestrator.ts';

interface Queued {
  proposal: Proposal;
  resolve: () => void;
}

export class StdinHitl implements HitlSurface {
  private queue: Queued[] = [];
  private busy = false;
  private stopped = false;

  constructor(private readonly onDecision: DecisionHandler) {}

  async enqueue(proposal: Proposal): Promise<void> {
    await new Promise<void>((resolve) => {
      this.queue.push({ proposal, resolve });
      this.pump();
    });
  }

  start(signal: AbortSignal): void {
    signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  stop(): void {
    this.stopped = true;
    // Drain anything still queued by resolving (no decision recorded).
    while (this.queue.length) this.queue.shift()?.resolve();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.stopped) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    try {
      const decision = await this.askOnce(next.proposal);
      if (decision !== 'quit') {
        await this.onDecision({
          proposalId: next.proposal.proposalId,
          decision,
          by: 'stdin',
        });
      } else {
        this.stop();
      }
    } catch (err) {
      logger.error({ err }, 'stdin HITL prompt failed');
    } finally {
      next.resolve();
      this.busy = false;
      // Schedule next pump on the next tick to avoid recursive stack growth.
      setImmediate(() => this.pump());
    }
  }

  private askOnce(p: Proposal): Promise<'accept' | 'reject' | 'defer' | 'quit'> {
    process.stderr.write('\n' + renderProposalText(p) + '\n');
    process.stderr.write('[a]ccept / [r]eject / [d]efer / [q]uit: ');

    return new Promise((resolve) => {
      const onData = (chunk: Buffer) => {
        const key = chunk.toString().trim().toLowerCase();
        process.stdin.off('data', onData);
        process.stderr.write('\n');
        if (key === 'a' || key === 'y') return resolve('accept');
        if (key === 'r' || key === 'n') return resolve('reject');
        if (key === 'q') return resolve('quit');
        return resolve('defer');
      };
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', onData);
    });
  }
}
