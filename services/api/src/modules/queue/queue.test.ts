/**
 * QueueService unit tests over faked Deps (no HTTP, no adapters):
 *
 *  • voteSkip — threshold math (AT the fraction, not beyond), threshold 0 =
 *    record-only, threshold 1 = unanimous, and the leaver-tips-threshold
 *    regression: when departures shrink the present set enough that
 *    already-cast votes now meet the fraction, the next vote (even a repeat
 *    vote) MUST fire the skip instead of short-circuiting as a no-op forever.
 *  • add — the client's metadata is a sanitized HINT stored immediately, and
 *    the resolved metadata is patched in afterwards with a second broadcast.
 */
import { describe, expect, it } from 'vitest';
import type { MediaRef, QueueItemId, ResolvedMedia, RoomId, UserId } from '@gather/contracts';
import { memberDocId } from '../../adapters/ports';
import type { Deps } from '../types';
import { registerMetadataResolver } from '../metadata/resolver';
import { getRoomsRuntime } from '../rooms/runtime';
import { QueueService } from './service';

interface FakeRoom {
  id: string;
  policies: Record<string, unknown>;
  queue: { items: FakeItem[]; version: number };
  playback: { queueIndex: number } | null;
}
interface FakeItem {
  id: string;
  mediaRef: { kind: string; url?: string; mime?: string; videoId?: string };
  title: string;
  durationMs: number | null;
  artworkUrl: string | null;
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
    policies: { skipVoteThreshold: 0.5, queueControl: 'everyone', ...policies },
    queue: { items, version: 0 },
    playback: null,
  };
}

/**
 * Deps stub: room store + captured emits, with the room's PRESENCE seeded.
 *
 * Presence and not sockets, deliberately. voteSkip's denominator is the room,
 * not this process's connections — a stub that only answered
 * `hub.localUserIds` would go on passing while the real threshold halved
 * across a two-instance deploy. The tracker here is the real one, driven
 * through heartbeat() exactly as a client's presence.update drives it.
 */
async function makeDeps(room: FakeRoom, present: string[]) {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const deps = {
    log: { warn() {}, info() {}, debug() {}, error() {} },
    hub: { localUserIds: () => present },
    bus: {
      publish: async () => undefined,
      subscribe: async () => async () => undefined,
    },
    events: {
      emit: async (_roomId: string, type: string, payload: unknown) => {
        emitted.push({ type, payload });
      },
      emitEphemeral: () => undefined,
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
  const { presence } = getRoomsRuntime(deps);
  for (const userId of present) {
    await presence.heartbeat(room.id as RoomId, userId as UserId, {}, 'watching');
  }
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
    const { deps } = await makeDeps(room, ['A', 'B', 'C', 'D']);
    const service = new QueueService(deps);

    await service.voteSkip(rid, uid('A'), iid('a'));
    expect(has(room, 'a')).toBe(true); // 1 of required 2

    await service.voteSkip(rid, uid('B'), iid('a'));
    expect(has(room, 'a')).toBe(false); // exactly at ceil(0.5 * 4) = 2
  });

  it('threshold 0 disables removal but still records the vote', async () => {
    const room = makeRoom([makeItem('a')], { skipVoteThreshold: 0 });
    const { deps } = await makeDeps(room, ['A', 'B']);
    const service = new QueueService(deps);

    await service.voteSkip(rid, uid('A'), iid('a'));
    const item = room.queue.items.find((it) => it.id === 'a');
    expect(item).toBeDefined();
    expect(item?.votesToSkip).toContain('A');
  });

  it('threshold 1 requires every active member', async () => {
    const room = makeRoom([makeItem('a')], { skipVoteThreshold: 1 });
    const { deps } = await makeDeps(room, ['A', 'B', 'C']);
    const service = new QueueService(deps);

    await service.voteSkip(rid, uid('A'), iid('a'));
    await service.voteSkip(rid, uid('B'), iid('a'));
    expect(has(room, 'a')).toBe(true);

    await service.voteSkip(rid, uid('C'), iid('a'));
    expect(has(room, 'a')).toBe(false);
  });

  it('repeat vote with nothing changed and no skip due is a silent no-op', async () => {
    const room = makeRoom([makeItem('a')]);
    const { deps, emitted } = await makeDeps(room, ['A', 'B', 'C', 'D']);
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
    const { deps } = await makeDeps(room, ['A', 'B']);
    const service = new QueueService(deps);

    await service.voteSkip(rid, uid('A'), iid('a'));
    expect(has(room, 'a')).toBe(false);
  });
});

