/**
 * The auto-advance decision. `ended` used to reach exactly one listener in the
 * whole app, which set a local boolean — so a finished item never handed the
 * room to the next one. These are the cases that decide what "next" means when
 * the queue has moved under the playing item.
 */
import { describe, expect, it } from 'vitest';
import type { MediaRef, QueueItem, QueueItemId, UserId } from '@gather/contracts';
import { nextTrackOnEnd } from '@/lib/player/advance';

const ME = 'user-me' as UserId;

function ref(id: string): MediaRef {
  return { kind: 'youtube', videoId: id };
}

function item(id: string): QueueItem {
  return {
    id: `qi-${id}` as QueueItemId,
    mediaRef: ref(id),
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

describe('nextTrackOnEnd', () => {
  it('advances to the item after the one that just ended', () => {
    const next = nextTrackOnEnd({
      queueIndex: 0,
      items: [A, B, C],
      mediaRef: A.mediaRef,
      isAdvancer: true,
    });
    expect(next).toEqual({ index: 1, item: B });
  });

  it('advances the last item to nothing — the room pauses instead of looping', () => {
    expect(
      nextTrackOnEnd({
        queueIndex: 2,
        items: [A, B, C],
        mediaRef: C.mediaRef,
        isAdvancer: true,
      }),
    ).toBeNull();
    // An empty queue has no successor either.
    expect(
      nextTrackOnEnd({ queueIndex: null, items: [], mediaRef: A.mediaRef, isAdvancer: true }),
    ).toBeNull();
  });

  it('resolves the playing item by media when no index was recorded', () => {
    // A setTrack of kind 'media' stores queueIndex: null.
    expect(
      nextTrackOnEnd({
        queueIndex: null,
        items: [A, B, C],
        mediaRef: B.mediaRef,
        isAdvancer: true,
      }),
    ).toEqual({ index: 2, item: C });
  });

  it('prefers the recorded index when the same media sits in the queue twice', () => {
    // Naively searching by media would advance from the first copy every time
    // and replay the item in between.
    expect(
      nextTrackOnEnd({
        queueIndex: 2,
        items: [A, B, A, C],
        mediaRef: A.mediaRef,
        isAdvancer: true,
      }),
    ).toEqual({ index: 3, item: C });
  });

  it('survives a vote-skip: neither a repeat nor a double-skip', () => {
    // Vote-skip removes the PLAYING item from the array and leaves
    // playback.queueIndex untouched, so the stored index is stale the instant
    // anyone skips. [A,B,C] playing A at 0 → A voted out → [B,C].
    const next = nextTrackOnEnd({
      queueIndex: 0,
      items: [B, C],
      mediaRef: A.mediaRef,
      isAdvancer: true,
    });
    expect(next).toEqual({ index: 0, item: B });
    // Not the item that just ended…
    expect(next?.item.id).not.toBe(A.id);
    // …and not the one after the item nobody voted out.
    expect(next?.item.id).not.toBe(C.id);
  });

  it('follows an item that shifted down when an earlier item was removed', () => {
    // [A,B,C] playing C at 2; A is removed → [B,C]. The stale index is out of
    // range, and resolving by media finds C at 1 with nothing after it.
    expect(
      nextTrackOnEnd({
        queueIndex: 2,
        items: [B, C],
        mediaRef: C.mediaRef,
        isAdvancer: true,
      }),
    ).toBeNull();
  });

  it('does not advance from a client that is not the designated advancer', () => {
    expect(
      nextTrackOnEnd({
        queueIndex: 0,
        items: [A, B, C],
        mediaRef: A.mediaRef,
        isAdvancer: false,
      }),
    ).toBeNull();
  });

  it('does not advance with nothing playing, or from media the queue never had', () => {
    expect(
      nextTrackOnEnd({ queueIndex: 0, items: [A, B], mediaRef: null, isAdvancer: true }),
    ).toBeNull();
    // A one-off 'media' setTrack (no index) for something outside the queue:
    // there is no successor to reason about.
    expect(
      nextTrackOnEnd({
        queueIndex: null,
        items: [A, B],
        mediaRef: ref('elsewhere'),
        isAdvancer: true,
      }),
    ).toBeNull();
  });

  it('stops rather than guessing once the server has nulled a removed index', () => {
    // services/api realigns queueIndex after a queue mutation and nulls it when
    // the PLAYING item was the one removed. That is the honest bookkeeping
    // answer, and it also destroys the last record of where the item sat — so
    // there is no successor to name. Stopping is right; index 0 would restart
    // the queue from the top.
    expect(
      nextTrackOnEnd({ queueIndex: null, items: [B, C], mediaRef: A.mediaRef, isAdvancer: true }),
    ).toBeNull();
  });
});
