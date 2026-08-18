/**
 * Rooms domain logic: room lifecycle, membership and role hierarchy
 * (host > moderator > member > guest), invites, policy updates, and theater
 * mode. Pure logic over Deps — no Fastify types in this file, so it is
 * directly unit-testable.
 *
 * Every room.updated / member.updated emission passes through
 * serializeRoom/serializeMember (never leak server-only fields) and uses
 * deps.events.emit (persisted, seq-ordered). Departures go the other way:
 * removeFromRoom closes the target's sockets and broadcasts member.removed
 * plus a presence.diff, both EPHEMERAL (seq 0) — see the member.removed
 * contract for why a persisted seq would strand older clients in replay.
 */
import { randomInt } from 'node:crypto';
import { MEMBER_REMOVAL_CLOSE_TEXT, normalizeInviteCode } from '@gather/contracts';
import type {
  InviteCode,
  MemberRemovalReason,
  MemberRole,
  RoomHistoryEntry,
  RoomId,
  RoomKind,
  RoomPolicies,
  UpdatePoliciesBody,
  UserId,
} from '@gather/contracts';
import { AppError, isAppError } from '../../lib/errors';
import { newId } from '../../lib/tokens';
import { cursorDocId, memberDocId } from '../../adapters/ports';
import type { InviteDoc, MemberDoc, RoomDoc, UserDoc } from '../../adapters/ports';
import type { Deps } from '../types';
import { roomCtlChannel } from './deps';
import type { RoomCtlMessage } from './deps';
import { deleteRoomHistory, readRoomHistory, serializeHistoryEntry } from './history';
import { serializeMember, serializeRoom } from './serialize';

/** This instance's origin id for RoomCtlMessage.from (loopback skipping). */
const CTL_ORIGIN = newId();

/** Invite-code alphabet: no easily-confused characters (l/o/0/1/i). */
const INVITE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** 12 chars (displayed XXXX-XXXX-XXXX); legacy 8-char codes still join. */
const INVITE_CODE_LENGTH = 12;

/** How long a room may sit COMPLETELY EMPTY — no members at all — before the
 *  sweeper reclaims it and its history. Rooms never expire while anyone is in
 *  them (or merely belongs to them): this is storage housekeeping for
 *  abandoned rooms, not a session limit. */
export const IDLE_ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function newInviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    code += INVITE_ALPHABET.charAt(randomInt(INVITE_ALPHABET.length));
  }
  return code;
}

/** Successor-picking order after the host leaves. The departing host's row is
 *  already deleted, so no 'host' rows remain — rank it first anyway to keep
 *  the record total. */
const ROLE_RANK: Record<MemberRole, number> = { host: -1, moderator: 0, member: 1, guest: 2 };

export class RoomsService {
  constructor(private readonly deps: Deps) {}

  private now(): number {
    return Date.now();
  }

