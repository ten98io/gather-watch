/**
 * The one writer for server events. Persisted events get a per-room monotonic
 * seq (store.nextSeq) and are fanned out on the room bus channel; ephemeral
 * and direct events skip persistence with seq 0 (clients treat seq 0 as
 * gap-free). Per-room emits are serialized through a promise chain so publish
 * order matches seq order on this instance.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { RoomId, UserId } from '@gather/contracts';
import type { BusPort, StorePort } from '../adapters/ports';
import { eventDocId, roomChannel } from '../adapters/ports';
import type { RoomBusMessage } from '../adapters/ports';
import type {
  EventWriter,
  ServerEventOf,
  ServerEventType,
  ServerPayloadOf,
} from '../modules/types';
import { FREE_ROOM_TTL_MS } from '../modules/rooms/service';

/** Build a server envelope. The generic cast is safe: ServerPayloadOf<T> is
 *  exactly the payload of ServerEventOf<T> by construction. */
function envelope<T extends ServerEventType>(
  roomId: RoomId,
  type: T,
  seq: number,
  payload: ServerPayloadOf<T>,
): ServerEventOf<T> {
  return { type, roomId, seq, ts: Date.now(), payload } as ServerEventOf<T>;
}

/**
 * EventWriter backed by the store/bus ports. See src/modules/types.ts for the
 * contract this implements.
 */
export function createEventWriter(deps: {
  store: StorePort;
  bus: BusPort;
  log: FastifyBaseLogger;
}): EventWriter {
  const { store, bus, log } = deps;
  // roomId → tail of the per-room emit chain.
  const chains = new Map<string, Promise<unknown>>();
  // roomId → last activity-bump ts (free-plan room TTL resets on activity,
  // throttled to one store write per room per minute).
  const lastActivityBump = new Map<string, number>();

  const bumpRoomActivity = (roomId: string): void => {
    const now = Date.now();
    if (now - (lastActivityBump.get(roomId) ?? 0) < 60_000) return;
    lastActivityBump.set(roomId, now);
    void store.rooms
      .updateOne(
        { id: roomId as RoomId, expiresAt: { $ne: null } },
        { expiresAt: now + FREE_ROOM_TTL_MS },
      )
      .catch((err: unknown) => {
        log.warn({ err, roomId }, 'room activity bump failed');
      });
  };

  return {
    async emit<T extends ServerEventType>(
      roomId: RoomId,
      type: T,
      payload: ServerPayloadOf<T>,
    ): Promise<ServerEventOf<T>> {
      const previous = chains.get(roomId) ?? Promise.resolve();
      const next = previous.then(async (): Promise<ServerEventOf<T>> => {
        const seq = await store.nextSeq(`room:${roomId}`);
        const event = envelope(roomId, type, seq, payload);
        await store.events.insertOne({
          id: eventDocId(roomId, seq),
          roomId,
          seq,
          type,
          ts: event.ts,
          payload,
        });
        bumpRoomActivity(roomId);
        const message: RoomBusMessage = { event, targetUserId: null };
        await bus.publish(roomChannel(roomId), message);
        return event;
      });
      chains.set(roomId, next);
      // Drop the chain entry once it settles, unless a newer emit has already
      // extended it.
      const cleanup = (): void => {
        if (chains.get(roomId) === next) {
          chains.delete(roomId);
        }
      };
      void next.then(cleanup, cleanup);
      return next;
    },

    emitEphemeral<T extends ServerEventType>(
      roomId: RoomId,
      type: T,
      payload: ServerPayloadOf<T>,
    ): void {
      const event = envelope(roomId, type, 0, payload);
      const message: RoomBusMessage = { event, targetUserId: null };
      void bus.publish(roomChannel(roomId), message).catch((err: unknown) => {
        log.warn({ err, roomId, type }, 'ephemeral event publish failed');
      });
    },

    emitDirect<T extends ServerEventType>(
      roomId: RoomId,
      targetUserId: UserId,
      type: T,
      payload: ServerPayloadOf<T>,
    ): void {
      const event = envelope(roomId, type, 0, payload);
      const message: RoomBusMessage = { event, targetUserId };
      void bus.publish(roomChannel(roomId), message).catch((err: unknown) => {
        log.warn({ err, roomId, type, targetUserId }, 'direct event publish failed');
      });
    },
  };
}
