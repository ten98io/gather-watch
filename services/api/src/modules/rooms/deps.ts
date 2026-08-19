/**
 * Cross-module seams owned by the rooms module: the rooms control-plane bus
 * channel used for presence-heartbeat mirrors and forced disconnects.
 *
 * There is no entitlements seam here any more. Gather gives every account the
 * whole product, so nothing looks a user's capabilities up — the limits that
 * remain are physics (mesh fan-out) or abuse ceilings, and each is enforced
 * where it applies rather than resolved from an account tier.
 */
import type { PresenceEntry } from '@gather/contracts';

/** Rooms control-plane bus channel (presence heartbeats mirror + forced
 *  disconnects), separate from roomChannel() which carries client frames. */
export function roomCtlChannel(roomId: string): string {
  return `roomctl:${roomId}`;
}

/**
 * `from` is a random per-publisher origin id so subscribers can skip their
 * own loopback messages (the bus delivers to the publishing instance too).
 *
 * 'sync'/'state' are the ROSTER HANDSHAKE, and they exist because subscribing
 * to this channel is not the same as knowing who is in the room: an instance
 * picking a room up hears nothing until somebody else's client happens to
 * beat, so until then its answer to "who is here" is whoever it owns a socket
 * for — one person, in a room full of them. A joiner saw a roster of one; a
 * skip vote divided by one; `sync.advance` concluded nobody privileged was
 * present and waived its clock check. 'sync' ASKS for the rest of the room
 * instead of waiting for it, and every instance holding the room answers with
 * a 'state' addressed (`to`) to the asker, carrying the entries it owns.
 */
export type RoomCtlMessage =
  | { kind: 'hb'; roomId: string; entry: PresenceEntry; from: string }
  | { kind: 'bye'; roomId: string; userId: string; from: string }
  | { kind: 'kick'; roomId: string; userId: string; from: string }
  | { kind: 'sync'; roomId: string; from: string }
  | { kind: 'state'; roomId: string; entries: PresenceEntry[]; from: string; to: string };