  /** Insert a doc keyed by a fresh invite code; retry up to 5 times when the
   *  unique index rejects a collision (CONFLICT), then rethrow. */
  private async insertWithFreshCode<T>(insert: (code: string) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= 5; attempt += 1) {
      try {
        return await insert(newInviteCode());
      } catch (err) {
        if (!isAppError(err) || err.code !== 'CONFLICT') {
          throw err;
        }
        lastError = err;
      }
    }
    throw lastError;
  }

  private async requireRoom(roomId: string): Promise<RoomDoc> {
    const room = await this.deps.store.rooms.findById(roomId);
    if (room === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    return room;
  }

  private async requireMember(roomId: string, userId: string): Promise<MemberDoc> {
    const member = await this.deps.store.members.findById(memberDocId(roomId, userId));
    if (member === null) {
      throw new AppError('FORBIDDEN', 'not a member');
    }
    if (member.banned === true) {
      throw new AppError('FORBIDDEN', 'banned');
    }
    return member;
  }

  private requireRole(member: MemberDoc, ...roles: MemberRole[]): void {
    if (!roles.includes(member.role)) {
      throw new AppError('ROOM_POLICY', 'insufficient role');
    }
  }

  /** The room's current event-stream tip (0 when no events yet). */
  private async lastEventSeq(roomId: string): Promise<number> {
    const last = await this.deps.store.events.findMany(
      { roomId },
      { sort: [['seq', -1]], limit: 1 },
    );
    return last[0]?.seq ?? 0;
  }

  /** The one chokepoint every departure passes through — kick, non-host and
   *  host leave, ban, room delete. Closes the user's sockets in the room (all
   *  instances, via the ctl bus), then tells everyone still here that the
   *  roster changed: member.removed (the People list refetches) plus the
   *  ephemeral presence removal. Both are seq 0 on purpose — presence.diff
   *  because it is ephemeral by nature, member.removed because an older
   *  client cannot parse the type and would read a persisted seq as a
   *  permanent gap. */
  private async removeFromRoom(
    roomId: string,
    userId: string,
    reason: MemberRemovalReason,
  ): Promise<void> {
    this.deps.hub.disconnectUser(
      roomId as RoomId,
      userId as UserId,
      4403,
      MEMBER_REMOVAL_CLOSE_TEXT[reason],
    );
    const message: RoomCtlMessage = { kind: 'kick', roomId, userId, from: CTL_ORIGIN };
    await this.deps.bus.publish(roomCtlChannel(roomId), message);
    this.deps.events.emitEphemeral(roomId as RoomId, 'member.removed', {
      userId: userId as UserId,
      reason,
    });
    this.deps.events.emitEphemeral(roomId as RoomId, 'presence.diff', {
      upserts: [],
      removed: [userId as UserId],
    });
  }

  /** Create a room with default policies and the caller as host member.
   *  `kind` is deprecated — stored on the doc for old clients; drives
   *  nothing — so it defaults rather than being required. */
  async createRoom(
    ownerId: string,
    name: string,
    kind: RoomKind = 'watch',
  ): Promise<{ room: RoomDoc; member: MemberDoc }> {
    const { store } = this.deps;
    const now = this.now();
    const room = await this.insertWithFreshCode((code) =>
      store.rooms.insertOne({
        id: newId() as RoomId,
        kind,
        name,
        inviteCode: code as InviteCode,
        ownerId: ownerId as UserId,
        policies: {
          playbackControl: 'host',
          queueControl: 'everyone',
          chat: 'everyone',
          maxPublishers: 6,
          waitForAll: false,
          skipVoteThreshold: 0.5,
        },
        relayMode: 'mesh',
        theater: false,
        playback: null,
        queue: { items: [], version: 0 },
        restream: null,
        master: null,
        // Rooms never expire on a clock. expiresAt stays null forever (the
        // field is kept only for stored docs and old clients); the sweeper
        // works off lastActivityAt + emptiness instead.
        expiresAt: null,
        lastActivityAt: now,
        createdAt: now,
      }),
    );
    const member = await store.members.insertOne({
      id: memberDocId(room.id, ownerId),
      roomId: room.id,
      userId: ownerId as UserId,
      role: 'host',
      joinedAt: now,
      banned: false,
      muted: false,
    });
    return { room, member };
  }

  /** Room + the caller's membership + event-stream tip (member required). */
  async getRoom(
    roomId: string,
    userId: string,
  ): Promise<{ room: RoomDoc; member: MemberDoc; lastEventSeq: number }> {
    const room = await this.requireRoom(roomId);
    const member = await this.requireMember(roomId, userId);
    const lastEventSeq = await this.lastEventSeq(roomId);
    return { room, member, lastEventSeq };
  }

  /** The user's rooms (non-banned memberships), newest first, with unread
   *  message counts, live member counts, and the per-room mute flag. */
  async listMyRooms(userId: string): Promise<
    Array<{ room: RoomDoc; unreadCount: number; memberCount: number; muted: boolean }>
  > {
    const { store } = this.deps;
    const memberships = await store.members.findMany({ userId: userId as UserId, banned: false });
    const rooms: Array<{ room: RoomDoc; unreadCount: number; memberCount: number; muted: boolean }> =
      [];
    for (const membership of memberships) {
      const room = await store.rooms.findById(membership.roomId);
      if (room === null) {
        continue;
      }
      const cursor = await store.cursors.findById(cursorDocId(room.id, userId, 'read'));
      const lastReadSeq = cursor?.lastSeq ?? 0;
      const unreadCount = await store.messages.count({
        roomId: room.id,
        seq: { $gt: lastReadSeq },
        deletedAt: null,
      });
      const memberCount = await store.members.count({ roomId: room.id, banned: false });
      rooms.push({ room, unreadCount, memberCount, muted: membership.muted });
    }
    rooms.sort((a, b) => b.room.createdAt - a.room.createdAt);
    return rooms;
  }

  /** Join a room via its built-in invite code or an extra invite. Joining is
   *  idempotent for existing (non-banned) members. */
  async joinByInvite(
    userId: string,
    inviteCode: string,
  ): Promise<{ room: RoomDoc; member: MemberDoc; lastEventSeq: number }> {
    const { store } = this.deps;
    const now = this.now();
    // Join input is user-typed: hyphens/spaces/case are presentation noise.
    const code = normalizeInviteCode(inviteCode);

    let room = await store.rooms.findOne({ inviteCode: code as InviteCode });
    if (room === null) {
      const invite = await store.invites.findById(code);
      if (invite === null || (invite.expiresAt !== null && invite.expiresAt < now)) {
        throw new AppError('NOT_FOUND', 'invite not found');
      }
      room = await store.rooms.findById(invite.roomId);
      if (room === null) {
        throw new AppError('NOT_FOUND', 'invite not found');
      }
    }

    const existing = await store.members.findById(memberDocId(room.id, userId));
    if (existing !== null) {
      if (existing.banned) {
        throw new AppError('FORBIDDEN', 'banned');
      }
      return { room, member: existing, lastEventSeq: await this.lastEventSeq(room.id) };
    }

    const member = await store.members.insertOne({
      id: memberDocId(room.id, userId),
      roomId: room.id,
      userId: userId as UserId,
      role: 'member',
      joinedAt: now,
      banned: false,
      muted: false,
    });
    await this.deps.events.emit(room.id, 'member.updated', serializeMember(member));
    return { room, member, lastEventSeq: await this.lastEventSeq(room.id) };
  }

  /** Leave a room. A departing host promotes a successor — moderators before
   *  members before guests, then earliest joiner, then userId — or the room
   *  persists ownerless when empty. A banned member's row is NEVER deleted on
   *  leave: the ban must outlive departure or leaving would launder it and
   *  re-open rejoin via invite. */
  async leaveRoom(roomId: string, userId: string): Promise<void> {
    const { store } = this.deps;
    const member = await store.members.findById(memberDocId(roomId, userId));
    if (member === null) {
      throw new AppError('FORBIDDEN', 'not a member');
    }
    if (member.banned) {
      // Already disconnected by the ban; keep the row so the ban sticks.
      return;
    }
    await store.members.deleteOne({ id: member.id });
    await this.removeFromRoom(roomId, userId, 'left');

    // The roster broadcast sits ABOVE this early return on purpose: everything
    // below is host-succession only, and a plain member walking out has to be
    // visible to everyone still in the room.
    if (member.role !== 'host') {
      return;
    }
    const remaining = await store.members.findMany({ roomId: roomId as RoomId, banned: false });
    remaining.sort(
      (a, b) =>
        ROLE_RANK[a.role] - ROLE_RANK[b.role] ||
        a.joinedAt - b.joinedAt ||
        a.userId.localeCompare(b.userId),
    );
    const successor = remaining[0];
    if (successor === undefined) {
      return;
    }
    const promoted = await store.members.updateOne({ id: successor.id }, { role: 'host' });
    const room = await store.rooms.updateOne(
      { id: roomId as RoomId },
      { ownerId: successor.userId },
    );
    if (promoted !== null) {
      await this.deps.events.emit(roomId as RoomId, 'member.updated', serializeMember(promoted));
    }
    if (room !== null) {
      await this.deps.events.emit(roomId as RoomId, 'room.updated', serializeRoom(room));
    }
  }

  /** All members of the room (including banned rows), each paired with their
   *  user; members whose user row is gone are skipped. */
  async listMembers(
    roomId: string,
    userId: string,
  ): Promise<Array<{ member: MemberDoc; user: UserDoc }>> {
    await this.requireMember(roomId, userId);
    const members = await this.deps.store.members.findMany({ roomId: roomId as RoomId });
    const out: Array<{ member: MemberDoc; user: UserDoc }> = [];
    for (const member of members) {
      const user = await this.deps.store.users.findById(member.userId);
      if (user === null) {
        continue;
      }
      out.push({ member, user });
    }
    return out;
  }

  /** One page of the room's playback history, newest first. Members only —
   *  what a room watched is as private as what it said, so this runs the same
   *  membership gate as the message history. */
  async listHistory(
    roomId: string,
    userId: string,
    opts: { before?: number | undefined; limit: number },
  ): Promise<{ entries: RoomHistoryEntry[]; nextBefore: number | null }> {
    await this.requireRoom(roomId);
    await this.requireMember(roomId, userId);
    const page = await readRoomHistory(this.deps, roomId, opts);
    return { entries: page.entries.map(serializeHistoryEntry), nextBefore: page.nextBefore };
  }

  /** Merge a policies patch (host/mods). maxPublishers is bounded by the
   *  contract (1..12) and nothing else — 12 is where a WebRTC mesh stops
   *  working, so it is the same ceiling for every room. */
  async updatePolicies(
    roomId: string,
    callerId: string,
    patch: UpdatePoliciesBody,
  ): Promise<RoomDoc> {
    const room = await this.requireRoom(roomId);
    const caller = await this.requireMember(roomId, callerId);
    this.requireRole(caller, 'host', 'moderator');
    // Strip undefined fields so exactOptionalPropertyTypes never writes an
    // explicit undefined over an existing value.
    const policies: RoomPolicies = {
      ...room.policies,
      ...(patch.playbackControl !== undefined ? { playbackControl: patch.playbackControl } : {}),
      ...(patch.queueControl !== undefined ? { queueControl: patch.queueControl } : {}),
      ...(patch.chat !== undefined ? { chat: patch.chat } : {}),
      ...(patch.maxPublishers !== undefined ? { maxPublishers: patch.maxPublishers } : {}),
      ...(patch.waitForAll !== undefined ? { waitForAll: patch.waitForAll } : {}),
      ...(patch.skipVoteThreshold !== undefined
        ? { skipVoteThreshold: patch.skipVoteThreshold }
        : {}),
    };
    const updated = await this.deps.store.rooms.updateOne({ id: room.id }, { policies });
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    await this.deps.events.emit(updated.id, 'room.updated', serializeRoom(updated));
    return updated;
  }

  /** Hand the host role to another member; the old host becomes a moderator. */
  async transferHost(roomId: string, callerId: string, toUserId: string): Promise<void> {
    const { store } = this.deps;
    const caller = await this.requireMember(roomId, callerId);
    this.requireRole(caller, 'host');
    if (toUserId === callerId) {
      throw new AppError('ROOM_POLICY', 'cannot transfer host to self');
    }
    const target = await store.members.findById(memberDocId(roomId, toUserId));
    if (target === null) {
      throw new AppError('NOT_FOUND', 'member not found');
    }
    if (target.banned) {
      throw new AppError('ROOM_POLICY', 'cannot transfer host to a banned member');
    }
    if (target.role === 'guest') {
      throw new AppError('ROOM_POLICY', 'guests cannot host');
    }
    const demoted = await store.members.updateOne({ id: caller.id }, { role: 'moderator' });
    const promoted = await store.members.updateOne({ id: target.id }, { role: 'host' });
    const room = await store.rooms.updateOne(
      { id: roomId as RoomId },
      { ownerId: toUserId as UserId },
    );
    if (demoted === null || promoted === null || room === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    await this.deps.events.emit(room.id, 'member.updated', serializeMember(demoted));
    await this.deps.events.emit(room.id, 'member.updated', serializeMember(promoted));
    await this.deps.events.emit(room.id, 'room.updated', serializeRoom(room));
  }

  /** Promote/demote between moderator and member (host only). Host is
   *  assigned via transferHost; guests upgrade via account. */
  async setMemberRole(
    roomId: string,
    callerId: string,
    targetId: string,
    role: 'moderator' | 'member',
  ): Promise<MemberDoc> {
    const caller = await this.requireMember(roomId, callerId);
    this.requireRole(caller, 'host');
    if (targetId === callerId) {
      throw new AppError('ROOM_POLICY', 'cannot change own role');
    }
    const target = await this.deps.store.members.findById(memberDocId(roomId, targetId));
    if (target === null) {
      throw new AppError('NOT_FOUND', 'member not found');
    }
    if (target.role === 'host') {
      throw new AppError('ROOM_POLICY', 'cannot change the host role');
    }
    if (target.role === 'guest') {
      throw new AppError('ROOM_POLICY', 'guests upgrade via account');
    }
    if (target.banned) {
      throw new AppError('ROOM_POLICY', 'cannot change role of a banned member');
    }
    const updated = await this.deps.store.members.updateOne({ id: target.id }, { role });
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'member not found');
    }
    await this.deps.events.emit(roomId as RoomId, 'member.updated', serializeMember(updated));
    return updated;
  }

  /** Shared hierarchy checks for kick/ban: caller is host|moderator, never
   *  self-targeting, target exists and is not the host, and moderators cannot
   *  target fellow moderators. */
  private async requireKickableTarget(
    roomId: string,
    callerId: string,
    targetId: string,
  ): Promise<MemberDoc> {
    const caller = await this.requireMember(roomId, callerId);
    this.requireRole(caller, 'host', 'moderator');
    if (targetId === callerId) {
      throw new AppError('ROOM_POLICY', 'cannot target self');
    }
    const target = await this.deps.store.members.findById(memberDocId(roomId, targetId));
    if (target === null) {
      throw new AppError('NOT_FOUND', 'member not found');
    }
    if (target.role === 'host') {
      throw new AppError('ROOM_POLICY', 'cannot target the host');
    }
    if (caller.role === 'moderator' && target.role === 'moderator') {
      throw new AppError('ROOM_POLICY', 'moderators cannot target moderators');
    }
    return target;
  }

  /** Remove a member from the room and disconnect their sockets. */
  async kickMember(roomId: string, callerId: string, targetId: string): Promise<void> {
    const target = await this.requireKickableTarget(roomId, callerId, targetId);
    await this.deps.store.members.deleteOne({ id: target.id });
    await this.removeFromRoom(roomId, targetId, 'kicked');
  }

  /** Ban (and disconnect) or unban a member; the membership row is kept. */
  async banMember(
    roomId: string,
    callerId: string,
    targetId: string,
    banned: boolean,
  ): Promise<void> {
    const target = await this.requireKickableTarget(roomId, callerId, targetId);
    const updated = await this.deps.store.members.updateOne({ id: target.id }, { banned });
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'member not found');
    }
    await this.deps.events.emit(roomId as RoomId, 'member.updated', serializeMember(updated));
    if (banned) {
      await this.removeFromRoom(roomId, targetId, 'banned');
    }
  }

  /** Mint an extra invite code for the room (host/mods). */
  async createInvite(
    roomId: string,
    callerId: string,
    expiresAt: number | null,
  ): Promise<InviteDoc> {
    const caller = await this.requireMember(roomId, callerId);
    this.requireRole(caller, 'host', 'moderator');
    return this.insertWithFreshCode((code) =>
      this.deps.store.invites.insertOne({
        id: code,
        code: code as InviteCode,
        roomId: roomId as RoomId,
        createdBy: callerId as UserId,
        expiresAt,
      }),
    );
  }

  /** Toggle theater layout (host/mods). Theater is PURELY A LAYOUT: it puts
   *  the shared media front and centre and says nothing about how media is
   *  transported, so relayMode is deliberately left alone. Writing 'cf-sfu'
   *  here used to hand the client a join path it cannot complete — the
   *  transport is a separate decision, not a side effect of a view toggle. */
  async setTheater(roomId: string, callerId: string, enabled: boolean): Promise<RoomDoc> {
    const room = await this.requireRoom(roomId);
    const caller = await this.requireMember(roomId, callerId);
    this.requireRole(caller, 'host', 'moderator');
    const updated = await this.deps.store.rooms.updateOne({ id: room.id }, { theater: enabled });
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    await this.deps.events.emit(updated.id, 'room.updated', serializeRoom(updated));
    return updated;
  }

  /** Set the caller's per-room notification mute flag. */
  async setRoomMute(roomId: string, userId: string, muted: boolean): Promise<void> {
    const updated = await this.deps.store.members.updateOne(
      { id: memberDocId(roomId, userId) },
      { muted },
    );
    if (updated === null) {
      throw new AppError('FORBIDDEN', 'not a member');
    }
  }

  /** Rename a room (host/moderator). Broadcasts room.updated. */
  async renameRoom(roomId: string, callerId: string, name: string): Promise<RoomDoc> {
    await this.requireRoom(roomId);
    const caller = await this.requireMember(roomId, callerId);
    this.requireRole(caller, 'host', 'moderator');
    const updated = await this.deps.store.rooms.updateOne({ id: roomId as RoomId }, { name });
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    await this.deps.events.emit(updated.id, 'room.updated', serializeRoom(updated));
    return updated;
  }

  /** Delete a room (host only): members + invites + the room row removed and
   *  every live socket disconnected. Messages/events are left to the GDPR
   *  cascade (they are room-scoped and unreadable once the room is gone), but
   *  we remove them too — a deleted room should not linger as orphan rows. */
  async deleteRoom(roomId: string, callerId: string): Promise<void> {
    const room = await this.requireRoom(roomId);
    const caller = await this.requireMember(roomId, callerId);
    this.requireRole(caller, 'host');
    const rid = roomId as RoomId;

    const members = await this.deps.store.members.findMany({ roomId: rid });
    for (const m of members) {
      await this.removeFromRoom(roomId, m.userId, 'roomDeleted');
      await this.deps.store.members.deleteOne({ id: m.id });
    }
    await this.deps.store.invites.deleteMany({ roomId: rid });
    await this.deps.store.messages.deleteMany({ roomId: rid });
    await this.deps.store.events.deleteMany({ roomId: rid });
    await this.deps.store.cursors.deleteMany({ roomId: rid });
    await deleteRoomHistory(this.deps, rid);
    await this.deps.store.rooms.deleteOne({ id: room.id });
  }
}

