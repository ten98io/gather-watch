/**
 * QueueService.voteSkip unit tests over faked Deps (no HTTP, no adapters):
 * threshold math (AT the fraction, not beyond), threshold 0 = record-only,
 * threshold 1 = unanimous, and the leaver-tips-threshold regression — when
 * disconnects shrink the active set enough that already-cast votes now meet
 * the fraction, the next vote (even a repeat vote) MUST fire the skip
 * instead of short-circuiting as a no-op forever.
 */
import { describe, expect, it } from 'vitest';
import type { QueueItemId, RoomId, UserId } from '@playin/contracts';
import { memberDocId } from '../../adapters/ports';
import type { Deps } from '../types';
import { QueueService } from './service';

interface FakeRoom {
  id: string;
  policies: Record<string, unknown>;
  queue: { items: FakeItem[]; version: number };
  playback: { queueIndex: number } | null;
}
interface FakeItem {
  id: string;
  mediaRef: { kind: string; url: string; mime: string };
  title: string;
  durationMs: number;
  artworkUrl: null;
  addedBy: string;
  votesToSkip: string[];
}

function makeItem(id: string, votes: string[] = []): FakeItem {
  return {
    id,
    mediaRef: { kind: 'url', url: 'http://media.example/x.mp4', mime: 'video/mp4' },
    title: id,
    durationMs: 60_000,
    artworkUrl: null,
    addedBy: 'someone-else',
    votesToSkip: votes,
  };
}

function makeRoom(items: FakeItem[], policies: Record<string, unknown> = {}): FakeRoom {
  return {
    id: 'r1',
    policies: { skipVoteThreshold: 0.5, voteSkipThreshold: 0.5, queueControl: 'everyone', ...policies },
    queue: { items, version: 0 },
    playback: null,
  };
}

/** Deps stub: room store + presence hub + captured emits. */
function makeDeps(room: FakeRoom, connected: string[]) {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const deps = {
    log: { warn() {}, info() {}, debug() {}, error() {} },
    hub: { localUserIds: () => connected },
    events: {
      emit: async (_roomId: string, type: string, payload: unknown) => {
        emitted.push({ type, payload });
      },
    },
    store: {
      rooms: {
        findById: async () => room,
        updateOne: async (_filter: unknown, patch: Partial<FakeRoom>) => {
          Object.assign(room, patch);
          return room;
        },
      },
      members: {
        findById: async (id: string) => {
          const userId = id.slice(id.indexOf(':') + 1);
          return {
            id: memberDocId(room.id, userId),
            roomId: room.id,
            userId,
            role: 'member',
            banned: false,
            muted: false,
            joinedAt: 0,
          };
        },
      },
    },
  } as unknown as Deps;
  return { deps, emitted };
}

const rid = 'r1' as RoomId;
const iid = (s: string): QueueItemId => s as QueueItemId;
const uid = (s: string): UserId => s as UserId;
const has = (room: FakeRoom, id: string): boolean =>
  room.queue.items.some((item) => item.id === id);

describe('QueueService.voteSkip', () => {
  it('skips AT the threshold, not beyond (0.5 of 4 -> 2 votes)', async () => {
    const room = makeRoom([makeItem('a'), makeItem('b')]);
    const { deps } = makeDeps(room, ['A', 'B', 'C', 'D']);
    const service = new QueueService(deps);

    await service.voteSkip(rid, uid('A'), iid('a'));
    expect(has(room, 'a')).toBe(true); // 1 of required 2

    await service.voteSkip(rid, uid('B'), iid('a'));
    expect(has(room, 'a')).toBe(false); // exactly at ceil(0.5 * 4) = 2
  });

  it('threshold 0 disables removal but still records the vote', async () => {
    const room = makeRoom([makeItem('a')], { skipVoteThreshold: 0 });
    const { deps } = makeDeps(room, ['A', 'B']);
    const service = new QueueService(deps);

    await service.voteSkip(rid, uid('A'), iid('a'));
    const item = room.queue.items.find((it) => it.id === 'a');
    expect(item).toBeDefined();
    expect(item?.votesToSkip).toContain('A');
  });

  it('threshold 1 requires every active member', async () => {
    const room = makeRoom([makeItem('a')], { skipVoteThreshold: 1 });
    const { deps } = makeDeps(room, ['A', 'B', 'C']);
    const service = new QueueService(deps);

    await service.voteSkip(rid, uid('A'), iid('a'));
    await service.voteSkip(rid, uid('B'), iid('a'));
    expect(has(room, 'a')).toBe(true);

    await service.voteSkip(rid, uid('C'), iid('a'));
    expect(has(room, 'a')).toBe(false);
  });

  it('repeat vote with nothing changed and no skip due is a silent no-op', async () => {
    const room = makeRoom([makeItem('a')]);
    const { deps, emitted } = makeDeps(room, ['A', 'B', 'C', 'D']);
    const service = new QueueService(deps);

    await service.voteSkip(rid, uid('A'), iid('a'));
    const versionAfterFirst = room.queue.version;
    const emitsAfterFirst = emitted.length;

    await service.voteSkip(rid, uid('A'), iid('a')); // repeat, still below threshold
    expect(room.queue.version).toBe(versionAfterFirst);
    expect(emitted.length).toBe(emitsAfterFirst);
  });

  it('REGRESSION: leavers tipping the fraction fire the skip on the next (repeat) vote', async () => {
    // Votes were cast as [A, B] when C was still connected (0.67 of 3 needs 3).
    // C leaves: 0.67 of the remaining 2 needs ceil(1.34) = 2 — already met.
    // A repeat vote by A must now fire the skip rather than no-op forever.
    const room = makeRoom([makeItem('a', ['A', 'B'])], { skipVoteThreshold: 0.67 });
    const { deps } = makeDeps(room, ['A', 'B']);
    const service = new QueueService(deps);

    await service.voteSkip(rid, uid('A'), iid('a'));
    expect(has(room, 'a')).toBe(false);
  });
});
