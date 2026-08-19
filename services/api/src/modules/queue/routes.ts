/**
 * Playlists REST endpoints. Registered WITHOUT a prefix — the paths below are
 * full and must match @gather/api-client exactly. Playlists are owner-only:
 * every read/mutation of an existing playlist is rejected for non-owners.
 * add-to-queue appends COPIES of the playlist's items (fresh ids) to a room's
 * shared queue, gated on that room's queueControl policy.
 */
import type { FastifyPluginAsync } from 'fastify';
import {
  AddToRoomQueueBody,
  CreatePlaylistBody,
  UpdatePlaylistBody,
} from '@gather/contracts';
import type { PlaylistId, QueueItem, QueueItemId, UserId } from '@gather/contracts';
import { memberDocId } from '../../adapters/ports';
import type { PlaylistDoc, StorePort } from '../../adapters/ports';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/tokens';
import { requireAuth } from '../../plugins/auth';
import { parseWith } from '../../plugins/error-mapper';
import { policyAllows } from '../sync/policy';
import { QUEUE_MAX_ITEMS, assertQueueItemWithinBounds, commitQueueWrite } from './service';

type PlaylistParams = { Params: { playlistId: string } };

/** Load a playlist the caller owns; 404 when missing, 403 for everyone else. */
async function ownedPlaylist(
  store: StorePort,
  playlistId: string,
  userId: UserId,
): Promise<PlaylistDoc> {
  const playlist = await store.playlists.findById(playlistId);
  if (playlist === null) {
    throw new AppError('NOT_FOUND', 'playlist not found');
  }
  if (playlist.ownerId !== userId) {
    throw new AppError('FORBIDDEN', 'not your playlist');
  }
  return playlist;
}

export const queueRoutes: FastifyPluginAsync = async (app) => {
  const { store } = app.deps;

  app.post('/playlists', async (request) => {
    const auth = requireAuth(request);
    const body = parseWith(CreatePlaylistBody, request.body);
    const playlist: PlaylistDoc = {
      id: newId() as PlaylistId,
      ownerId: auth.userId,
      roomId: body.roomId ?? null,
      title: body.title,
      items: [],
    };
    await store.playlists.insertOne(playlist);
    return { playlist };
  });

  app.get('/playlists', async (request) => {
    const auth = requireAuth(request);
    const playlists = await store.playlists.findMany({ ownerId: auth.userId });
    return { playlists };
  });

  app.get<PlaylistParams>('/playlists/:playlistId', async (request) => {
    const auth = requireAuth(request);
    const playlist = await ownedPlaylist(store, request.params.playlistId, auth.userId);
    return { playlist };
  });

  app.patch<PlaylistParams>('/playlists/:playlistId', async (request) => {
    const auth = requireAuth(request);
    const body = parseWith(UpdatePlaylistBody, request.body);
    const existing = await ownedPlaylist(store, request.params.playlistId, auth.userId);
    // A playlist is a queue waiting to happen: every item here is copied onto
    // a shared room document by add-to-queue below. Bounding it at the copy
    // alone would be enough to protect the room, but it puts the refusal on
    // the wrong screen — the owner would only be told "no" once they tried to
    // share it, having already stored the megabyte. Same door, both ends.
    if (body.items !== undefined) {
      for (const item of body.items) assertQueueItemWithinBounds(item);
    }
    // Apply ONLY provided fields — never write undefined into the doc.
    const patch: Partial<PlaylistDoc> = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.items !== undefined ? { items: body.items } : {}),
    };
    const playlist = await store.playlists.updateOne({ id: existing.id }, patch);
    return { playlist };
  });

  app.delete<PlaylistParams>('/playlists/:playlistId', async (request) => {
    const auth = requireAuth(request);
    const existing = await ownedPlaylist(store, request.params.playlistId, auth.userId);
    await store.playlists.deleteOne({ id: existing.id });
    return { ok: true as const };
  });

  app.post('/playlists/add-to-queue', async (request) => {
    const auth = requireAuth(request);
    const body = parseWith(AddToRoomQueueBody, request.body);
    const playlist = await ownedPlaylist(store, body.playlistId, auth.userId);

    const room = await store.rooms.findById(body.roomId);
    if (room === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    const member = await store.members.findById(memberDocId(body.roomId, auth.userId));
    if (member === null) {
      throw new AppError('FORBIDDEN', 'not a member');
    }
    if (member.banned) {
      throw new AppError('FORBIDDEN', 'banned');
    }
    if (!policyAllows(room.policies.queueControl, member.role)) {
      throw new AppError('ROOM_POLICY', 'queue control not allowed');
    }

    // Nothing to copy: no version bump, no broadcast.
    if (playlist.items.length === 0) {
      return { added: 0 };
    }

    // The SAME bounds QueueService.add enforces. This route writes the queue
    // directly rather than going through the service, so every guard has to be
    // repeated here or it is simply not enforced — and an unbounded copy is
    // the cheapest way to push a room document toward Mongo's 16 MB ceiling,
    // after which EVERY write to that room fails, not just the queue.
    //
    // "Repeated" is why the per-item bound is ONE function rather than a list
    // of checks: this path used to spell out the count and the mediaRef and
    // stop there, so `artworkUrl` — `WebUrl`, unbounded — rode straight onto
    // the shared document. A caller cannot enforce a subset of one call.
    const assertItFits = (items: readonly QueueItem[]): void => {
      if (items.length + playlist.items.length > QUEUE_MAX_ITEMS) {
        throw new AppError(
          'VALIDATION',
          `that playlist does not fit — the queue holds ${QUEUE_MAX_ITEMS} items`,
        );
      }
    };
    assertItFits(room.queue.items);
    for (const item of playlist.items) assertQueueItemWithinBounds(item);

    // Append COPIES with fresh ids so playlist edits never alias queue items.
    // Minted once, above the retry loop, so a re-applied copy is the SAME
    // rows rather than a second set of them.
    const copies: QueueItem[] = playlist.items.map((item) => ({
      id: newId() as QueueItemId,
      mediaRef: item.mediaRef,
      title: item.title,
      durationMs: item.durationMs,
      artworkUrl: item.artworkUrl,
      addedBy: auth.userId,
      votesToSkip: [],
    }));
    // Compare-and-set, like every other write to this array: an unconditional
    // one erases whatever landed between the read above and this write, and a
    // playlist copy is the LARGEST such loss available — a whole queue's worth
    // of somebody else's adds.
    await commitQueueWrite(
      store,
      room,
      (current) => {
        // Re-checked against the queue the write will actually land on: the
        // ceiling protects the DOCUMENT, not the read.
        assertItFits(current.queue.items);
        return {
          items: [...current.queue.items, ...copies],
          version: current.queue.version + 1,
        };
      },
      async (current, next) => {
        const queue = { items: [...next.items], version: next.version };
        const written = await store.rooms.updateOne(
          { id: current.id, queue: current.queue },
          { queue },
        );
        if (written === null) return false;
        await app.deps.events.emit(body.roomId, 'queue.state', queue);
        return true;
      },
    );
    return { added: copies.length };
  });
};
