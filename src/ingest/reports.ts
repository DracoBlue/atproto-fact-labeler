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
import { verifyAtprotoServiceJwt } from '../util/atproto-jwt.ts';

const LXM = 'com.atproto.moderation.createReport';

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
  reportedBy: string;
  reportedAt: string;
}

export type ReportDispatcher = (report: ReportPayload) => Promise<void> | void;

export interface ReportRouteOptions {
  /** When true, require a valid atproto service JWT on the request. */
  requireAuth: boolean;
  /** The labeler's own DID — used as the expected `aud` claim. */
  labelerDid: string;
  /** PLC directory base URL. */
  plcUrl?: string;
}

/**
 * Mounts POST /xrpc/com.atproto.moderation.createReport.
 *
 * When `requireAuth` is true (production default), the request body is rejected
 * unless the `Authorization: Bearer <jwt>` header verifies as a real atproto
 * service JWT against the labeler DID. When `requireAuth` is false (local dev
 * only), any JSON body is accepted and `reportedBy` is recorded as 'unknown'.
 *
 * Account-level reports (subject = did) are accepted but the dispatcher only
 * fires for content reports (subject = at:// post).
 */
export function registerReportRoutes(
  app: LabelerApp,
  dispatch: ReportDispatcher,
  opts: ReportRouteOptions,
): void {
  app.post<{ Body: ReportRequest }>(
    '/xrpc/com.atproto.moderation.createReport',
    async (req, reply) => {
      let reportedBy = 'unknown';

      if (opts.requireAuth) {
        const authHeader =
          (req.headers.authorization as string | undefined) ??
          (req.headers.Authorization as string | undefined) ??
          '';
        const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!bearerMatch) {
          reply.code(401);
          return {
            error: 'AuthRequired',
            message: 'Missing Authorization: Bearer <jwt>',
          };
        }
        const result = await verifyAtprotoServiceJwt(bearerMatch[1]!, {
          expectedAud: opts.labelerDid,
          expectedLxm: LXM,
          plcUrl: opts.plcUrl,
        });
        if (!result.ok) {
          logger.warn(
            { reason: result.error, jwt: result.details, expectedAud: opts.labelerDid, expectedLxm: LXM },
            'report JWT rejected',
          );
          reply.code(401);
          return { error: 'BadJwt', message: result.error };
        }
        reportedBy = result.iss;
      }

      const body = req.body ?? {};
      const reasonType =
        typeof body.reasonType === 'string'
          ? body.reasonType
          : 'com.atproto.moderation.defs#reasonOther';
      const reason = typeof body.reason === 'string' ? body.reason : '';
      const subject = body.subject ?? {};
      const subjectUri = typeof subject.uri === 'string' ? subject.uri : '';
      const subjectCid = typeof subject.cid === 'string' ? subject.cid : undefined;
      const reportedAt = new Date().toISOString();

      if (subjectUri && subjectUri.startsWith('at://')) {
        try {
          await dispatch({
            reasonType,
            reason,
            subjectUri,
            subjectCid,
            reportedBy,
            reportedAt,
          });
        } catch (err) {
          logger.error({ err, subjectUri }, 'report dispatcher failed');
        }
      } else {
        logger.info(
          { reasonType, subjectDid: subject.did, reportedBy },
          'received account-level report — not actionable, ignoring',
        );
      }

      reply.code(200);
      return {
        id: Date.now(),
        reasonType,
        reason,
        subject: subjectUri
          ? { $type: 'com.atproto.repo.strongRef', uri: subjectUri, cid: subjectCid }
          : { $type: 'com.atproto.admin.defs#repoRef', did: subject.did ?? '' },
        reportedBy,
        createdAt: reportedAt,
      };
    },
  );
}
