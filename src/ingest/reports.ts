/**
 * Report ingestion — variant 3 of the trigger taxonomy.
 *
 * End users (and AppViews) submit reports against the labeler service via
 * `com.atproto.moderation.createReport`. We register a handler on the
 * labeler's own Fastify app so the same HTTP port serves it.
 *
 * Each report targets a post (via `com.atproto.repo.strongRef`); we fetch the
 * post body from the AppView and dispatch it through the normal pipeline.
 */
import type { LabelerApp } from '../labels/server.ts';
import { logger } from '../util/logger.ts';

export interface ReportRequest {
  reasonType?: string;
  reason?: string;
  subject?: {
    $type?: string;
    /** Account-level reports carry only a `did`. */
    did?: string;
    /** Content reports carry a uri+cid (com.atproto.repo.strongRef). */
    uri?: string;
    cid?: string;
  };
}

export interface ReportPayload {
  reasonType: string;
  reason: string;
  subjectUri: string;
  subjectCid?: string;
  reportedAt: string;
}

export type ReportDispatcher = (report: ReportPayload) => Promise<void> | void;

/**
 * Mounts POST /xrpc/com.atproto.moderation.createReport. Account-level reports
 * (subject = did) are accepted but ignored for now; the dispatcher only fires
 * for content reports (subject = at:// post).
 */
export function registerReportRoutes(app: LabelerApp, dispatch: ReportDispatcher): void {
  app.post<{ Body: ReportRequest }>(
    '/xrpc/com.atproto.moderation.createReport',
    async (req, reply) => {
      const body = req.body ?? {};
      const reasonType = typeof body.reasonType === 'string' ? body.reasonType : 'com.atproto.moderation.defs#reasonOther';
      const reason = typeof body.reason === 'string' ? body.reason : '';
      const subject = body.subject ?? {};
      const subjectUri = typeof subject.uri === 'string' ? subject.uri : '';
      const subjectCid = typeof subject.cid === 'string' ? subject.cid : undefined;
      const reportedAt = new Date().toISOString();

      if (subjectUri && subjectUri.startsWith('at://')) {
        try {
          await dispatch({ reasonType, reason, subjectUri, subjectCid, reportedAt });
        } catch (err) {
          logger.error({ err, subjectUri }, 'report dispatcher failed');
        }
      } else {
        logger.info(
          { reasonType, subjectDid: subject.did },
          'received account-level report — not actionable, ignoring',
        );
      }

      // Return a com.atproto.moderation.defs#createReportOutput-shaped response.
      reply.code(200);
      return {
        id: Date.now(),
        reasonType,
        reason,
        subject: subjectUri
          ? { $type: 'com.atproto.repo.strongRef', uri: subjectUri, cid: subjectCid }
          : { $type: 'com.atproto.admin.defs#repoRef', did: subject.did ?? '' },
        reportedBy: 'unknown',
        createdAt: reportedAt,
      };
    },
  );
}
