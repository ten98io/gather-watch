/**
 * Room playback history — the replacement for the (server-less) library.
 *
 * What is under test is the whole loop, not just the store write: a track
 * change lands one row, the room's members can read it and nobody else can,
 * a row carries enough to put the thing back in the queue, and the rows do
 * not accumulate forever (per-room cap, plus the same cascade that already
 * reclaims an abandoned room's messages and events).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { QueueItemInput } from '@gather/contracts';
import type { QueueItem, QueueItemId, RoomId, UserId } from '@gather/contracts';
import type { FastifyInstance } from 'fastify';
import {
  HISTORY_KEEP_PER_ROOM,
  historyEntryToQueueInput,
  recordPlayback,
  serializeHistoryEntry,
} from '../src/modules/rooms/history';
import { IDLE_ROOM_TTL_MS, sweepIdleRooms } from '../src/modules/rooms/service';
import { QueueService } from '../src/modules/queue/service';
import { SyncService } from '../src/modules/sync/service';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';
import type { TestApp } from './helpers';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function newApp(): Promise<TestApp> {
  const app = await makeApp();
  apps.push(app.app);
  return app;
}

function queueItem(id: string, addedBy: string, title: string): QueueItem {
  return {
    id: id as QueueItemId,
    mediaRef: { kind: 'youtube', videoId: `vid-${id}` },
    title,
    durationMs: 210_000,
    artworkUrl: 'https://img.example.com/a.jpg',
    addedBy: addedBy as UserId,
    votesToSkip: [],
  };
}

/** Seed a room whose queue already holds `items` (the client adds them; this
 *  skips straight to the state a setTrack would find). */
async function seedRoomWithQueue(
  app: TestApp,
  items: QueueItem[],
): Promise<{ roomId: RoomId; ownerId: UserId }> {
  const { roomId, ownerId } = await seedRoom(app.store);
  await app.store.rooms.updateOne({ id: roomId }, { queue: { items, version: items.length } });
  return { roomId, ownerId };
}