/** Rooms examined per sweep pass, so one pass over a large collection stays
 *  bounded; the next tick picks up where this one left off. */
const IDLE_SWEEP_BATCH = 200;

/**
 * Reclaim ABANDONED rooms: those with no members at all whose last activity is
 * older than IDLE_ROOM_TTL_MS. Nothing here can interrupt a live session — a
 * room anyone still belongs to is skipped before any delete, so no one is ever
 * disconnected by this sweep. Returns the deleted room ids.
 *
 * Candidates are drawn by createdAt (present on every doc, including rooms
 * stored before lastActivityAt existed) since a room created after the cutoff
 * cannot possibly have been idle since it; the real idleness test runs
 * per-room below.
 */
export async function sweepIdleRooms(deps: Deps, now: number): Promise<string[]> {
  const cutoff = now - IDLE_ROOM_TTL_MS;
  const candidates = await deps.store.rooms.findMany(
    { createdAt: { $lte: cutoff } },
    { sort: [['createdAt', 1]], limit: IDLE_SWEEP_BATCH },
  );
  const deleted: string[] = [];
  for (const room of candidates) {
    try {
      // Anyone in the room — connected right now or simply still a member —
      // keeps it alive, however long the room has been quiet. Banned rows are
      // not "anyone": they must not pin a dead room forever.
      const memberCount = await deps.store.members.count({ roomId: room.id, banned: false });
      if (memberCount > 0) {
        continue;
      }
      // Legacy docs predate lastActivityAt; createdAt is the honest floor.
      const lastActivityAt = room.lastActivityAt ?? room.createdAt;
      if (lastActivityAt > cutoff) {
        continue;
      }
      await deps.store.members.deleteMany({ roomId: room.id });
      await deps.store.invites.deleteMany({ roomId: room.id });
      await deps.store.messages.deleteMany({ roomId: room.id });
      await deps.store.events.deleteMany({ roomId: room.id });
      await deps.store.cursors.deleteMany({ roomId: room.id });
      await deleteRoomHistory(deps, room.id);
      await deps.store.rooms.deleteOne({ id: room.id });
      deleted.push(room.id);
    } catch (err) {
      deps.log.warn({ err, roomId: room.id }, 'idle room sweep failed for room');
    }
  }
  return deleted;
}

/** Hourly: the idle window is 30 days, so minute precision buys nothing. */
export const IDLE_ROOM_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Start the unref'd idle-room sweeper; the returned stop function is
 *  idempotent (same lifecycle contract as the compliance purge sweeper). */
export function startIdleRoomSweeper(deps: Deps): () => void {
  const timer = setInterval(() => {
    sweepIdleRooms(deps, Date.now()).catch((err: unknown) => {
      deps.log.warn({ err }, 'idle room sweep failed');
    });
  }, IDLE_ROOM_SWEEP_INTERVAL_MS);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
