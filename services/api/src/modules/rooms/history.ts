/**
 * The room's playback history — what this room actually played, in order,
 * with enough on each row to put the thing back in the queue.
 *
 * It lives in the rooms module because it is room data with a room lifetime:
 * the read is `GET /rooms/:roomId/history`, the gate is room membership, and
 * the rows die in the same two cascades that already take a room's messages
 * and events (host delete, idle sweep). Nothing here is per-user, so nothing
 * here belongs to the metering table — see PlaybackHistoryDoc in
 * adapters/ports.ts for why `usage` was the wrong home.
 *
 * ONE ROW PER TRACK CHANGE. Callers hand us a track start; a start that names
 * the media already at the head of this room's history is dropped, so the
 * re-broadcasts, reconnects and double-clicks that all end in the same
 * setTrack cannot turn one viewing into twenty rows.
 */
import type { MediaRef, QueueItemInput, RoomHistoryEntry, RoomId } from '@gather/contracts';
import type { PlaybackHistoryDoc } from '../../adapters/ports';
import { newId } from '../../lib/tokens';
import type { Deps } from '../types';

/**
 * How many entries a room keeps. A history people scroll needs a bottom, and
 * this is the point where "what did we watch" stops being a memory and starts
 * being an archive nobody reads. 200 is roughly a year of a weekly film night
 * and several months of a heavy listening room.
 */
export const HISTORY_KEEP_PER_ROOM = 200;

/** What a caller knows at the moment a track starts. */
export interface PlaybackStart {
  roomId: RoomId;
  mediaRef: MediaRef;
  /** The queue row's title, or 'Untitled' when nothing named it. */
  title: string;
  artworkUrl: string | null;
  durationMs: number | null;
  queuedBy: string;
  startedBy: string;
}

/** Identity of a piece of media, for "is this the same thing again?". Every
 *  MediaRef member is a small flat object, so the discriminant plus its own
 *  fields is a complete key — and JSON key order is stable because both sides
 *  of the comparison are built by this same function. */
function mediaKey(ref: MediaRef): string {
  return JSON.stringify(ref);
}

/** The room's newest entry, or null. */
async function newestEntry(deps: Deps, roomId: string): Promise<PlaybackHistoryDoc | null> {
  const rows = await deps.store.playbackHistory.findMany(
    { roomId },
    { sort: [['seq', -1]], limit: 1 },
  );
  return rows[0] ?? null;
}

/**
 * Record a track start. Returns the stored row, or null when it was a repeat
 * of what the room is already showing at the top of its history.
 *
 * Never throws into the caller's path: history is a nice-to-have that must
 * not be able to fail a play. A failed write is logged and swallowed — the
 * alternative is a room where pressing play errors because a log entry could
 * not be saved.
 */
export async function recordPlayback(
  deps: Deps,
  start: PlaybackStart,
): Promise<PlaybackHistoryDoc | null> {
  try {
    const previous = await newestEntry(deps, start.roomId);
    if (previous !== null && mediaKey(previous.mediaRef) === mediaKey(start.mediaRef)) {
      return null;
    }
    const seq = await deps.store.nextSeq(`history:${start.roomId}`);
    const doc = await deps.store.playbackHistory.insertOne({
      id: newId(),
      roomId: start.roomId,
      seq,
      mediaRef: start.mediaRef,
      title: start.title,
      artworkUrl: start.artworkUrl,
      durationMs: start.durationMs,
      queuedBy: start.queuedBy,
      startedBy: start.startedBy,
      playedAt: Date.now(),
    });
    await pruneRoomHistory(deps, start.roomId);
    return doc;
  } catch (err) {
    deps.log.warn({ err, roomId: start.roomId }, 'playback history write failed');
    return null;
  }
}

/**
 * Drop everything older than the newest HISTORY_KEEP_PER_ROOM entries.
 *
 * Runs after each insert rather than on a timer: the cap is per room, and the
 * only moment a room can cross it is the moment it gains a row. That keeps it
 * out of the idle sweeper, which is for rooms nobody is using — the rooms
 * whose history is growing are exactly the ones it never visits.
 */
export async function pruneRoomHistory(deps: Deps, roomId: string): Promise<number> {
  const total = await deps.store.playbackHistory.count({ roomId });
  if (total <= HISTORY_KEEP_PER_ROOM) {
    return 0;
  }
  // The seq of the oldest row worth keeping; everything strictly below goes.
  const keep = await deps.store.playbackHistory.findMany(
    { roomId },
    { sort: [['seq', -1]], limit: HISTORY_KEEP_PER_ROOM },
  );
  const floor = keep[keep.length - 1]?.seq;
  if (floor === undefined) {
    return 0;
  }
  return deps.store.playbackHistory.deleteMany({ roomId, seq: { $lt: floor } });
}

/** Drop a room's whole history (room delete + idle sweep cascades). */
export async function deleteRoomHistory(deps: Deps, roomId: string): Promise<number> {
  return deps.store.playbackHistory.deleteMany({ roomId });
}

/** One page of a room's history, newest first. `before` is the previous
 *  page's `nextBefore`; `nextBefore` is null once the page ran short. */
export async function readRoomHistory(
  deps: Deps,
  roomId: string,
  opts: { before?: number | undefined; limit: number },
): Promise<{ entries: PlaybackHistoryDoc[]; nextBefore: number | null }> {
  const entries = await deps.store.playbackHistory.findMany(
    { roomId, ...(opts.before !== undefined ? { seq: { $lt: opts.before } } : {}) },
    { sort: [['seq', -1]], limit: opts.limit },
  );
  // A full page means there MIGHT be more; a short page means there is not.
  const last = entries[entries.length - 1];
  const nextBefore = entries.length === opts.limit && last !== undefined ? last.seq : null;
  return { entries, nextBefore };
}

/** Doc → contracts entry. There is nothing server-only on the doc, but the
 *  mapping is explicit anyway so a future internal field cannot leak by
 *  simply existing (same rule as serializeRoom). */
export function serializeHistoryEntry(doc: PlaybackHistoryDoc): RoomHistoryEntry {
  return {
    id: doc.id,
    roomId: doc.roomId as RoomId,
    seq: doc.seq,
    mediaRef: doc.mediaRef,
    title: doc.title,
    artworkUrl: doc.artworkUrl,
    durationMs: doc.durationMs,
    queuedBy: doc.queuedBy as RoomHistoryEntry['queuedBy'],
    startedBy: doc.startedBy as RoomHistoryEntry['startedBy'],
    playedAt: doc.playedAt,
  };
}

/**
 * A history entry as a queue add. This is the point of storing the title and
 * the ref together: re-queueing must not need a second lookup, a live queue
 * row, or anything the original adder still has.
 */
export function historyEntryToQueueInput(entry: RoomHistoryEntry): QueueItemInput {
  return {
    mediaRef: entry.mediaRef,
    title: entry.title,
    durationMs: entry.durationMs,
    artworkUrl: entry.artworkUrl,
  };
}
