/**
 * Admin takedown CLI logic (src/cli/takedown.ts) over the memory store: each
 * target kind is actually disabled, dismiss leaves targets untouched, and
 * resolved reports leave the open list.
 */
import { describe, expect, it } from 'vitest';
import type { MessageId, ReportTarget, UserId } from '@gather/contracts';
import { MemoryStore } from '../src/adapters/memory-store';
import type { ReportDoc, StorePort } from '../src/adapters/ports';
import { memberDocId } from '../src/adapters/ports';
import { newId } from '../src/lib/tokens';
import { executeTakedown, listOpenReports } from '../src/cli/takedown';
import { seedRoom } from './helpers';

async function seedReport(store: StorePort, target: ReportTarget): Promise<ReportDoc> {
  return store.reports.insertOne({
    id: newId(),
    reporterId: newId(),
    target,
    reason: 'test report',
    createdAt: Date.now(),
    resolvedAt: null,
  });
}

describe('takedown CLI', () => {
  it('tombstones a reported message and resolves the report', async () => {
    const store = new MemoryStore();
    const { roomId } = await seedRoom(store);
    const message = await store.messages.insertOne({
      id: newId() as MessageId,
      roomId,
      authorId: newId() as UserId,
      kind: 'text',
      body: 'nasty content',
      gifUrl: null,
      attachment: null,
      replyTo: null,
      mentions: [],
      reactions: {},
      pinned: false,
      editedAt: null,
      deletedAt: null,
      createdAt: Date.now(),
      seq: 1,
    });
    const report = await seedReport(store, {
      kind: 'message',
      messageId: message.id,
      roomId,
    });

    const result = await executeTakedown(store, report.id);
    expect(result.action).toContain('tombstoned');
    const tombstone = await store.messages.findById(message.id);
    expect(tombstone?.body).toBe('');
    expect(tombstone?.deletedAt).not.toBeNull();
    expect((await store.reports.findById(report.id))?.resolvedAt).not.toBeNull();
    expect(await listOpenReports(store)).toHaveLength(0);
  });

  it('bans a reported user everywhere and revokes their sessions', async () => {
    const store = new MemoryStore();
    const { roomId } = await seedRoom(store);
    const userId = newId() as UserId;
    await store.members.insertOne({
      id: memberDocId(roomId, userId),
      roomId,
      userId,
      role: 'member',
      joinedAt: Date.now(),
      banned: false,
      muted: false,
    });
    await store.sessions.insertOne({
      id: newId(),
      userId,
      device: 'test',
      refreshHash: 'h',
      rotatedHashes: [],
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revokedAt: null,
    });
    const report = await seedReport(store, { kind: 'user', userId });

    const result = await executeTakedown(store, report.id);
    expect(result.action).toContain('banned');
    expect((await store.members.findById(memberDocId(roomId, userId)))?.banned).toBe(true);
    const sessions = await store.sessions.findMany({ userId });
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it('deletes a reported room with its memberships and invites', async () => {
    const store = new MemoryStore();
    const { roomId } = await seedRoom(store);
    const report = await seedReport(store, { kind: 'room', roomId });

    const result = await executeTakedown(store, report.id);
    expect(result.action).toContain('room deleted');
    expect(await store.rooms.findById(roomId)).toBeNull();
    expect(await store.members.findMany({ roomId })).toHaveLength(0);
  });

  it('--dismiss resolves without touching the target; double-resolve throws', async () => {
    const store = new MemoryStore();
    const { roomId } = await seedRoom(store);
    const report = await seedReport(store, { kind: 'room', roomId });

    const result = await executeTakedown(store, report.id, { dismiss: true });
    expect(result.action).toContain('dismissed');
    expect(await store.rooms.findById(roomId)).not.toBeNull();
    await expect(executeTakedown(store, report.id)).rejects.toThrow('already resolved');
  });
});