// ── add + background metadata enrichment ─────────────────────────────────────

const YT_REF: MediaRef = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' };

function resolved(patch: Partial<ResolvedMedia> = {}): ResolvedMedia {
  return {
    title: 'Rick Astley - Never Gonna Give You Up',
    artworkUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    durationMs: 213_000,
    providerId: 'youtube',
    providerName: 'YouTube',
    authorName: 'Rick Astley',
    canonicalId: 'dQw4w9WgXcQ',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    source: 'provider',
    ...patch,
  };
}

describe('QueueService.add metadata', () => {
  it('enqueues the hint immediately, then patches in resolved metadata and re-broadcasts', async () => {
    const room = makeRoom([]);
    const { deps, emitted } = await makeDeps(room, ['A']);
    registerMetadataResolver(deps, { resolve: async () => resolved() });
    const service = new QueueService(deps);

    await service.add(rid, uid('A'), {
      mediaRef: YT_REF,
      title: 'YouTube video',
      durationMs: null,
      artworkUrl: null,
    });

    // The add itself never waits on the lookup: v1 is already stored + sent.
    expect(room.queue.items).toHaveLength(1);
    expect(room.queue.items[0]?.title).toBe('YouTube video');
    expect(room.queue.version).toBe(1);
    expect(emitted).toHaveLength(1);

    await service.settleEnrichment();

    expect(room.queue.items[0]?.title).toBe('Rick Astley - Never Gonna Give You Up');
    expect(room.queue.items[0]?.artworkUrl).toBe(
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    );
    expect(room.queue.items[0]?.durationMs).toBe(213_000);
    expect(room.queue.version).toBe(2);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.type).toBe('queue.state');
  });

  it('sanitizes the client hint before it is ever stored', async () => {
    const room = makeRoom([]);
    const { deps } = await makeDeps(room, ['A']);
    registerMetadataResolver(deps, { resolve: async () => null });
    const service = new QueueService(deps);

    await service.add(rid, uid('A'), {
      mediaRef: YT_REF,
      title: '  Spaced     out  ',
      durationMs: 999 * 60 * 60 * 1000, // absurd
      artworkUrl: 'http://insecure.example/a.jpg', // mixed content
    });

    expect(room.queue.items[0]?.title).toBe('Spaced out');
    expect(room.queue.items[0]?.durationMs).toBeNull();
    expect(room.queue.items[0]?.artworkUrl).toBeNull();
  });

  it('leaves the item untouched when nothing could be fetched', async () => {
    const room = makeRoom([]);
    const { deps, emitted } = await makeDeps(room, ['A']);
    registerMetadataResolver(deps, {
      resolve: async () => resolved({ source: 'link', title: 'derived from the link' }),
    });
    const service = new QueueService(deps);

    await service.add(rid, uid('A'), {
      mediaRef: YT_REF,
      title: 'YouTube video',
      durationMs: null,
      artworkUrl: null,
    });
    await service.settleEnrichment();

    expect(room.queue.items[0]?.title).toBe('YouTube video');
    expect(room.queue.version).toBe(1);
    expect(emitted).toHaveLength(1); // no second broadcast
  });

  it('never resurrects an item removed while the lookup was in flight', async () => {
    const room = makeRoom([]);
    const { deps, emitted } = await makeDeps(room, ['A']);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerMetadataResolver(deps, {
      resolve: async () => {
        await gate;
        return resolved();
      },
    });
    const service = new QueueService(deps);

    await service.add(rid, uid('A'), {
      mediaRef: YT_REF,
      title: 'YouTube video',
      durationMs: null,
      artworkUrl: null,
    });
    const added = room.queue.items[0];
    expect(added).toBeDefined();
    await service.remove(rid, uid('A'), iid(added?.id ?? ''));
    expect(room.queue.items).toHaveLength(0);

    release();
    await service.settleEnrichment();

    expect(room.queue.items).toHaveLength(0);
    expect(emitted).toHaveLength(2); // the add and the remove, nothing else
  });

  it('swallows a resolver failure — a provider outage never breaks an add', async () => {
    const room = makeRoom([]);
    const { deps, emitted } = await makeDeps(room, ['A']);
    registerMetadataResolver(deps, {
      resolve: async () => {
        throw new Error('provider exploded');
      },
    });
    const service = new QueueService(deps);

    await service.add(rid, uid('A'), {
      mediaRef: YT_REF,
      title: 'YouTube video',
      durationMs: null,
      artworkUrl: null,
    });
    await service.settleEnrichment();

    expect(room.queue.items).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });
});

