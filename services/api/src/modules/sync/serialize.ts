/**
 * RoomDoc → contracts Room serialization. RoomDoc carries server-only
 * realtime snapshots (playback/queue/restream/master) that must never leave
 * the server, so every outbound room shape goes through this picker.
 */
import type { Room } from '@playin/contracts';
import type { RoomDoc } from '../../adapters/ports';

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
    createdAt: room.createdAt,
  };
}
