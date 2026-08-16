/**
 * Compliance domain logic: the content-report mailbox (POST /report).
 * Pure logic over Deps — no Fastify types in this file, directly unit-testable.
 *
 * Per BUILD_PROMPT "Safeguards & compliance": this endpoint is a MAILBOX for
 * admin takedown review. It must never filter, score, rate-limit by content,
 * or act on the reported content itself (floods are already covered by the
 * global rate-limit plugin).
 */
import type { ReportBody, ReportTarget } from '@gather/contracts';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/tokens';
import type { ReportDoc } from '../../adapters/ports';
import type { Deps } from '../types';

export class ComplianceService {
  constructor(private readonly deps: Deps) {}

  /** The reported thing must actually exist — garbage targets get a 404 so
   *  the mailbox only ever holds actionable rows. A message target must live
   *  in the room the reporter names (id+roomId are a compound reference). */
  private async requireTarget(target: ReportTarget): Promise<void> {
    const { store } = this.deps;
    switch (target.kind) {
      case 'message': {
        const message = await store.messages.findById(target.messageId);
        if (message === null || message.roomId !== target.roomId) {
          throw new AppError('NOT_FOUND', 'message not found');
        }
        return;
      }
      case 'user': {
        const user = await store.users.findById(target.userId);
        if (user === null) {
          throw new AppError('NOT_FOUND', 'user not found');
        }
        return;
      }
      case 'room': {
        const room = await store.rooms.findById(target.roomId);
        if (room === null) {
          throw new AppError('NOT_FOUND', 'room not found');
        }
        return;
      }
      case 'asset': {
        const asset = await store.assets.findById(target.assetId);
        if (asset === null) {
          throw new AppError('NOT_FOUND', 'asset not found');
        }
        return;
      }
    }
  }

  /** Persist one report row; returns it so the route can answer with its id. */
  async report(reporterId: string, body: ReportBody): Promise<ReportDoc> {
    await this.requireTarget(body.target);
    const doc: ReportDoc = {
      id: newId(),
      reporterId,
      target: body.target,
      reason: body.reason,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    return this.deps.store.reports.insertOne(doc);
  }
}
