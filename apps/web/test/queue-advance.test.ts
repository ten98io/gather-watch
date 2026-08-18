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
import { endedQueueItemId } from '@/lib/player/advance';

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
