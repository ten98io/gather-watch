/**
 * Admin takedown CLI (BUILD_PROMPT compliance surface: "POST /report
 * content-report endpoint + admin takedown CLI ... actually disable
 * content"). Reads the reports mailbox and disables the reported target:
 *
 *   pnpm --filter gather-api exec tsx src/cli/takedown.ts list
 *   pnpm --filter gather-api exec tsx src/cli/takedown.ts resolve <reportId>
 *   pnpm --filter gather-api exec tsx src/cli/takedown.ts resolve <reportId> --dismiss
 *
 * Actions per target kind (all mark report.resolvedAt):
 *   message → tombstoned (same patch shape as GDPR erasure)
 *   user    → banned in every room + all sessions revoked
 *   room    → room + invites deleted (memberships removed)
 *   asset   → marked failed/"removed by moderation", playback URLs nulled
 *             (object-storage cleanup belongs to the media service)
 *
 * `--dismiss` resolves the report WITHOUT touching the target.
 * The takedown logic is exported pure-over-StorePort for tests; only main()
 * touches process/env.
 */
import { loadConfig } from '../config';
import { createStore } from '../adapters/index';
import type { ReportDoc, StorePort } from '../adapters/ports';
import type { MessageId, UserId } from '@gather/contracts';

export interface TakedownResult {
  report: ReportDoc;
  action: string;
}

export async function listOpenReports(store: StorePort): Promise<ReportDoc[]> {
  const reports = await store.reports.findMany({ resolvedAt: null });
  return reports.sort((a, b) => a.createdAt - b.createdAt);
}

/** Disable the report's target and mark the report resolved. */
export async function executeTakedown(
  store: StorePort,
  reportId: string,
  opts: { dismiss?: boolean } = {},
): Promise<TakedownResult> {
  const report = await store.reports.findById(reportId);
  if (report === null) {
    throw new Error(`report ${reportId} not found`);
  }
  if (report.resolvedAt !== null) {
    throw new Error(`report ${reportId} is already resolved`);
  }
  const now = Date.now();

  let action = 'dismissed (target untouched)';
  if (opts.dismiss !== true) {
    const target = report.target;
    switch (target.kind) {
      case 'message': {
        const updated = await store.messages.updateOne(
          { id: target.messageId as MessageId, roomId: target.roomId },
          {
            body: '',
            gifUrl: null,
            attachment: null,
            mentions: [],
            reactions: {},
            pinned: false,
            deletedAt: now,
          },
        );
        action = updated === null ? 'message already gone' : 'message tombstoned';
        break;
      }
      case 'user': {
        const memberships = await store.members.findMany({ userId: target.userId as UserId });
        for (const membership of memberships) {
          await store.members.updateOne({ id: membership.id }, { banned: true });
        }
        const revoked = await store.sessions.updateMany(
          { userId: target.userId, revokedAt: null },
          { revokedAt: now },
        );
        action = `user banned in ${String(memberships.length)} room(s), ${String(revoked)} session(s) revoked`;
        break;
      }
      case 'room': {
        const members = await store.members.findMany({ roomId: target.roomId });
        for (const membership of members) {
          await store.members.deleteOne({ id: membership.id });
        }
        await store.invites.deleteMany({ roomId: target.roomId });
        const deleted = await store.rooms.deleteOne({ id: target.roomId });
        action = deleted ? 'room deleted (members + invites removed)' : 'room already gone';
        break;
      }
      case 'asset': {
        const updated = await store.assets.updateOne(
          { id: target.assetId },
          {
            status: 'failed',
            error: 'removed by moderation',
            hlsUrl: null,
            thumbnailUrl: null,
            waveformUrl: null,
          },
        );
        action = updated === null ? 'asset already gone' : 'asset disabled';
        break;
      }
    }
  }

  const resolved = await store.reports.updateOne({ id: report.id }, { resolvedAt: now });
  return { report: resolved ?? { ...report, resolvedAt: now }, action };
}

function describeTarget(report: ReportDoc): string {
  const t = report.target;
  switch (t.kind) {
    case 'message':
      return `message ${t.messageId} in room ${t.roomId}`;
    case 'user':
      return `user ${t.userId}`;
    case 'room':
      return `room ${t.roomId}`;
    case 'asset':
      return `asset ${t.assetId}`;
  }
}

async function main(): Promise<void> {
  const [command, reportId, flag] = process.argv.slice(2);
  const config = loadConfig();
  const store = createStore(config);
  await store.init();
  try {
    if (command === 'list' || command === undefined) {
      const open = await listOpenReports(store);
      if (open.length === 0) {
        console.log('no open reports');
        return;
      }
      for (const report of open) {
        console.log(
          `${report.id}  ${new Date(report.createdAt).toISOString()}  ${describeTarget(report)}`,
        );
        console.log(`    reporter ${report.reporterId}: ${report.reason}`);
      }
      return;
    }
    if (command === 'resolve') {
      if (reportId === undefined) {
        console.error('usage: takedown resolve <reportId> [--dismiss]');
        process.exitCode = 2;
        return;
      }
      const result = await executeTakedown(store, reportId, { dismiss: flag === '--dismiss' });
      console.log(`report ${result.report.id} resolved: ${result.action}`);
      return;
    }
    console.error(`unknown command "${command}" — use: list | resolve <reportId> [--dismiss]`);
    process.exitCode = 2;
  } finally {
    await store.close();
  }
}

// Only run as a script — never on import (tests import the pure functions).
if (process.argv[1]?.endsWith('takedown.ts') === true || process.argv[1]?.endsWith('takedown.js') === true) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
