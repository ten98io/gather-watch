/**
 * GDPR data export (GET /me/export): assembles the user's data straight from
 * the store. The response shape is EXACTLY MeExportResponse — server-only doc
 * fields (RoomDoc realtime snapshots, AssetDoc object-storage bookkeeping)
 * are serialized away, and session token hashes never leave the sessions
 * collection. Anything beyond the contract shape (sessions, subscription,
 * push subs, usage aggregates) needs a contracts change first — contracts are
 * orchestrator-owned.
 */
import type { MediaAsset, MeExportResponse, Room, UserId } from '@playin/contracts';
import { AppError } from '../../lib/errors';
import type { AssetDoc } from '../../adapters/ports';
import { serializeRoom } from '../rooms/serialize';
import type { Deps } from '../types';

/** Contracts MediaAsset — strip AssetDoc's storageKey/uploadId bookkeeping. */
function serializeAsset(asset: AssetDoc): MediaAsset {
  return {
    id: asset.id,
    ownerId: asset.ownerId,
    filename: asset.filename,
    mime: asset.mime,
    sizeBytes: asset.sizeBytes,
    status: asset.status,
    hlsUrl: asset.hlsUrl,
    thumbnailUrl: asset.thumbnailUrl,
    waveformUrl: asset.waveformUrl,
    durationMs: asset.durationMs,
    error: asset.error,
    createdAt: asset.createdAt,
  };
}

export async function buildExport(deps: Deps, userId: UserId): Promise<MeExportResponse> {
  const { store } = deps;
  const user = await store.users.findById(userId);
  if (user === null) {
    throw new AppError('NOT_FOUND', 'user not found');
  }

  // Rooms = every room the user holds a membership row for (banned rows
  // included — it is still their history), plus any room they own. Deduped
  // by id, serialized to the contracts shape.
  const roomsById = new Map<string, Room>();
  const memberships = await store.members.findMany({ userId });
  for (const membership of memberships) {
    const room = await store.rooms.findById(membership.roomId);
    if (room !== null) {
      roomsById.set(room.id, serializeRoom(room));
    }
  }
  const owned = await store.rooms.findMany({ ownerId: userId });
  for (const room of owned) {
    if (!roomsById.has(room.id)) {
      roomsById.set(room.id, serializeRoom(room));
    }
  }

  // Their own messages verbatim, oldest first (tombstones included — the
  // body is already gone from those; nothing of their own is redacted).
  const messages = await store.messages.findMany({ authorId: userId });
  messages.sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);

  const playlists = await store.playlists.findMany({ ownerId: userId });
  const assets = (await store.assets.findMany({ ownerId: userId })).map(serializeAsset);

  return {
    exportedAt: Date.now(),
    user,
    rooms: [...roomsById.values()],
    messages,
    playlists,
    assets,
  };
}
