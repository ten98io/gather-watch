/**
 * Rooms ws handlers. Only 'presence.update' lives here:
 * - hub-core already owns 'clock.ping' and all 'webrtc.*' handlers, and
 *   re-registering those throws;
 * - the sync module registered 'sync.claimMaster' first, so that seat is
 *   taken too. The rooms module still ships the CAS-based arbitration in
 *   ./master.ts (server-incremented monotonic epochs, single winner under
 *   races) as the reference implementation + unit-test target; swapping the
 *   ws seat over to it is an orchestrator-level decision recorded in the
 *   worker notes.
 * Handler errors are mapped by the hub to an ephemeral error event on the
 * offending socket.
 */
import type { UserId } from '@gather/contracts';
import { AppError } from '../../lib/errors';
import type { HandlerMap } from '../types';
import { ensureShareLiveness } from '../restream/service';
import { getRoomsRuntime } from './runtime';

export const roomsWsHandlers: HandlerMap = {
  'presence.update': async (event, ctx) => {
    const room = await ctx.deps.store.rooms.findById(ctx.roomId);
    if (room === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    // The instance that owns a member's socket is the one that will DROP their
    // presence entry, and that instance need never have handled a
    // restream.start — so the share reaper is wired from here, where every
    // instance passes. Idempotent per Deps.
    ensureShareLiveness(ctx.deps);
    const { presence } = getRoomsRuntime(ctx.deps);
    if (event.payload.state === 'offline') {
      await presence.removeUser(ctx.roomId, ctx.auth.userId);
      return;
    }
    // room.kind is vestigial and no longer drives the default: clients set
    // watching/listening themselves from what is playing.
    const defaultState = 'watching';
    const { state, micOn, camOn, sharing } = event.payload;
    // An empty heartbeat doubles as a roster request, so a client whose
    // socket reconnected while its entry was still alive can re-sync. It is a
    // WEAK signal — no client in the monorepo sends one, and it cannot be
    // told apart from a no-op beat — so `wantSnapshot` is the real door.
    const wantsSnapshot =
      state === undefined && micOn === undefined && camOn === undefined && sharing === undefined;
    // Pass ONLY defined payload fields — exactOptionalPropertyTypes forbids
    // writing an explicit undefined over the tracker defaults.
    const { created } = await presence.heartbeat(
      ctx.roomId,
      ctx.auth.userId,
      {
        ...(state !== undefined ? { state } : {}),
        ...(micOn !== undefined ? { micOn } : {}),
        ...(camOn !== undefined ? { camOn } : {}),
        ...(sharing !== undefined ? { sharing } : {}),
      },
      defaultState,
    );
    if (created || wantsSnapshot || event.payload.wantSnapshot === true) {
      // Late joiner, or a client that asked (`wantSnapshot`): reply the full
      // roster to THIS socket — everyone else already received the diff.
      //
      // The explicit ask is what makes a REFRESH work. A reload takes 1-5s,
      // well inside the 15s disconnect grace and the 45s TTL, so the presence
      // entry survives and `created` is false; without the flag this branch
      // never ran and the reloaded tab kept initialRoomState() forever —
      // empty queue, null playback, empty roster, no restream.
      //
      // Playback and queue snapshots ride along: event replay is
      // ascending-from-`since` and capped, so in a long-lived room the latest
      // sync.state is NOT guaranteed within the first replay page — this is
      // the reliable path to the current position.
      // Re-read: `room` above is a pre-await CLONE (memory store) and the
      // heartbeat awaits a bus publish, so a mutation that raced the ask is
      // already missing from it. This narrows the window to zero on one
      // instance; across instances the clients' own version/seq guards are
      // what keep a stale reply from clobbering a newer broadcast.
      const fresh = (await ctx.deps.store.rooms.findById(ctx.roomId)) ?? room;
      ctx.reply('presence.state', { entries: presence.entries(ctx.roomId) });
      if (fresh.playback !== null) {
        ctx.reply('sync.state', fresh.playback);
      }
      ctx.reply('queue.state', { items: fresh.queue.items, version: fresh.queue.version });
      // A late joiner must land on the share, not on an empty stage; the
      // restream module owns transitions, this is only the snapshot. Sent
      // whenever it EXISTS, active or not — a reconnect whose share stopped
      // during the outage needs the stage turned off, and the whole reason
      // for this reply is that replay is capped and cannot be relied on.
      if (fresh.restream !== null) {
        ctx.reply('restream.state', fresh.restream);
      }
      // The master seat rides along too. It is deliberately NOT part of
      // serializeRoom (RoomDoc's realtime snapshots never leak through the
      // Room entity), so this reply is the ONLY way a joining or reloading
      // client learns who holds it. Without it every client read master as
      // null, computed a losing epoch, and the seat stayed claimable exactly
      // once per room — which silently made auto-advance inert for everyone
      // who was not the original claimant.
      if (fresh.master !== null) {
        ctx.reply('sync.masterChanged', {
          masterUserId: fresh.master.userId as UserId,
          epoch: fresh.master.epoch,
        });
      }
    }
  },
};
