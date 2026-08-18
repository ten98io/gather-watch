/**
 * THE ROOM DOCUMENT IS BOUNDED AS A WHOLE, not one field at a time.
 *
 * queue-bounds.test.ts pins the queue's own two halves (the item COUNT and the
 * size of one item's mediaRef). Both were enforced on exactly one door —
 * `QueueService.add` — and the room document has three:
 *
 *   1. `sync.setTrack { kind: 'media' }` writes a client-supplied MediaRef
 *      straight onto `room.playback`, and from there into a PERSISTED event, a
 *      usage row and the room's playback history. `z.string().url()` has no
 *      length ceiling, so one frame could carry a megabyte and be replayed to
 *      every member forever after.
 *   2. the playlist→queue copy in queue/routes.ts checked the item COUNT and
 *      each mediaRef but copied `artworkUrl` through untouched — and
 *      `QueueItem.artworkUrl` is `WebUrl`, unbounded. 500 items × a megabyte
 *      of artwork is the same 16 MB wall by a different road.
 *   3. `PATCH /playlists/:id` is where that artwork gets in.
 *
 * The wall matters because nothing degrades gracefully at it: past Mongo's
 * 16 MB document limit EVERY write to that room fails — chat, presence,
 * playback, membership — not just the one that overflowed it. And the person
 * who pays is everyone in the room, not the account that wrote it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MediaRef, PlaylistId, QueueItem, QueueItemId, RoomId, UserId } from '@gather/contracts';
import type { PlaylistDoc, StorePort } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import { SyncService } from '../src/modules/sync/service';
import { QUEUE_ARTWORK_URL_MAX_CHARS, QUEUE_MEDIA_REF_MAX_CHARS } from '../src/modules/queue/service';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';

/** A page ref whose serialized form is past the ceiling. */
const hugeMediaRef: MediaRef = {
  kind: 'page',
  url: `https://example.com/${'a'.repeat(QUEUE_MEDIA_REF_MAX_CHARS)}`,
};

/** An https artwork URL past the ceiling — a real scheme, just enormous. */
const hugeArtworkUrl = `https://cdn.example.com/${'a'.repeat(QUEUE_ARTWORK_URL_MAX_CHARS)}.png`;

describe('the room document is bounded on every door that writes it', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;
  let roomId: RoomId;
  let ownerId: UserId;

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp());
    ({ roomId, ownerId } = await seedRoom(store));
  });

  afterEach(async () => {
    await app.close();
  });

  // ── door 1: the playback snapshot ──────────────────────────────────────────

  it('refuses a setTrack whose mediaRef is too large for the room document', async () => {
    const sync = new SyncService(deps);
    // The room OWNER — this is a size bound, not an authorization one, so the
    // member the policy trusts most hits it exactly like everyone else.
    await expect(
      sync.setTrack(roomId, ownerId, { kind: 'media', mediaRef: hugeMediaRef }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Refused means refused on every surface it would otherwise have reached:
    // the room doc, the replayable event log, the usage ledger, room history.
    expect((await store.rooms.findById(roomId))!.playback).toBeNull();
    expect(await store.events.findMany({ roomId })).toEqual([]);
    expect(await store.usage.findMany({ kind: 'playback.history' })).toEqual([]);
    expect(await store.playbackHistory.findMany({ roomId })).toEqual([]);
  });

  it('leaves an ordinary setTrack completely alone', async () => {
    const sync = new SyncService(deps);
    const mediaRef: MediaRef = { kind: 'page', url: 'https://example.com/watch/1' };
    await sync.setTrack(roomId, ownerId, { kind: 'media', mediaRef });
    expect((await store.rooms.findById(roomId))!.playback!.mediaRef).toEqual(mediaRef);
  });

  // ── doors 2 and 3: the playlist copy ───────────────────────────────────────

  describe('the playlist→queue copy', () => {
    let token: string;
    let userId: UserId;

    beforeEach(async () => {
      const account = await signupUser(app, 'owner@example.com');
      token = account.accessToken;
      userId = account.user.id;
      // seedRoom's queueControl is 'everyone', so the policy is not what is
      // being tested here — the byte bound is.
      await addMember(store, roomId, userId, 'member');
    });

    /** A playlist doc written straight to the store: whatever door it came
     *  through, the copy must not carry it onto the shared room document. */
    async function seedPlaylist(items: QueueItem[]): Promise<PlaylistId> {
      const playlist: PlaylistDoc = {
        id: 'playlist-1' as PlaylistId,
        ownerId: userId,
        roomId: null,
        title: 'mixtape',
        items,
      };
      await store.playlists.insertOne(playlist);
      return playlist.id;
    }

    function item(overrides: Partial<QueueItem> = {}): QueueItem {
      return {
        id: 'pl-item-0' as QueueItemId,
        mediaRef: { kind: 'page', url: 'https://example.com/watch/1' },
        title: 'a track',
        durationMs: null,
        artworkUrl: null,
        addedBy: userId,
        votesToSkip: [],
        ...overrides,
      };
    }

    const addToQueue = async (playlistId: PlaylistId) =>
      app.inject({
        method: 'POST',
        url: '/playlists/add-to-queue',
        headers: { authorization: `Bearer ${token}` },
        payload: { playlistId, roomId },
      });

    it('refuses a copy carrying an oversized artworkUrl', async () => {
      const playlistId = await seedPlaylist([item({ artworkUrl: hugeArtworkUrl })]);
      const res = await addToQueue(playlistId);
      expect(res.statusCode).toBe(400);
      expect((res.json() as { code: string }).code).toBe('VALIDATION');
      // Nothing copied, no version bump, no broadcast.
      const room = await store.rooms.findById(roomId);
      expect(room!.queue.items).toEqual([]);
      expect(room!.queue.version).toBe(0);
    });

    it('still copies an ordinary playlist', async () => {
      const playlistId = await seedPlaylist([
        item({ artworkUrl: 'https://cdn.example.com/cover.png' }),
      ]);
      const res = await addToQueue(playlistId);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { added: number }).added).toBe(1);
      expect((await store.rooms.findById(roomId))!.queue.items).toHaveLength(1);
    });

    it('closes the door the artwork gets in through as well', async () => {
      // The copy check is the one that guards the SHARED document, but leaving
      // the producer open means the refusal lands on the wrong screen — the
      // owner is told "no" only once they try to share it.
      const created = await app.inject({
        method: 'POST',
        url: '/playlists',
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'mixtape' },
      });
      expect(created.statusCode).toBe(200);
      const playlistId = (created.json() as { playlist: { id: string } }).playlist.id;

      const patched = await app.inject({
        method: 'PATCH',
        url: `/playlists/${playlistId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { items: [item({ artworkUrl: hugeArtworkUrl })] },
      });
      expect(patched.statusCode).toBe(400);
      expect((patched.json() as { code: string }).code).toBe('VALIDATION');
      expect((await store.playlists.findById(playlistId))!.items).toEqual([]);
    });
  });
});