describe('recording what the room played', () => {
  it('records a queue track with its title and who queued it', async () => {
    const app = await newApp();
    const other = 'u-queuer' as UserId;
    const { roomId, ownerId } = await seedRoomWithQueue(app, [
      queueItem('a', other, 'Chasing Cars'),
    ]);
    await addMember(app.store, roomId, other, 'member');

    const sync = new SyncService(app.app.deps);
    await sync.setTrack(roomId, ownerId, { kind: 'queue', queueIndex: 0 });

    const rows = await app.store.playbackHistory.findMany({ roomId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      roomId,
      title: 'Chasing Cars',
      mediaRef: { kind: 'youtube', videoId: 'vid-a' },
      durationMs: 210_000,
      // who put it in the queue, and who pressed play — different people here
      queuedBy: other,
      startedBy: ownerId,
    });
  });

  it('does not record play/pause/seek, only a track change', async () => {
    const app = await newApp();
    const { roomId, ownerId } = await seedRoomWithQueue(app, [
      queueItem('a', 'u-queuer', 'Chasing Cars'),
    ]);
    const sync = new SyncService(app.app.deps);

    await sync.setTrack(roomId, ownerId, { kind: 'queue', queueIndex: 0 });
    await sync.pause(roomId, ownerId, { positionMs: 5_000 });
    await sync.play(roomId, ownerId, { positionMs: 5_000 });
    await sync.seek(roomId, ownerId, { positionMs: 60_000 });

    expect(await app.store.playbackHistory.count({ roomId })).toBe(1);
  });

  it('does not record the same track twice in a row', async () => {
    const app = await newApp();
    const { roomId, ownerId } = await seedRoomWithQueue(app, [
      queueItem('a', 'u-queuer', 'Chasing Cars'),
      queueItem('b', 'u-queuer', 'Run'),
    ]);
    const sync = new SyncService(app.app.deps);

    await sync.setTrack(roomId, ownerId, { kind: 'queue', queueIndex: 0 });
    await sync.setTrack(roomId, ownerId, { kind: 'queue', queueIndex: 0 });
    await sync.setTrack(roomId, ownerId, { kind: 'queue', queueIndex: 1 });
    // …and back to the first: a real replay, so it earns a second row.
    await sync.setTrack(roomId, ownerId, { kind: 'queue', queueIndex: 0 });

    const rows = await app.store.playbackHistory.findMany({ roomId }, { sort: [['seq', 1]] });
    expect(rows.map((r) => r.title)).toEqual(['Chasing Cars', 'Run', 'Chasing Cars']);
  });

  it('records a direct setTrack (no queue row) under the person who set it', async () => {
    const app = await newApp();
    const { roomId, ownerId } = await seedRoomWithQueue(app, []);
    const sync = new SyncService(app.app.deps);

    await sync.setTrack(roomId, ownerId, {
      kind: 'media',
      mediaRef: { kind: 'page', url: 'https://example.com/watch' },
    });

    const rows = await app.store.playbackHistory.findMany({ roomId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queuedBy).toBe(ownerId);
    expect(rows[0]?.startedBy).toBe(ownerId);
    // Nothing named it, so the entry says so rather than inventing a title.
    expect(rows[0]?.title).toBe('Untitled');
  });
});

describe('GET /rooms/:roomId/history', () => {
  it('serves the room history to a member, newest first', async () => {
    const app = await newApp();
    const { user, accessToken } = await signupUser(app.app, 'host@example.com');
    const { roomId } = await seedRoomWithQueue(app, [
      queueItem('a', user.id, 'First'),
      queueItem('b', user.id, 'Second'),
    ]);
    await addMember(app.store, roomId, user.id, 'host');

    const sync = new SyncService(app.app.deps);
    await sync.setTrack(roomId, user.id, { kind: 'queue', queueIndex: 0 });
    await sync.setTrack(roomId, user.id, { kind: 'queue', queueIndex: 1 });

    const res = await app.app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/history`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: Array<{ title: string }>; nextBefore: number | null };
    expect(body.entries.map((e) => e.title)).toEqual(['Second', 'First']);
    expect(body.nextBefore).toBeNull();
  });

  it('pages backwards with the `before` cursor', async () => {
    const app = await newApp();
    const { user, accessToken } = await signupUser(app.app, 'host@example.com');
    const { roomId } = await seedRoomWithQueue(app, [
      queueItem('a', user.id, 'First'),
      queueItem('b', user.id, 'Second'),
      queueItem('c', user.id, 'Third'),
    ]);
    await addMember(app.store, roomId, user.id, 'host');

    const sync = new SyncService(app.app.deps);
    for (const i of [0, 1, 2]) {
      await sync.setTrack(roomId, user.id, { kind: 'queue', queueIndex: i });
    }

    const first = await app.app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/history?limit=2`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const page1 = first.json() as {
      entries: Array<{ title: string }>;
      nextBefore: number | null;
    };
    expect(page1.entries.map((e) => e.title)).toEqual(['Third', 'Second']);
    expect(page1.nextBefore).not.toBeNull();

    const second = await app.app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/history?limit=2&before=${String(page1.nextBefore)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const page2 = second.json() as {
      entries: Array<{ title: string }>;
      nextBefore: number | null;
    };
    expect(page2.entries.map((e) => e.title)).toEqual(['First']);
    expect(page2.nextBefore).toBeNull();
  });

  it('refuses a signed-in non-member', async () => {
    const app = await newApp();
    const { user } = await signupUser(app.app, 'host@example.com');
    const outsider = await signupUser(app.app, 'nosy@example.com');
    const { roomId } = await seedRoomWithQueue(app, [queueItem('a', user.id, 'First')]);
    await addMember(app.store, roomId, user.id, 'host');
    const sync = new SyncService(app.app.deps);
    await sync.setTrack(roomId, user.id, { kind: 'queue', queueIndex: 0 });

    const res = await app.app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/history`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    // The refusal must not leak what is in there.
    expect(res.body).not.toContain('First');
  });

  it('refuses an unauthenticated caller', async () => {
    const app = await newApp();
    const { roomId } = await seedRoomWithQueue(app, []);
    const res = await app.app.inject({ method: 'GET', url: `/rooms/${roomId}/history` });
    expect(res.statusCode).toBe(401);
  });
});

describe('re-queueing from history', () => {
  it('an entry carries a valid queue add, and the item comes back', async () => {
    const app = await newApp();
    const other = 'u-queuer' as UserId;
    const { roomId, ownerId } = await seedRoomWithQueue(app, [
      queueItem('a', other, 'Chasing Cars'),
    ]);
    const sync = new SyncService(app.app.deps);
    await sync.setTrack(roomId, ownerId, { kind: 'queue', queueIndex: 0 });
    // The queue moves on — the row is gone, the history is all that is left.
    await app.store.rooms.updateOne({ id: roomId }, { queue: { items: [], version: 2 } });

    const row = (await app.store.playbackHistory.findMany({ roomId }))[0];
    expect(row).toBeDefined();
    const input = QueueItemInput.parse(historyEntryToQueueInput(serializeHistoryEntry(row!)));

    await new QueueService(app.app.deps).add(roomId, ownerId, input);
    const room = await app.store.rooms.findById(roomId);
    expect(room?.queue.items).toHaveLength(1);
    expect(room?.queue.items[0]).toMatchObject({
      title: 'Chasing Cars',
      mediaRef: { kind: 'youtube', videoId: 'vid-a' },
      // re-queued BY the person who re-queued it, not the original queuer
      addedBy: ownerId,
    });
  });
});

describe('retention', () => {
  it('keeps only the newest HISTORY_KEEP_PER_ROOM rows', async () => {
    const app = await newApp();
    const { roomId, ownerId } = await seedRoomWithQueue(app, []);

    for (let i = 0; i < HISTORY_KEEP_PER_ROOM + 5; i += 1) {
      await recordPlayback(app.app.deps, {
        roomId,
        mediaRef: { kind: 'youtube', videoId: `vid-${String(i)}` },
        title: `Track ${String(i)}`,
        artworkUrl: null,
        durationMs: null,
        queuedBy: ownerId,
        startedBy: ownerId,
      });
    }

    const rows = await app.store.playbackHistory.findMany({ roomId }, { sort: [['seq', 1]] });
    expect(rows).toHaveLength(HISTORY_KEEP_PER_ROOM);
    // The five oldest went, the newest stayed.
    expect(rows[0]?.title).toBe('Track 5');
    expect(rows[rows.length - 1]?.title).toBe(`Track ${String(HISTORY_KEEP_PER_ROOM + 4)}`);
  });

  it('goes with the room when the idle sweeper reclaims it', async () => {
    const app = await newApp();
    const { roomId, ownerId } = await seedRoomWithQueue(app, []);
    await recordPlayback(app.app.deps, {
      roomId,
      mediaRef: { kind: 'youtube', videoId: 'vid-a' },
      title: 'Chasing Cars',
      artworkUrl: null,
      durationMs: null,
      queuedBy: ownerId,
      startedBy: ownerId,
    });
    expect(await app.store.playbackHistory.count({ roomId })).toBe(1);

    // Abandoned: nobody is a member any more and the room went quiet long ago.
    await app.store.members.deleteMany({ roomId });
    const old = Date.now() - IDLE_ROOM_TTL_MS - 1;
    await app.store.rooms.updateOne({ id: roomId }, { createdAt: old, lastActivityAt: old });

    const deleted = await sweepIdleRooms(app.app.deps, Date.now());
    expect(deleted).toContain(roomId);
    expect(await app.store.playbackHistory.count({ roomId })).toBe(0);
  });

  it('goes with the room when the host deletes it', async () => {
    const app = await newApp();
    const { user, accessToken } = await signupUser(app.app, 'host@example.com');
    const { roomId } = await seedRoomWithQueue(app, []);
    await addMember(app.store, roomId, user.id, 'host');
    await recordPlayback(app.app.deps, {
      roomId,
      mediaRef: { kind: 'youtube', videoId: 'vid-a' },
      title: 'Chasing Cars',
      artworkUrl: null,
      durationMs: null,
      queuedBy: user.id,
      startedBy: user.id,
    });

    const res = await app.app.inject({
      method: 'DELETE',
      url: `/rooms/${roomId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(await app.store.playbackHistory.count({ roomId })).toBe(0);
  });
});
