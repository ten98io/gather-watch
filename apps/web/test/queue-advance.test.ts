/**
 * NAMING THE ITEM THAT ENDED — the client's whole half of auto-advance now.
 *
 * This file used to test `nextTrackOnEnd`, which picked the SUCCESSOR. That
 * decision has moved to the server: the advance intent is a compare-and-set on
 * "the room is still on the item I say ended", and the only destination it can
 * reach is that item's successor as the SERVER sees the queue. A client that
 * named the destination could name any destination, which is the thing the CAS
 * exists to make impossible.
 *
 * So what is left here is the question the client alone can answer — WHICH of
 * the queue's items is the one whose player just ran out — and it is the same
 * hard question it always was, because the queue moves under the playing item.
 */
import { describe, expect, it } from 'vitest';
import type { MediaRef, QueueItem, QueueItemId, UserId } from '@gather/contracts';
import { durationReportFor, endedQueueItemId } from '@/lib/player/advance';

const ME = 'user-me' as UserId;

function ref(id: string): MediaRef {
  return { kind: 'youtube', videoId: id };
}

function item(id: string, media = id): QueueItem {
  return {
    id: `qi-${id}` as QueueItemId,
    mediaRef: ref(media),
    title: `item ${id}`,
    durationMs: null,
    artworkUrl: null,
    addedBy: ME,
    votesToSkip: [],
  };
}

const A = item('a');
const B = item('b');
const C = item('c');

describe('endedQueueItemId', () => {
  it('names the item the recorded index points at', () => {
    expect(endedQueueItemId({ queueIndex: 0, items: [A, B, C], mediaRef: A.mediaRef })).toBe(A.id);
  });

  it('names the LAST item too — stopping is the server’s call, not ours', () => {
    // The old client decided "nothing follows, so say nothing". That decision
    // belongs to whoever owns the queue: the room may have grown an item
    // between this player starting the credits and the intent landing.
    expect(endedQueueItemId({ queueIndex: 2, items: [A, B, C], mediaRef: C.mediaRef })).toBe(C.id);
  });

  it('resolves the playing item by media when no index was recorded', () => {
    // A setTrack of kind 'media' stores queueIndex: null.
    expect(endedQueueItemId({ queueIndex: null, items: [A, B, C], mediaRef: B.mediaRef })).toBe(
      B.id,
    );
  });

  it('prefers the recorded index when the SAME media sits in the queue twice', () => {
    // Two adds of one video are two items with two ids, and only the index
    // tells them apart. Searching by media alone would name the first copy —
    // and the server would then advance from there, replaying everything in
    // between.
    const first = item('a1', 'a');
    const second = item('a2', 'a');
    expect(
      endedQueueItemId({ queueIndex: 2, items: [first, B, second, C], mediaRef: ref('a') }),
    ).toBe(second.id);
  });

  it('follows an item that shifted down when an earlier item was removed', () => {
    // [A,B,C] playing C at 2; A is removed → [B,C]. The stale index is out of
    // range; resolving by media finds C where it sits now.
    expect(endedQueueItemId({ queueIndex: 2, items: [B, C], mediaRef: C.mediaRef })).toBe(C.id);
  });

  it('says nothing when the playing item has been voted off the queue', () => {
    // [A,B,C] playing A at 0 → A voted out → [B,C], and for one round trip
    // this client still holds index 0 against the new array.
    //
    // The old code answered `items[queueIndex]` here — B — as the SUCCESSOR of
    // a removed item. Under the intent that answer is not merely stale, it is
    // dangerous: naming B as "the item that ended" tells the server to advance
    // PAST B, skipping an item nobody voted out. There is no ended item left
    // to name, so we name none.
    expect(endedQueueItemId({ queueIndex: 0, items: [B, C], mediaRef: A.mediaRef })).toBeNull();
    // …and the same once the server's realignment has nulled the index.
    expect(endedQueueItemId({ queueIndex: null, items: [B, C], mediaRef: A.mediaRef })).toBeNull();
  });

  it('says nothing with nothing playing, or for media the queue never had', () => {
    expect(endedQueueItemId({ queueIndex: 0, items: [A, B], mediaRef: null })).toBeNull();
    expect(
      endedQueueItemId({ queueIndex: null, items: [A, B], mediaRef: ref('elsewhere') }),
    ).toBeNull();
    expect(endedQueueItemId({ queueIndex: null, items: [], mediaRef: A.mediaRef })).toBeNull();
  });
});

/**
 * NAMING THE ITEM WHOSE LENGTH WE JUST LEARNED — the same hard question, asked
 * for the other report a client owes the room (`sync.duration`).
 *
 * It shares `playingQueueItem` with the ended intent on purpose: two locators
 * would disagree about which row is on the stage at exactly the moments that
 * matter, and a length is a FILL against one id, so a wrong row means a wrong
 * length written onto an item nobody is playing.
 *
 * Every null below is a case where saying nothing is the only honest answer.
 */
describe('durationReportFor', () => {
  const measured = (durationMs: number, items = [A, B, C], queueIndex: number | null = 0) =>
    durationReportFor({ queueIndex, items, mediaRef: A.mediaRef, durationMs });

  it('names the playing item and its length', () => {
    expect(measured(2_700_000)).toEqual({ itemId: A.id, durationMs: 2_700_000 });
  });

  it('says nothing while the length is unknown', () => {
    // 0 is every adapter's "not known yet" (pre-metadata, YouTube pre-ready)
    // and must never be sent as a fact.
    expect(measured(0)).toBeNull();
    expect(measured(-1)).toBeNull();
  });

  it('says nothing for a live stream', () => {
    // `HTMLMediaElement.duration` is Infinity there, which is not a length —
    // the contract's payload is finite().positive(), and the server's
    // unknown-duration branch is the right answer for something with no end.
    expect(measured(Number.POSITIVE_INFINITY)).toBeNull();
    expect(measured(Number.NaN)).toBeNull();
  });

  it('rounds to the integer ms the server stores', () => {
    expect(measured(1_234.6)).toEqual({ itemId: A.id, durationMs: 1_235 });
    // …and a reading that rounds away to nothing is not a length either.
    expect(measured(0.4)).toBeNull();
  });

  it('says nothing about a row whose length the room already has', () => {
    // The server writes only onto a row whose duration is unset, so a repeat
    // is a no-op it has to load the room to discover.
    const known: QueueItem = { ...A, durationMs: 2_700_000 };
    expect(
      durationReportFor({
        queueIndex: 0,
        items: [known, B],
        mediaRef: A.mediaRef,
        durationMs: 99_000,
      }),
    ).toBeNull();
  });

  it('follows the playing item through a queue that moved under it', () => {
    // [A,B,C] playing C at 2; A is removed → [B,C]. The index is out of range
    // and the media resolves it — the same rule the ended intent follows.
    expect(
      durationReportFor({ queueIndex: 2, items: [B, C], mediaRef: C.mediaRef, durationMs: 5_000 }),
    ).toEqual({ itemId: C.id, durationMs: 5_000 });
  });

  it('says nothing when no row answers to what is playing', () => {
    // A length written against the wrong id is worse than no length: the
    // server's `endingIsPlausible` then measures that item's real ending
    // against a number from a different video.
    expect(measured(5_000, [B, C], 0)).toBeNull();
    expect(
      durationReportFor({ queueIndex: 0, items: [A, B], mediaRef: null, durationMs: 5_000 }),
    ).toBeNull();
  });
});
