/**
 * GDPR data export (GET /me/export): assembles the user's data straight from
 * the store. The response shape is EXACTLY MeExportResponse — server-only doc
 * fields (RoomDoc realtime snapshots, AssetDoc object-storage bookkeeping)
 * are serialized away, and session token hashes never leave the sessions
 * collection. playbackHistory and usage surface the metering rows the sync
 * and rtc/billing modules persist (contracts PlaybackHistoryEntry /
 * RelayUsageMonth). Anything beyond the contract shape (sessions, raw usage
 * samples, push subs) still needs a contracts change first — contracts are
 * orchestrator-owned.
 */
import { MediaRef } from '@gather/contracts';
import type {
  MediaAsset,
  MeExportResponse,
  PlaybackHistoryEntry,
  RelayUsageMonth,
  Room,
  RoomId,
  UserId,
} from '@gather/contracts';
import { AppError } from '../../lib/errors';
import type { AssetDoc } from '../../adapters/ports';
import { serializeRoom } from '../rooms/serialize';
import type { Deps } from '../types';

/** Usage kind the sync module writes on every playback transition. */
const PLAYBACK_HISTORY_KIND = 'playback.history';
/** Usage kinds carrying TURN relay byte counts (server metering + client
 *  getStats ingest). Amounts are bytes; anything else is skipped. */
const RELAY_USAGE_KINDS = ['turn-bytes', 'turn-relay'] as const;
const BYTES_PER_GB = 1e9;

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

/** UTC 'YYYY-MM' bucket for a usage row's `at` timestamp. */
function utcMonth(at: number): string {
  const date = new Date(at);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${String(date.getUTCFullYear())}-${month}`;
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

  // Playback history: the sync module's transition rows, oldest first. The
  // mediaRef snapshot rides in `meta`; rows without a parseable one (player
  // cleared, legacy rows) are skipped — the contract entry requires it.
  const playbackRows = await store.usage.findMany({ userId, kind: PLAYBACK_HISTORY_KIND });
  playbackRows.sort((a, b) => a.at - b.at);
  const playbackHistory: PlaybackHistoryEntry[] = [];
  for (const row of playbackRows) {
    if (row.roomId === null || !Number.isFinite(row.amount) || row.amount < 0) {
      continue;
    }
    const mediaRef = MediaRef.safeParse(row.meta?.['mediaRef']);
    if (!mediaRef.success) {
      continue;
    }
    playbackHistory.push({
      roomId: row.roomId as RoomId,
      mediaRef: mediaRef.data,
      positionMs: row.amount,
      at: row.at,
    });
  }

  // TURN relay usage aggregated per UTC calendar month, ascending. 3 decimals
  // matches the rtc module's fairUseRemainingGb rounding.
  const relayRows = await store.usage.findMany({ userId, kind: { $in: RELAY_USAGE_KINDS } });
  const bytesByMonth = new Map<string, number>();
  for (const row of relayRows) {
    if (row.unit !== 'bytes' || !Number.isFinite(row.amount) || row.amount < 0) {
      continue;
    }
    const month = utcMonth(row.at);
    bytesByMonth.set(month, (bytesByMonth.get(month) ?? 0) + row.amount);
  }
  const usage: RelayUsageMonth[] = [...bytesByMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, bytes]) => ({
      month,
      relayGb: Math.round((bytes / BYTES_PER_GB) * 1000) / 1000,
    }));

  return {
    exportedAt: Date.now(),
    user,
    rooms: [...roomsById.values()],
    messages,
    playlists,
    assets,
    playbackHistory,
    usage,
  };
}
