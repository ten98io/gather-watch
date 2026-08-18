/**
 * `playback.queueIndex` is a raw ARRAY INDEX into the queue, so every mutation
 * that shifts the array silently repoints it at a different track. The
 * reported symptom: delete an already-played item ABOVE the playing one and
 * the now-playing highlight jumps to the row BELOW the real one, because the
 * index kept its number while the array moved under it.
 *
 * These are pure tests of the correction. The integration side (that remove /
 * reorder / voteSkip actually route through it, and that the corrected
 * snapshot reaches clients with an ADVANCED seq — applyServerState drops a
 * snapshot whose seq did not move) is covered in queue.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { PlaybackState, QueueItem, QueueItemId } from '@gather/contracts';
import { expectedPositionMs } from '@gather/sync-core';
import { realignedQueueIndex } from '../src/modules/queue/service';

function item(id: string): QueueItem {
  return {
    id: id as QueueItemId,
    mediaRef: { kind: 'youtube', videoId: `vid-${id}` },
    title: `Track ${id}`,
    durationMs: null,
    artworkUrl: null,
    addedBy: 'u1' as QueueItem['addedBy'],
    votesToSkip: [],
  };
}

function playbackAt(queueIndex: number | null): PlaybackState {
  return {
    mediaRef: { kind: 'youtube', videoId: 'playing' },
    positionMs: 12_000,
    rate: 1,
    playing: true,
    serverTs: 1_000,
    seq: 7,
    queueIndex,
  };
}

const abcd = [item('a'), item('b'), item('c'), item('d')];

describe('realignedQueueIndex', () => {
  it('follows the playing track when an item above it is deleted', () => {
    // Playing 'c' (index 2). Delete 'a' — 'c' is now index 1.
    const next = [item('b'), item('c'), item('d')];
    expect(realignedQueueIndex(playbackAt(2), abcd, next)).toBe(1);
  });

  it('follows the playing track across a reorder', () => {
    // Playing 'c' (index 2), queue reversed — 'c' is now index 1.
    const next = [item('d'), item('c'), item('b'), item('a')];
    expect(realignedQueueIndex(playbackAt(2), abcd, next)).toBe(1);
  });

  it('does nothing when an item BELOW the playing one is deleted', () => {
    // Playing 'b' (index 1). Delete 'd' — 'b' has not moved.
    const next = [item('a'), item('b'), item('c')];
    expect(realignedQueueIndex(playbackAt(1), abcd, next)).toBeUndefined();
  });

  it('does nothing when the queue is only appended to', () => {
    const next = [...abcd, item('e')];
    expect(realignedQueueIndex(playbackAt(2), abcd, next)).toBeUndefined();
  });

  it('detaches the highlight when the playing item itself is removed', () => {
    // A vote-skip of the current track. Advancing to a successor is a
    // PLAYBACK decision (auto-advance owns it); the honest bookkeeping answer
    // is that no row is the playing one. Notably this must NOT return the same
    // index, which would silently claim the next track is playing while the
    // removed one is still on the stage.
    const next = [item('a'), item('b'), item('d')];
    expect(realignedQueueIndex(playbackAt(2), abcd, next)).toBeNull();
  });

  it('leaves a room with no playback alone', () => {
    expect(realignedQueueIndex(null, abcd, [item('a')])).toBeUndefined();
  });

  it('leaves an index-less playback alone (setTrack of kind "media")', () => {
    expect(realignedQueueIndex(playbackAt(null), abcd, [item('a')])).toBeUndefined();
  });

  it('leaves an already-stale index alone rather than guessing', () => {
    // Index 9 names nothing in the previous queue, so there is no identity to
    // follow. Inventing one would be worse than leaving it for a real setTrack.
    expect(realignedQueueIndex(playbackAt(9), abcd, abcd)).toBeUndefined();
  });

  it('handles the queue being emptied', () => {
    expect(realignedQueueIndex(playbackAt(2), abcd, [])).toBeNull();
  });
});

/**
 * `positionMs` and `serverTs` are ONE anchor, not two fields: clients project
 * `positionMs + (now - serverTs)`. Re-stamping serverTs while carrying the old
 * positionMs forward rewinds the room by however long the item had been
 * playing — so a queue edit would drag every viewer back to wherever the track
 * was when that snapshot was minted. This pins the pair moving together.
 */
describe('the playback anchor a realignment re-stamps', () => {
  it('projects the position forward by exactly the time that passed', () => {
    const prev = playbackAt(2); // positionMs 12_000 at serverTs 1_000
    const now = 1_000 + 30_000; // 30s later
    expect(expectedPositionMs(prev, now)).toBe(42_000);
  });

  it('does not advance a PAUSED room', () => {
    const paused: PlaybackState = { ...playbackAt(2), playing: false };
    expect(expectedPositionMs(paused, 1_000 + 30_000)).toBe(12_000);
  });

  it('respects a non-1 playback rate', () => {
    const fast: PlaybackState = { ...playbackAt(2), rate: 2 };
    expect(expectedPositionMs(fast, 1_000 + 10_000)).toBe(32_000);
  });

  it('a stale pair would rewind — this is the regression being guarded', () => {
    const prev = playbackAt(2);
    const now = 1_000 + 30_000;
    // What a naive `{...prev, serverTs: now}` would publish: the position the
    // track held 30s ago, re-anchored to NOW. Every client jumps backwards.
    const naiveProjectedAtPublish = prev.positionMs;
    expect(naiveProjectedAtPublish).toBeLessThan(expectedPositionMs(prev, now));
    expect(expectedPositionMs(prev, now) - naiveProjectedAtPublish).toBe(30_000);
  });
});
