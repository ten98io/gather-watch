/**
 * Compliance module tests: report mailbox (every target kind + 404/400/401),
 * GDPR export (contract-exact payload, no server-only fields), and account
 * erasure (immediate cascade + process-local purge sweeper). Runs entirely on
 * the memory adapters via test/helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DeleteMeResponse, MeExportResponse, ReportResponse } from '@playin/contracts';
import type {
  AssetId,
  Message,
  MessageId,
  PlaylistId,
  ReportTarget,
  Room,
  RoomId,
  User,
  UserId,
} from '@playin/contracts';
import { newId } from '../../lib/tokens';
import type { AssetDoc, StorePort } from '../../adapters/ports';
import type { Deps } from '../types';
import { addMember, makeApp, seedRoom, signupUser } from '../../../test/helpers';
import type { SignedUpUser } from '../../../test/helpers';
import {
  ERASURE_GRACE_MS,
  pendingPurgeCount,
  purgeDueUsers,
} from './erasure';

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function seedMessage(
  store: StorePort,
  roomId: string,
  authorId: string,
  body: string,
): Promise<Message> {
  const message: Message = {
    id: newId() as MessageId,
    roomId: roomId as RoomId,
    authorId: authorId as UserId,
    kind: 'text',
    body,
    gifUrl: null,
    attachment: null,
    replyTo: null,
    mentions: [],
    reactions: {},
    pinned: false,
    editedAt: null,
    deletedAt: null,
    seq: await store.nextSeq(`chat:${roomId}`),
    createdAt: Date.now(),
  };
  await store.messages.insertOne(message);
  return message;
}

async function seedAsset(store: StorePort, ownerId: string): Promise<AssetDoc> {
  const asset: AssetDoc = {
    id: newId() as AssetId,
    ownerId: ownerId as UserId,
    filename: 'clip.mp4',
    mime: 'video/mp4',
    sizeBytes: 1234,
    status: 'ready',
    hlsUrl: 'https://cdn.example.com/hls/master.m3u8',
    thumbnailUrl: null,
    waveformUrl: null,
    durationMs: 60_000,
    error: null,
    createdAt: Date.now(),
    storageKey: `raw/${newId()}`,
    uploadId: null,
  };
  await store.assets.insertOne(asset);
  return asset;
}

/** Playlist + push sub + subscription + usage row, all keyed to the user. */
async function seedAccountData(store: StorePort, userId: string): Promise<void> {
  await store.playlists.insertOne({
    id: newId() as PlaylistId,
    ownerId: userId as UserId,
    roomId: null,
    title: 'My playlist',
    items: [],
  });
  await store.pushSubs.insertOne({
    id: newId(),
    userId,
    platform: 'web',
    endpoint: `https://push.example.com/${newId()}`,
    keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
    expoPushToken: null,
    createdAt: Date.now(),
  });
  await store.subscriptions.insertOne({
    id: userId,
    userId,
    plan: 'free',
    status: 'active',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    updatedAt: Date.now(),
  });
  await store.usage.insertOne({
    id: newId(),
    userId,
    roomId: null,
    kind: 'session-minutes',
    amount: 12,
    unit: 'min',
    at: Date.now(),
    meta: null,
  });
}

