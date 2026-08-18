/**
 * Auto-advance — naming the queue item whose player has just run out.
 *
 * Pure on purpose (the `stageGate` precedent): the interesting part is not the
 * plumbing, it is working out WHICH item ended when the queue has moved under
 * the playing item, and that deserves to be readable and tested on its own.
 *
 * WHY THIS NAMES AN ITEM AND NOT A DESTINATION. This module used to pick the
 * successor and the stage sent `sync.setTrack` at it. Two things were wrong
 * with that. A destination chosen from this client's copy of the queue is a
 * guess about someone else's array — every subtlety below exists because the
 * copies disagree. And a client that names a destination can name ANY
 * destination, so the send had to be a control action, which meant it had to be
 * gated, which meant exactly one client in the room was allowed to make it,
 * which is the election that kept leaving rooms stuck on a finished item.
 *
 * The intent reports a FACT instead: "the item I was playing has ended". The
 * server compare-and-sets on it — it moves the room only if the room is still
 * on that exact item, and the only place it can move to is that item's
 * successor as the SERVER sees the queue. So the answer here has to be right
 * about one thing only, which is the one thing this client actually knows.
 *
 * WHO CALLS THIS. Every client whose player reaches the end, with no election
 * of any kind. Elastic sync leaves viewers at deliberately different offsets,
 * so an item ends at N different moments in an N-person room — and N reports of
 * one ending are harmless, because the first moves the room and the rest find
 * it already moved and are dropped. See docs/EXTENSION_FIRST.md Part 1 for why
 * the resulting track change still applies immediately and unbanded on every
 * follower: it is host intent on the wire whoever reported the ending.
 *
 * WHY BY ITEM, NOT BY RAW INDEX. `playback.queueIndex` is recorded when the
 * track is set and never revised until the server realigns it. Vote-skip
 * removes items and leaves the index alone, so the index alone names the wrong
 * row from the instant anyone edits the queue. The playing item is therefore
 * located first, and only then read for its id.
 */
import type { MediaRef, QueueItem, QueueItemId } from '@gather/contracts';
import { mediaKey } from './adapter';

export interface EndedTrackInput {
  /** Room-authoritative index of the playing item. Null after a setTrack of
   *  kind 'media', which records no index at all. */
  queueIndex: number | null;
  /** The room's queue as it stands NOW — not as it stood when the track was set. */
  items: readonly QueueItem[];
  /** What is playing. Null → nothing has ended. */
  mediaRef: MediaRef | null;
}

/** Media identity ignoring the playback epoch: "is this the same content?". */
function sameMedia(a: MediaRef, b: MediaRef): boolean {
  return mediaKey(a, undefined) === mediaKey(b, undefined);
}

/**
 * The id of the queue item that just ended, or null when there is nothing
 * honest to name.
 *
 * Null is a real answer and it is the SAFE one: the intent means "advance the
 * room from this item", so a wrong id does not merely fail, it skips an item
 * nobody skipped. Saying nothing costs at most one advance the server was going
 * to have to make anyway (see the vote-skip case below).
 */
export function endedQueueItemId(input: EndedTrackInput): QueueItemId | null {
  const { queueIndex, items, mediaRef } = input;
  if (mediaRef === null) return null;

  // The recorded index still names what is playing → that is the row that
  // ended. Checked BEFORE the search below so a queue holding the same media
  // twice names the copy that is actually playing: two adds of one video are
  // two items with two ids, and only the index tells them apart.
  if (queueIndex !== null) {
    const playing = items[queueIndex];
    if (playing !== undefined && sameMedia(playing.mediaRef, mediaRef)) return playing.id;
  }

  // The index is stale (something ahead of it was removed) or was never
  // recorded (a 'media' setTrack). Find the playing item where it sits now.
  const found = items.find((it) => sameMedia(it.mediaRef, mediaRef));
  if (found !== undefined) return found.id;

  // The playing item is not in the queue at all — vote-skip carried it off
  // while it was still on the stage, or it was a one-off 'media' setTrack for
  // something the queue never had.
  //
  // The old code answered `items[queueIndex]` here, on the reasoning that
  // everything after a removed item shifts down so the row now at that index IS
  // the successor. That was a defensible answer when this function picked a
  // destination. It is a dangerous one now: that row is not the item that
  // ended, and naming it as such tells the server to advance PAST it — a
  // second item skipped, from one vote-skip.
  //
  // Nothing is lost by saying nothing. Removing the playing item is a queue
  // mutation, and the server realigns playback across it in the same breath
  // (services/api queue/service.ts `realignedQueueIndex`); the room's own
  // bookkeeping is what moves it on, not a report from here.
  return null;
}
