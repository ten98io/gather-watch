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

/**
 * Publish ceiling. RedisBus.publish can hang without ever rejecting (ioredis
 * queues commands while the connection is down, and maxRetriesPerRequest is
 * null), and on the persisted path that await sits INSIDE the per-room emit
 * chain — one unbounded stall would wedge chat, sync, queue and roster for
 * that room permanently, for every instance, until a restart.
 */
const PUBLISH_TIMEOUT_MS = 2_000;

/** Reject-on-expiry wrapper. `work` keeps its own rejection handler so losing
 *  the race never surfaces as an unhandled rejection. */
async function withTimeout(work: Promise<unknown>, label: string): Promise<void> {
  void work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${PUBLISH_TIMEOUT_MS}ms`));
        }, PUBLISH_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
  // roomId → last activity-bump ts (throttle: one store write per room per
  // minute).
  const lastActivityBump = new Map<string, number>();

  /** Stamp room.lastActivityAt. Nothing expires on this timestamp — it is the
   *  signal the idle-room sweeper reads to tell a room someone still uses from
   *  one abandoned months ago. */
  const bumpRoomActivity = (roomId: string): void => {
    const now = Date.now();
    if (now - (lastActivityBump.get(roomId) ?? 0) < 60_000) return;
    lastActivityBump.set(roomId, now);
    void store.rooms
      .updateOne({ id: roomId as RoomId }, { lastActivityAt: now })
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
      const run = async (): Promise<ServerEventOf<T>> => {
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
        // Bounded, and never rethrown. Ordering is preserved because the
        // bounded await still sits inside the chain: seq N's publish is
        // resolved (or given up on) before seq N+1 is even allocated, so
        // publish order matches seq order whenever publishing works at all.
        // A publish that fails is not a lost event — the event is already
        // persisted with its seq, so the next event that DOES arrive shows
        // clients a seq gap and api-client's SeqTracker backfills it over
        // the replay endpoint. Failing the emit instead would tell callers a
        // durable write never happened, and stalling it would wedge the room.
        try {
          await withTimeout(bus.publish(roomChannel(roomId), message), 'bus.publish');
        } catch (err) {
          log.error({ err, roomId, type, seq }, 'event publish failed; clients recover by seq-gap replay');
        }
        return event;
      };
      // Chain off the SETTLEMENT of the previous emit, not its success: a
      // predecessor that rejected (store outage) must not skip the emits
      // queued behind it, which `previous.then(run)` would do silently.
      const next = previous.then(run, run);
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
      // Bounded like the persisted path: an ephemeral publish that hangs is
      // not blocking anyone, but it would also never be reported.
      void withTimeout(bus.publish(roomChannel(roomId), message), 'bus.publish').catch(
        (err: unknown) => {
          log.warn({ err, roomId, type }, 'ephemeral event publish failed');
        },
      );
    },

    emitDirect<T extends ServerEventType>(
      roomId: RoomId,
      targetUserId: UserId,
      type: T,
      payload: ServerPayloadOf<T>,
    ): void {
      const event = envelope(roomId, type, 0, payload);
      const message: RoomBusMessage = { event, targetUserId };
      void withTimeout(bus.publish(roomChannel(roomId), message), 'bus.publish').catch(
        (err: unknown) => {
          log.warn({ err, roomId, type, targetUserId }, 'direct event publish failed');
        },
      );
    },
  };
}
