/**
 * Telegram HITL surface (opt-in). Activates when TG_BOT_TOKEN is set.
 *
 * Posts each proposal as a MarkdownV2 message with inline keyboard buttons.
 * The callback handler maps the inline-button presses to accept/reject/defer.
 *
 * Allowlist: only TG_REVIEWER_CHAT_ID may interact; everyone else is ignored.
 */
import { Bot, InlineKeyboard, type Context } from 'grammy';

import { getConfig } from '../config/index.ts';
import { logger } from '../util/logger.ts';
import { renderProposalMarkdown } from './format.ts';
import type { DecisionHandler, HitlSurface } from './types.ts';
import type { Proposal } from '../pipeline/orchestrator.ts';

export class TelegramHitl implements HitlSurface {
  private readonly bot: Bot;
  private readonly chatId: number;
  private started = false;

  constructor(private readonly onDecision: DecisionHandler) {
    const cfg = getConfig();
    if (!cfg.TG_BOT_TOKEN) {
      throw new Error('TG_BOT_TOKEN is required for telegram HITL mode');
    }
    if (!cfg.TG_REVIEWER_CHAT_ID) {
      throw new Error('TG_REVIEWER_CHAT_ID is required for telegram HITL mode');
    }
    this.bot = new Bot(cfg.TG_BOT_TOKEN);
    this.chatId = Number(cfg.TG_REVIEWER_CHAT_ID);
    this.wireHandlers();
  }

  private wireHandlers(): void {
    this.bot.on('callback_query:data', async (ctx: Context) => {
      if (!ctx.callbackQuery || !ctx.callbackQuery.data) return;
      if (ctx.from?.id !== this.chatId && ctx.chat?.id !== this.chatId) {
        await ctx.answerCallbackQuery({ text: 'Not allowed.' });
        return;
      }
      const [verb, proposalIdRaw] = ctx.callbackQuery.data.split(':');
      const proposalId = Number(proposalIdRaw);
      if (!Number.isFinite(proposalId) || !verb) return;

      if (verb === 'a' || verb === 'r' || verb === 'd') {
        const decision = verb === 'a' ? 'accept' : verb === 'r' ? 'reject' : 'defer';
        await this.onDecision({ proposalId, decision, by: `tg:${ctx.from?.id ?? '?'}` });
        await ctx.answerCallbackQuery({ text: `Marked ${decision}.` });
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        } catch {
          /* old message, ignore */
        }
      }
    });
  }

  async enqueue(proposal: Proposal): Promise<void> {
    const kb = new InlineKeyboard()
      .text('✅ Accept', `a:${proposal.proposalId}`)
      .text('❌ Reject', `r:${proposal.proposalId}`)
      .text('↻ Defer', `d:${proposal.proposalId}`);
    try {
      await this.bot.api.sendMessage(this.chatId, renderProposalMarkdown(proposal), {
        parse_mode: 'MarkdownV2',
        reply_markup: kb,
      });
    } catch (err) {
      logger.error({ err, proposalId: proposal.proposalId }, 'telegram send failed');
    }
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bot.start({ onStart: () => logger.info('telegram bot started') }).catch((err) => {
      logger.error({ err }, 'telegram bot crashed');
    });
    signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  async stop(): Promise<void> {
    try {
      await this.bot.stop();
    } catch {
      /* ignore */
    }
  }
}
