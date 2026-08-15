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
import { AppError } from '../../lib/errors';
import type { HandlerMap } from '../types';
import { getRoomsRuntime } from './runtime';

export const roomsWsHandlers: HandlerMap = {
  'presence.update': async (event, ctx) => {
    const room = await ctx.deps.store.rooms.findById(ctx.roomId);
    if (room === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    const { presence } = getRoomsRuntime(ctx.deps);
    if (event.payload.state === 'offline') {
      await presence.removeUser(ctx.roomId, ctx.auth.userId);
      return;
    }
    const defaultState = room.kind === 'watch' ? 'watching' : 'listening';
    const { state, micOn, camOn, sharing } = event.payload;
    // An empty heartbeat doubles as a roster request, so a client whose
    // socket reconnected while its entry was still alive can re-sync.
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
    if (created || wantsSnapshot) {
      // Late joiner (or explicit snapshot request): reply the full roster to
      // THIS socket — everyone else already received the diff. Playback and
      // queue snapshots ride along: event replay is ascending-from-`since`
      // and capped, so in a long-lived room the latest sync.state is NOT
      // guaranteed within the first replay page — this is the reliable path
      // to the current position for a joiner.
      ctx.reply('presence.state', { entries: presence.entries(ctx.roomId) });
      if (room.playback !== null) {
        ctx.reply('sync.state', room.playback);
      }
      ctx.reply('queue.state', { items: room.queue.items, version: room.queue.version });
    }
  },
};
