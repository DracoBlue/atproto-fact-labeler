/**
 * Decide whether a Jetstream-ingested post should be fact-checked and, if so,
 * which URI to target.
 *
 * Triggers (combined, any can fire):
 *  1. Firehose — every post (TRIGGER_FIREHOSE=true). Off by default.
 *  2. Mention — post mentions the labeler. Default ON.
 *               If the mention is in a reply, the parent post is the target.
 *  3. Watchlist — post's author DID is in TRIGGER_WATCHLIST. Default empty.
 *
 * Reports (variant 3 of the trigger overview) are handled outside this module
 * because they don't come through Jetstream — see src/ingest/reports.ts.
 */
import { detectMention, type MentionDetectionOptions } from './mentions.ts';
import type { IngestedPost } from './types.ts';

export interface TriggerConfig {
  firehose: boolean;
  mentions: boolean;
  watchlist: string[];
  labelerDid: string;
  labelerHandle?: string;
}

export type TriggerReason =
  | 'firehose'
  | 'mention'
  | 'mention-reply'
  | 'mention-quote'
  | 'watchlist';

export interface TriggerHit {
  reason: TriggerReason;
  /** URI of the post we should fact-check (may differ from the source post). */
  targetUri: string;
  /** Whether we already have the target's full record (true) or must fetch it (false). */
  targetIsSourcePost: boolean;
}

/**
 * Returns the trigger hit, or `null` to drop the post. Pure / synchronous.
 *
 * **Self-mention protection.** A post authored by the labeler itself is always
 * dropped, regardless of which triggers are configured. This prevents the
 * obvious recursion when `REPLY_TO_MENTIONS=true` and a reply happens to be
 * mistaken for a new claim, and it also stops the labeler from labelling its
 * own posts on a watchlist or firehose match.
 */
export function evaluateTrigger(post: IngestedPost, cfg: TriggerConfig): TriggerHit | null {
  // Hard guard — never act on our own posts.
  if (post.did === cfg.labelerDid) return null;

  // Firehose always wins (most permissive).
  if (cfg.firehose) {
    return { reason: 'firehose', targetUri: post.uri, targetIsSourcePost: true };
  }

  // Watchlist on the post's author.
  if (cfg.watchlist.length && cfg.watchlist.includes(post.did)) {
    return { reason: 'watchlist', targetUri: post.uri, targetIsSourcePost: true };
  }

  // Mention check.
  if (cfg.mentions) {
    const opts: MentionDetectionOptions = { did: cfg.labelerDid };
    if (cfg.labelerHandle) opts.handle = cfg.labelerHandle;
    const det = detectMention(post, opts);
    if (det.matched) {
      // Precedence: reply > quote > standalone.
      if (post.replyParent?.uri) {
        // "@labeler check this" on someone else's post — target the parent.
        return {
          reason: 'mention-reply',
          targetUri: post.replyParent.uri,
          targetIsSourcePost: false,
        };
      }
      if (post.quotedRecord?.uri) {
        // "@labeler check this" quote-posting someone else's post — target the
        // quoted record. Same intent as mention-reply: the user is pointing
        // at someone else's claim and asking us to assess it.
        return {
          reason: 'mention-quote',
          targetUri: post.quotedRecord.uri,
          targetIsSourcePost: false,
        };
      }
      // Standalone mention — the mentioning post is itself the assertion.
      return { reason: 'mention', targetUri: post.uri, targetIsSourcePost: true };
    }
  }

  return null;
}
