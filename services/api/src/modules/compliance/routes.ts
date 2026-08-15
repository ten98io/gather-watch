/**
 * Compliance REST endpoints (registered WITHOUT a prefix — full paths,
 * matching @playin/api-client): the content-report mailbox and the GDPR
 * self-service surface.
 *
 * Auth policy: reporting and export accept any verified identity (guests have
 * data and speech-worth-protecting too); DELETE /me requires a FULL account —
 * guests are room-scoped and ephemeral, there is no account to erase (403).
 */
import type { FastifyPluginAsync } from 'fastify';
import { ReportBody } from '@playin/contracts';
import type {
  DeleteMeResponse,
  MeExportResponse,
  ReportResponse,
} from '@playin/contracts';
import { parseWith } from '../../plugins/error-mapper';
import { requireAccount, requireAuth } from '../../plugins/auth';
import { ComplianceService } from './service';
import { buildExport } from './export';
import { eraseAccount, startPurgeSweeper } from './erasure';

export const complianceRoutes: FastifyPluginAsync = async (app) => {
  const stopSweeper = startPurgeSweeper(app.deps);
  app.addHook('onClose', async () => {
    stopSweeper();
  });

  app.post('/report', async (request): Promise<ReportResponse> => {
    const auth = requireAuth(request);
    const body = parseWith(ReportBody, request.body);
    const doc = await new ComplianceService(app.deps).report(auth.userId, body);
    return { ok: true, reportId: doc.id };
  });

  app.get('/me/export', async (request): Promise<MeExportResponse> => {
    const auth = requireAuth(request);
    return buildExport(app.deps, auth.userId);
  });

  app.delete('/me', async (request): Promise<DeleteMeResponse> => {
    const auth = requireAccount(request);
    const { purgeAt } = await eraseAccount(app.deps, auth.userId);
    return { ok: true, purgeAt };
  });
};
