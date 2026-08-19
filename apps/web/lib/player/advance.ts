/**
 * Naming the queue item on the stage — for the two reports a client owes the
 * room about it: the item's player RAN OUT, and the item is THIS LONG.
 *
 * Pure on purpose (the `stageGate` precedent): the interesting part is not the
 * plumbing, it is working out WHICH item is meant when the queue has moved
 * under the playing item, and that deserves to be readable and tested on its
 * own. Both reports share `playingQueueItem` for exactly that reason — they
 * would otherwise disagree about which row they mean at the worst moments.
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
 * The queue row that is on the stage right now, or null when nothing in the
 * queue honestly answers to what is playing.
 *
 * Null is a real answer and it is the SAFE one for both callers below: naming
 * the wrong row does not merely fail, it advances a room past an item nobody
 * skipped, or writes one item's length onto another.
 */
export function playingQueueItem(input: EndedTrackInput): QueueItem | null {
  const { queueIndex, items, mediaRef } = input;
  if (mediaRef === null) return null;

  // The recorded index still names what is playing → that is the row that
  // ended. Checked BEFORE the search below so a queue holding the same media
  // twice names the copy that is actually playing: two adds of one video are
  // two items with two ids, and only the index tells them apart.
  if (queueIndex !== null) {
    const playing = items[queueIndex];
    if (playing !== undefined && sameMedia(playing.mediaRef, mediaRef)) return playing;
  }

  // The index is stale (something ahead of it was removed) or was never
  // recorded (a 'media' setTrack). Find the playing item where it sits now.
  const found = items.find((it) => sameMedia(it.mediaRef, mediaRef));
  if (found !== undefined) return found;

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

/**
 * The id of the queue item that just ended, or null when there is nothing
 * honest to name.
 *
 * Null is a real answer and it is the SAFE one: the intent means "advance the
 * room from this item", so a wrong id does not merely fail, it skips an item
 * nobody skipped. Saying nothing costs at most one advance the server was going
 * to have to make anyway (see the vote-skip case above).
 */
export function endedQueueItemId(input: EndedTrackInput): QueueItemId | null {
  return playingQueueItem(input)?.id ?? null;
}

/* ────────────────────────── the item's own length ─────────────────────────── */

export interface DurationReportInput extends EndedTrackInput {
  /** What the DRIVING surface says this item is long — `PlayerAdapter.durationMs()`
   *  on this page, or the extension's telemetry when the extension drives. */
  durationMs: number;
}

/** The `sync.duration` payload, ready for the wire. */
export interface DurationReport {
  itemId: QueueItemId;
  durationMs: number;
}

/**
 * "My player says this item is THIS long", or null when there is nothing worth
 * saying — the decision half of the `sync.duration` report (packages/contracts
 * ws.ts documents why the fact can only come from a client).
 *
 * It lives beside `endedQueueItemId` because it asks the SAME hard question:
 * which row of a queue that moves underneath us is the one on the stage. Both
 * answers must be right about that one thing, and both are safe only because
 * they are wrong in the null direction.
 *
 * Every null below is deliberate:
 *
 *   • an UNKNOWN length. 0 is every adapter's "not known yet" (pre-metadata,
 *     YouTube pre-ready) and must never be sent as a fact.
 *   • a LIVE STREAM. `HTMLMediaElement.duration` is Infinity there, which is
 *     not a length; the contract's payload is `finite().positive()`, and the
 *     server's unknown-duration branch is the correct answer for a stream that
 *     has no end. Negative and NaN readings from a confused player land here
 *     too rather than being rounded into something plausible.
 *   • an item whose length is ALREADY KNOWN. The server writes only onto a row
 *     whose duration is still unset, so a second report is a no-op it has to
 *     load the room to discover; the caller's own once-per-item latch stops
 *     the repeat within one item, and this stops it across a rejoin.
 *   • no matching row (see `playingQueueItem`). A length is a FILL against one
 *     id, so naming the wrong row writes a wrong length onto an item nobody is
 *     playing — and `endingIsPlausible` then measures the next ending of that
 *     item against it.
 *
 * Rounded because the server stores integer ms (`sanitizeDurationMs`), and
 * re-checked for positivity afterwards: a 0.4 ms reading rounds to 0, which the
 * contract rejects outright.
 */
export function durationReportFor(input: DurationReportInput): DurationReport | null {
  const { durationMs } = input;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const item = playingQueueItem(input);
  if (item === null) return null;
  if (item.durationMs !== null && item.durationMs > 0) return null;
  const value = Math.round(durationMs);
  if (value <= 0) return null;
  return { itemId: item.id, durationMs: value };
}
