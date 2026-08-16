/**
 * Room/member serializers. Every REST response and every persisted
 * room.updated / member.updated event passes through these, so RoomDoc's
 * server-only realtime snapshots (playback/queue/restream/master) and
 * MemberDoc's internal fields (id, per-room mute) can never leak to clients.
 */
import type { Member, Room } from '@gather/contracts';
import type { MemberDoc, RoomDoc } from '../../adapters/ports';

/** Pick ONLY the contracts Room fields — never leak RoomDoc's server-only
 *  realtime snapshots (playback/queue/restream/master). */
export function serializeRoom(room: RoomDoc): Room {
  return {
    id: room.id,
    kind: room.kind,
    name: room.name,
    inviteCode: room.inviteCode,
    ownerId: room.ownerId,
    policies: room.policies,
    relayMode: room.relayMode,
    theater: room.theater,
    expiresAt: room.expiresAt,
    createdAt: room.createdAt,
  };
}

/** Contracts Member — strip the MemberDoc id and the per-room mute flag. */
export function serializeMember(member: MemberDoc): Member {
  return {
    roomId: member.roomId,
    userId: member.userId,
    role: member.role,
    joinedAt: member.joinedAt,
    banned: member.banned,
  };
}
