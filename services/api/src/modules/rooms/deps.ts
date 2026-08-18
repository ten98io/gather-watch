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

/** `from` is a random per-publisher origin id so subscribers can skip their
 *  own loopback messages (the bus delivers to the publishing instance too). */
export type RoomCtlMessage =
  | { kind: 'hb'; roomId: string; entry: PresenceEntry; from: string }
  | { kind: 'bye'; roomId: string; userId: string; from: string }
  | { kind: 'kick'; roomId: string; userId: string; from: string };