/** Create a room over HTTP (owner = account, host membership included). */
async function createRoom(app: FastifyInstance, account: SignedUpUser): Promise<Room> {
  const res = await app.inject({
    method: 'POST',
    url: '/rooms',
    headers: bearer(account.accessToken),
    payload: { kind: 'watch', name: 'Compliance Test Room' },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { room: Room }).room;
}

describe('compliance', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp());
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /report', () => {
    it('accepts a report for every target kind and persists each row', async () => {
      const reporter = await signupUser(app, 'reporter@example.com');
      const targetUser = await signupUser(app, 'target@example.com');
      const room = await createRoom(app, reporter);
      const message = await seedMessage(store, room.id, targetUser.user.id, 'reported words');
      const asset = await seedAsset(store, targetUser.user.id);

      const targets: ReportTarget[] = [
        { kind: 'user', userId: targetUser.user.id },
        { kind: 'room', roomId: room.id },
        { kind: 'message', messageId: message.id, roomId: room.id },
        { kind: 'asset', assetId: asset.id },
      ];
      for (const target of targets) {
        const res = await app.inject({
          method: 'POST',
          url: '/report',
          headers: bearer(reporter.accessToken),
          payload: { target, reason: `reason for ${target.kind}` },
        });
        expect(res.statusCode).toBe(200);
        const body = ReportResponse.parse(res.json());
        const row = await store.reports.findById(body.reportId);
        expect(row).not.toBeNull();
        expect(row?.reporterId).toBe(reporter.user.id);
        expect(row?.target).toEqual(target);
        expect(row?.reason).toBe(`reason for ${target.kind}`);
        expect(row?.resolvedAt).toBeNull();
      }
    });

    it('404s on unknown targets of every kind and on room-mismatched messages', async () => {
      const reporter = await signupUser(app, 'reporter404@example.com');
      const roomA = await createRoom(app, reporter);
      const roomB = await createRoom(app, reporter);
      const message = await seedMessage(store, roomA.id, reporter.user.id, 'in room A');

      const badTargets: ReportTarget[] = [
        { kind: 'user', userId: newId() as UserId },
        { kind: 'room', roomId: newId() as RoomId },
        { kind: 'asset', assetId: newId() as AssetId },
        { kind: 'message', messageId: newId() as MessageId, roomId: roomA.id },
        // Real message, wrong room — id+roomId are a compound reference.
        { kind: 'message', messageId: message.id, roomId: roomB.id },
      ];
      for (const target of badTargets) {
        const res = await app.inject({
          method: 'POST',
          url: '/report',
          headers: bearer(reporter.accessToken),
          payload: { target, reason: 'does not exist' },
        });
        expect(res.statusCode).toBe(404);
        expect((res.json() as { code: string }).code).toBe('NOT_FOUND');
      }
    });

    it('400s on invalid bodies', async () => {
      const reporter = await signupUser(app, 'reporter400@example.com');
      const room = await createRoom(app, reporter);
      const invalid: unknown[] = [
        { target: { kind: 'room', roomId: room.id }, reason: '' }, // min(1)
        { target: { kind: 'room', roomId: room.id } }, // missing reason
        { target: { kind: 'post', postId: 'x' }, reason: 'bad discriminator' },
        { reason: 'missing target' },
      ];
      for (const payload of invalid) {
        const res = await app.inject({
          method: 'POST',
          url: '/report',
          headers: bearer(reporter.accessToken),
          payload: payload as Record<string, unknown>,
        });
        expect(res.statusCode).toBe(400);
        expect((res.json() as { code: string }).code).toBe('VALIDATION');
      }
    });

    it('401s when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/report',
        payload: { target: { kind: 'user', userId: newId() }, reason: 'anon' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /me/export', () => {
    it('returns the contract-exact payload across collections, leaking no server-only fields', async () => {
      const account = await signupUser(app, 'exporter@example.com');
      const room = await createRoom(app, account);
      await seedMessage(store, room.id, account.user.id, 'my own words');
      await seedAccountData(store, account.user.id);
      await seedAsset(store, account.user.id);

      const res = await app.inject({
        method: 'GET',
        url: '/me/export',
        headers: bearer(account.accessToken),
      });
      expect(res.statusCode).toBe(200);
      const raw = res.json() as Record<string, unknown>;
      // EXACT contract key set — sessions/subscription/pushSubs/usage are not
      // part of MeExportResponse and must not be bolted on.
      expect(Object.keys(raw).sort()).toEqual(
        ['assets', 'exportedAt', 'messages', 'playlists', 'rooms', 'user'].sort(),
      );
      const body = MeExportResponse.parse(raw);
      expect(body.user.id).toBe(account.user.id);
      expect(body.user.email).toBe('exporter@example.com');
      expect(body.rooms.map((r) => r.id)).toEqual([room.id]);
      expect(body.rooms[0]).not.toHaveProperty('playback');
      expect(body.rooms[0]).not.toHaveProperty('queue');
      expect(body.messages.map((m) => m.body)).toEqual(['my own words']);
      expect(body.playlists.map((p) => p.title)).toEqual(['My playlist']);
      expect(body.assets).toHaveLength(1);
      expect(body.assets[0]).not.toHaveProperty('storageKey');
      expect(body.assets[0]).not.toHaveProperty('uploadId');

      const json = JSON.stringify(raw);
      expect(json).not.toContain('refreshHash');
      expect(json).not.toContain('rotatedHashes');
      expect(json).not.toContain('storageKey');
    });

    it('lets a guest export their own (room-scoped) data', async () => {
      const { roomId, inviteCode } = await seedRoom(store);
      const guestRes = await app.inject({
        method: 'POST',
        url: '/auth/guest',
        payload: { inviteCode, displayName: 'Export Guest' },
      });
      const guest = guestRes.json() as { user: User; accessToken: string };
      await seedMessage(store, roomId, guest.user.id, 'guest words');

      const res = await app.inject({
        method: 'GET',
        url: '/me/export',
        headers: bearer(guest.accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = MeExportResponse.parse(res.json());
      expect(body.user.displayName).toBe('Export Guest');
      expect(body.rooms.map((r) => r.id)).toEqual([roomId]);
      expect(body.messages.map((m) => m.body)).toEqual(['guest words']);
    });

    it('401s when unauthenticated', async () => {
      const res = await app.inject({ method: 'GET', url: '/me/export' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('DELETE /me', () => {
    it('runs the full cascade immediately and schedules the hard purge', async () => {
      const account = await signupUser(app, 'leaver@example.com');
      const second = await signupUser(app, 'leaver@example.com'); // 2nd session
      const member = await signupUser(app, 'staying@example.com');

      // room1: account hosts, member is a plain member (handoff target).
      const room1 = await createRoom(app, account);
      await addMember(store, room1.id, member.user.id, 'member');
      // room2: account is the SOLE host — rooms leave semantics keep the room
      // ownerless when no successor remains.
      const room2 = await createRoom(app, account);
      // room3: someone else's room where the account holds a BANNED row.
      const seeded = await seedRoom(store);
      const bannedRow = await addMember(store, seeded.roomId, account.user.id, 'member');
      await store.members.updateOne({ id: bannedRow.id }, { banned: true });

      const msgA1 = await seedMessage(store, room1.id, account.user.id, 'erase me one');
      const msgA2 = await seedMessage(store, room2.id, account.user.id, 'erase me two');
      const msgB = await seedMessage(store, room1.id, member.user.id, 'keep me');
      await seedAccountData(store, account.user.id);
      await seedAsset(store, account.user.id);

      const purgesBefore = pendingPurgeCount();
      const before = Date.now();
      const res = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: bearer(account.accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = DeleteMeResponse.parse(res.json());
      expect(body.purgeAt - before).toBeGreaterThanOrEqual(ERASURE_GRACE_MS - 5_000);
      expect(body.purgeAt - before).toBeLessThanOrEqual(ERASURE_GRACE_MS + 5_000);
      expect(pendingPurgeCount()).toBe(purgesBefore + 1);

      // Sessions revoked AND deleted; every old credential is dead.
      expect(await store.sessions.findMany({ userId: account.user.id })).toEqual([]);
      for (const token of [account.accessToken, second.accessToken]) {
        const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });
        expect(me.statusCode).toBe(401);
      }

      // User doc anonymized, not hard-deleted.
      const user = await store.users.findById(account.user.id);
      expect(user).not.toBeNull();
      expect(user?.email).toBeNull();
      expect(user?.displayName).toBe('Deleted user');
      expect(user?.avatarUrl).toBeNull();

      // Memberships: handoff in room1, ownerless persist in room2, banned row
      // in room3 deleted outright.
      expect(await store.members.findMany({ userId: account.user.id })).toEqual([]);
      const room1After = await store.rooms.findById(room1.id);
      expect(room1After?.ownerId).toBe(member.user.id);
      const promoted = await store.members.findOne({
        roomId: room1.id as RoomId,
        userId: member.user.id,
      });
      expect(promoted?.role).toBe('host');
      const room2After = await store.rooms.findById(room2.id);
      expect(room2After).not.toBeNull(); // ownerless persist, not closed
      expect(await store.members.count({ roomId: room2.id as RoomId })).toBe(0);

      // Messages tombstoned with the chat module's exact shape; others intact.
      for (const id of [msgA1.id, msgA2.id]) {
        const tomb = await store.messages.findById(id);
        expect(tomb?.deletedAt).not.toBeNull();
        expect(tomb?.body).toBe('');
        expect(tomb?.gifUrl).toBeNull();
        expect(tomb?.attachment).toBeNull();
        expect(tomb?.mentions).toEqual([]);
        expect(tomb?.reactions).toEqual({});
        expect(tomb?.pinned).toBe(false);
      }
      expect((await store.messages.findById(msgB.id))?.body).toBe('keep me');

      // Account-owned rows gone; media assets deliberately untouched (their
      // storage lifecycle belongs to the media module); usage awaits purgeAt.
      expect(await store.pushSubs.findMany({ userId: account.user.id })).toEqual([]);
      expect(await store.subscriptions.findById(account.user.id)).toBeNull();
      expect(await store.playlists.findMany({ ownerId: account.user.id })).toEqual([]);
      expect(await store.assets.count({ ownerId: account.user.id })).toBe(1);
      expect(await store.usage.count({ userId: account.user.id })).toBe(1);
    });

    it('hard-purges residue only once purgeAt has passed', async () => {
      const account = await signupUser(app, 'purge@example.com');
      const room = await createRoom(app, account);
      await seedMessage(store, room.id, account.user.id, 'soon gone entirely');
      await seedAccountData(store, account.user.id);

      const res = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: bearer(account.accessToken),
      });
      const { purgeAt } = DeleteMeResponse.parse(res.json());

      // Not yet due: nothing changes.
      expect(await purgeDueUsers(deps, purgeAt - 1000)).toEqual([]);
      expect(await store.usage.count({ userId: account.user.id })).toBe(1);
      expect(
        await store.messages.count({
          authorId: account.user.id,
          deletedAt: { $ne: null },
        }),
      ).toBe(1);

      // Due: usage + tombstones hard-deleted; the anonymized user doc stays
      // as the referable tombstone identity. (The registry is process-global,
      // so earlier tests' due entries sweep along — assert membership, not
      // exact contents.)
      const purged = await purgeDueUsers(deps, purgeAt);
      expect(purged).toContain(account.user.id);
      expect(await store.usage.count({ userId: account.user.id })).toBe(0);
      expect(await store.messages.count({ authorId: account.user.id })).toBe(0);
      const user = await store.users.findById(account.user.id);
      expect(user?.displayName).toBe('Deleted user');

      // Registry entry consumed — a second sweep does nothing for this user.
      expect(await purgeDueUsers(deps, purgeAt + 1000)).not.toContain(account.user.id);
    });

    it('rejects guest tokens with 403 (no account to erase)', async () => {
      const { inviteCode } = await seedRoom(store);
      const guestRes = await app.inject({
        method: 'POST',
        url: '/auth/guest',
        payload: { inviteCode, displayName: 'Ephemeral' },
      });
      const guest = guestRes.json() as { accessToken: string };
      const res = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: bearer(guest.accessToken),
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { code: string }).code).toBe('FORBIDDEN');
    });

    it('401s when unauthenticated', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/me' });
      expect(res.statusCode).toBe(401);
    });
  });
});
