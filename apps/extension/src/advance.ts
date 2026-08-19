/**
 * Which queue item just ended on this device — the one question the room's
 * auto-advance intent asks of a client.
 *
 * MIRRORS apps/web/lib/player/advance.ts (and apps/mobile/src/sync/advance.ts),
 * by hand, the way this extension already mirrors the web's permission rules
 * and its media identity. Keep the three in step.
 *
 * WHY THE WORKER NEEDS THIS AT ALL. The extension used to report an ending
 * only outward, to the web app's event port, and the web app turned it into
 * `sync.advance`. A user who connected from the POPUP has no Gather tab, so
 * that relay does not exist and the room stalled on a finished item. The
 * worker holds the room socket itself, so it can send the intent — but the
 * intent names an ITEM, and naming one means resolving it here.
 *
 * WHY AN ITEM AND NOT A DESTINATION. `sync.advance` reports a fact — "the item
 * I was playing has ended" — and the server compare-and-sets on it: it moves
 * the room only while the room is still on that exact item, and only to that
 * item's successor as the SERVER sees the queue. A client that named a
 * destination would be guessing about someone else's array, and would need a
 * policy gate, which is the elected advancer this replaced.
 *
 * WHY BY ITEM AND NOT BY RAW INDEX. `playback.queueIndex` is recorded when the
 * track is set and is not revised until the server realigns it, so a remove or
 * a reorder leaves it naming a different row.
 */
import type { MediaRef, QueueItem, QueueItemId } from '@gather/contracts';
import { mediaKeyOf } from './driver';

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
 * The id of the queue item that just ended, or null when there is nothing
 * honest to name.
 *
 * Null is a real answer and it is the SAFE one: the intent means "advance the
 * room from this item", so a wrong id does not merely fail, it skips an item
 * nobody skipped.
 *
 * Identity is {@link mediaKeyOf} — the extension's own spelling of "same
 * content", exhaustive over MediaRef including `page`, and already what the
 * driver keys its anchor on. Comparing extension keys to extension keys is
 * what matters; the web's spelling of the same idea differs for `hls` and does
 * not have to agree, because the two never compare their keys to each other.
 *
 * ALSO ASKED OF AN ITEM THAT IS STILL PLAYING. `sync.duration` names a row the
 * same way (background.ts's `reportItemDuration`), and the question underneath
 * both is one question — WHICH ROW OF THE ROOM'S QUEUE IS THIS PLAYER PLAYING?
 * — so it is answered once, here. Nothing in this function is about the end:
 * that fact belongs to the caller, and null is the safe answer to both.
 */
export function endedQueueItemId(input: EndedTrackInput): QueueItemId | null {
  const { queueIndex, items, mediaRef } = input;
  if (mediaRef === null) return null;
  const playingKey = mediaKeyOf(mediaRef);
  if (playingKey === null) return null;

  // The recorded index still names what is playing → that is the row that
  // ended. Checked BEFORE the search below so a queue holding the same media
  // twice names the copy that is actually playing: two adds of one video are
  // two items with two ids, and only the index tells them apart.
  if (queueIndex !== null) {
    const playing = items[queueIndex];
    if (playing !== undefined && mediaKeyOf(playing.mediaRef) === playingKey) return playing.id;
  }

  // The index is stale (something ahead of it was removed) or was never
  // recorded. Find the playing item where it sits now.
  const found = items.find((it) => mediaKeyOf(it.mediaRef) === playingKey);
  if (found !== undefined) return found.id;

  // The playing item is not in the queue at all — vote-skip carried it off
  // while it was still on the stage, or the queue never had it. Answering
  // `items[queueIndex]` here would name the row that shifted DOWN into the
  // gap, and telling the server that row ended advances past it: a second item
  // skipped, from one vote-skip. The server realigns playback across a queue
  // mutation in the same breath, so nothing is lost by saying nothing.
  return null;
}
