/**
 * Which queue item just ended on this phone — the one question the room's
 * auto-advance intent asks of a client.
 *
 * MIRRORS apps/web/lib/player/advance.ts, by hand and on purpose: mobile
 * carries its own copies of the small rules the web owns (see permissions.ts,
 * and `isMusicRef` next door), because the alternative is a shared package
 * that would have to depend on React or on nothing at all. Keep the two in
 * step — the reasoning below is the web module's, restated where a reader of
 * this app will actually find it.
 *
 * WHY AN ITEM AND NOT A DESTINATION. `sync.advance` reports a FACT — "the item
 * I was playing has ended" — and the server compare-and-sets on it: it moves
 * the room only while the room is still on that exact item, and the only place
 * it can move to is that item's successor as the SERVER sees the queue. So a
 * client never names where to go, which is why the send needs no policy gate
 * and no elected advancer. Every device that reaches the end may say so; the
 * first lands and the rest are silent no-ops.
 *
 * WHY BY ITEM AND NOT BY RAW INDEX. `playback.queueIndex` is recorded when the
 * track is set and is not revised until the server realigns it, so a remove or
 * a reorder leaves it naming a different row. The playing item is located
 * first, and only then read for its id.
 */
import type { MediaRef, QueueItem, QueueItemId } from '@gather/contracts';

export interface EndedTrackInput {
  /** Room-authoritative index of the playing item. Null after a setTrack of
   *  kind 'media', which records no index at all. */
  queueIndex: number | null;
  /** The room's queue as it stands NOW — not as it stood when the track was set. */
  items: readonly QueueItem[];
  /** What is playing. Null → nothing has ended. */
  mediaRef: MediaRef | null;
}

/**
 * Media identity WITHOUT the playback epoch: "is this the same content?".
 *
 * Shared with the engine's hard-resync key next door, which is this plus
 * `:seq` — the epoch belongs to "has the room re-set the track", never to
 * "which item is this".
 */
export function mediaIdentity(ref: MediaRef): string {
  const id =
    ref.kind === 'youtube' || ref.kind === 'vimeo'
      ? ref.videoId
      : ref.kind === 'embed'
        ? ref.embedUrl
        : ref.url;
  return `${ref.kind}:${id}`;
}

/**
 * The id of the queue item that just ended, or null when there is nothing
 * honest to name.
 *
 * Null is a real answer and it is the SAFE one: the intent means "advance the
 * room from this item", so a wrong id does not merely fail, it skips an item
 * nobody skipped.
 */
export function endedQueueItemId(input: EndedTrackInput): QueueItemId | null {
  const { queueIndex, items, mediaRef } = input;
  if (mediaRef === null) return null;
  const playingIdentity = mediaIdentity(mediaRef);

  // The recorded index still names what is playing → that is the row that
  // ended. Checked BEFORE the search below so a queue holding the same media
  // twice names the copy that is actually playing: two adds of one video are
  // two items with two ids, and only the index tells them apart.
  if (queueIndex !== null) {
    const playing = items[queueIndex];
    if (playing !== undefined && mediaIdentity(playing.mediaRef) === playingIdentity) {
      return playing.id;
    }
  }

  // The index is stale (something ahead of it was removed) or was never
  // recorded. Find the playing item where it sits now.
  const found = items.find((it) => mediaIdentity(it.mediaRef) === playingIdentity);
  if (found !== undefined) return found.id;

  // The playing item is not in the queue at all — vote-skip carried it off
  // while it was still on the stage. Answering `items[queueIndex]` here would
  // name the row that shifted DOWN into the gap, and telling the server that
  // row ended advances past it: a second item skipped, from one vote-skip.
  //
  // Nothing is lost by saying nothing. Removing the playing item is a queue
  // mutation and the server realigns playback across it in the same breath
  // (services/api queue/service.ts `realignedQueueIndex`); the room's own
  // bookkeeping moves it on, not a report from here.
  return null;
}
