/**
 * The disconnect grace has to be VISIBLE. Presence used to be binary: a member
 * whose socket vanished looked perfectly fine for the whole 15s grace and then
 * disappeared outright, so a host refresh read to everyone else as "they left"
 * and nobody could tell a two-second blip from a real departure.
 *
 * These tests pin the three moments of the grace on the server side: the first
 * sweep that finds the socket gone says so (an upsert, never a removal), the
 * sweep past the grace removes, and a socket that comes back before expiry
 * restores the entry without anyone ever being removed.
 *
 * The tracker is driven directly with a controllable hub (which userIds have a
 * local socket) and a recording event writer, so a sweep is a function call
 * rather than a wall-clock wait; PresenceTracker.configure() shrinks the
 * timings so the grace fits inside a test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PresenceEntry, RoomId, UserId } from '@gather/contracts';
import { makeApp } from './helpers';
import { PresenceTracker } from '../src/modules/rooms/presence';
import type { Deps } from '../src/modules/types';

const apps: FastifyInstance[] = [];
const trackers: PresenceTracker[] = [];
afterEach(async () => {
  await Promise.all(trackers.splice(0).map((t) => t.close()));
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

interface Diff {
  upserts: PresenceEntry[];
  removed: UserId[];
}

/** The wire entry carries a reachability marker the contract does not name
 *  yet; see the carrier note in src/modules/rooms/presence.ts. */
function connectedOf(entry: PresenceEntry): boolean | undefined {
  return (entry as PresenceEntry & { connected?: boolean }).connected;
}

const GRACE_MS = 100;

interface Harness {
  tracker: PresenceTracker;
  roomId: RoomId;
  userId: UserId;
  /** Sockets the hub reports as live in the room on this instance. */
  online: Set<UserId>;
  /** Every presence.diff broadcast, in order. */
  diffs: Diff[];
}

/** Real store/bus/config/log from the app factory; hub and event writer are
 *  stubs so the test owns "who has a socket" and sees every broadcast. */
async function makeHarness(): Promise<Harness> {
  const built = await makeApp();
  apps.push(built.app);

  const roomId = 'room-grace' as RoomId;
  const userId = 'user-grace' as UserId;
  const online = new Set<UserId>([userId]);
  const diffs: Diff[] = [];

  const deps: Deps = {
    ...built.deps,
    hub: {
      registerModule: () => undefined,
      localUserIds: () => [...online],
      localConnectionCount: () => online.size,
      stats: () => ({ connections: online.size, rooms: 1 }),
      disconnectUser: () => undefined,
      disconnectSession: () => undefined,
    },
    events: {
      emit: built.deps.events.emit,
      emitDirect: () => undefined,
      emitEphemeral: (_roomId, type, payload) => {
        if (type === 'presence.diff') {
          diffs.push(payload as unknown as Diff);
        }
      },
    },
  };

  const tracker = new PresenceTracker(deps);
  trackers.push(tracker);
  // Sweeps are called by hand; the interval must never fire underneath them.
  tracker.configure({ ttlMs: 60_000, sweepMs: 600_000, disconnectGraceMs: GRACE_MS });
  await tracker.heartbeat(roomId, userId, { state: 'watching' }, 'watching');
  diffs.length = 0;

  return { tracker, roomId, userId, online, diffs };
}

describe('presence disconnect grace', () => {
  it('announces the member as unreachable on the first sweep after the socket goes', async () => {
    const h = await makeHarness();
    const t0 = Date.now();

    h.online.delete(h.userId);
    await h.tracker.sweep(t0 + 10);

    expect(h.diffs).toHaveLength(1);
    const diff = h.diffs[0] as Diff;
    expect(diff.removed).toEqual([]);
    expect(diff.upserts.map((e) => e.userId)).toEqual([h.userId]);
    expect(connectedOf(diff.upserts[0] as PresenceEntry)).toBe(false);
    // Still in the room: the grace has not run out.
    expect(h.tracker.entries(h.roomId).map((e) => e.userId)).toEqual([h.userId]);
    // And the visible state is untouched — "unreachable" is not "left".
    expect((diff.upserts[0] as PresenceEntry).state).toBe('watching');
  });

  it('removes the member only once the grace has elapsed, after saying so first', async () => {
    const h = await makeHarness();
    const t0 = Date.now();

    h.online.delete(h.userId);
    await h.tracker.sweep(t0 + 10);
    await h.tracker.sweep(t0 + 10 + GRACE_MS);

    expect(h.diffs).toHaveLength(2);
    expect(connectedOf((h.diffs[0] as Diff).upserts[0] as PresenceEntry)).toBe(false);
    expect((h.diffs[0] as Diff).removed).toEqual([]);
    expect(h.diffs[1]).toEqual({ upserts: [], removed: [h.userId] });
    expect(h.tracker.entries(h.roomId)).toEqual([]);
  });

  it('restores the member when the socket returns before the grace expires', async () => {
    const h = await makeHarness();
    const t0 = Date.now();

    h.online.delete(h.userId);
    await h.tracker.sweep(t0 + 10);
    h.online.add(h.userId);
    await h.tracker.sweep(t0 + 20);
    // A later sweep must not resurrect the removal: the grace was cancelled.
    await h.tracker.sweep(t0 + 20 + GRACE_MS * 3);

    expect(h.diffs.flatMap((d) => d.removed)).toEqual([]);
    expect(h.diffs).toHaveLength(2);
    const restored = (h.diffs[1] as Diff).upserts[0] as PresenceEntry;
    expect(restored.userId).toBe(h.userId);
    expect(connectedOf(restored)).toBe(true);
    expect(restored.state).toBe('watching');
    expect(h.tracker.entries(h.roomId).map((e) => e.userId)).toEqual([h.userId]);
  });
});
