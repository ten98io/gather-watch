/**
 * What the phone's drift engine DECIDES — the parts of useSyncEngine that carry
 * a judgement, pulled out of the hook so this package's node-only, renderer-free
 * vitest can drive them (see vitest.config.ts, and voice-band.test.ts for the
 * same trade).
 *
 * Three decisions are pinned here, and each one was wrong before:
 *
 *  1. WHAT THE ROOM DID. `PlaybackState` names no verb — a play, a pause, a
 *     seek and a rate change are the same shape with a fresh `seq` — and the
 *     engine keyed its controller reset on that seq. Every transport press in
 *     the room therefore threw away the learned anchor and put the viewer back
 *     to frame-lock, which is the exact behaviour the elastic bands exist to
 *     prevent.
 *  2. WHETHER THERE IS A CLOCK TO CORRECT AGAINST. Before the first accepted
 *     clock.pong, `serverNow()` is this phone's own clock and the projected
 *     position is wrong by the device's skew. Correcting against it seeks the
 *     viewer somewhere nobody is, and teaches the anchor a lag that is not real.
 *  3. WHETHER A LENGTH IS WORTH SENDING. `QueueItem.durationMs` is null for
 *     nearly every row and the player is the only thing that knows better, so
 *     the phone reports it — but a live stream's Infinity and a pre-metadata 0
 *     are not lengths, and the contract would drop them at the door.
 */
import { describe, expect, it } from 'vitest';
import { ClientSyncDuration } from '@gather/contracts';
import type { MediaRef, PlaybackState, QueueItem } from '@gather/contracts';
import { DriftController, WATCH_ELASTIC } from '@gather/sync-core';
import { durationReportFor } from '../src/sync/advance';
import {
  HOST_SEEK_EPSILON_MS,
  RESYNC_DEADBAND_MS,
  classifyPlaybackChange,
  correctOnce,
  notePlaybackChange,
  resyncSeekMs,
} from '../src/sync/useSyncEngine';
import type { CorrectablePlayer } from '../src/sync/useSyncEngine';

const FEATURE: MediaRef = { kind: 'url', url: 'https://cdn.test/feature.mp4', mime: 'video/mp4' };
const SECOND: MediaRef = { kind: 'url', url: 'https://cdn.test/second.mp4', mime: 'video/mp4' };

/** Server clock at which the room's first snapshot was stamped. */
const T0 = 1_000_000;

function playing(
  positionMs: number,
  seq: number,
  opts?: { ref?: MediaRef; serverTs?: number; rate?: number },
): PlaybackState {
  return {
    mediaRef: opts?.ref ?? FEATURE,
    positionMs,
    rate: opts?.rate ?? 1,
    playing: true,
    serverTs: opts?.serverTs ?? T0,
    seq,
    queueIndex: 0,
  };
}

function paused(positionMs: number, seq: number, serverTs: number): PlaybackState {
  return {
    mediaRef: FEATURE,
    positionMs,
    rate: 1,
    playing: false,
    serverTs,
    seq,
    queueIndex: 0,
  };
}

/* ── what the room did between two snapshots ── */

describe('classifyPlaybackChange', () => {
  it('reads no previous snapshot as a track start', () => {
    expect(classifyPlaybackChange(null, playing(0, 1), T0)).toBe('track-change');
  });

  it('reads different media as a track change', () => {
    const before = playing(60_000, 1);
    const after = playing(0, 2, { ref: SECOND, serverTs: T0 + 30_000 });
    expect(classifyPlaybackChange(before, after, T0 + 30_000)).toBe('track-change');
  });

  it('reads a pause as transport, not a seek', () => {
    // The server stamps positionMs at the instant it stamps serverTs, so the
    // paused snapshot names exactly where the playing one projected to.
    const before = playing(60_000, 1);
    const after = paused(90_000, 2, T0 + 30_000);
    expect(classifyPlaybackChange(before, after, T0 + 30_000)).toBe('transport');
  });

  it('reads a resume as transport', () => {
    const before = paused(90_000, 2, T0 + 30_000);
    const after = playing(90_000, 3, { serverTs: T0 + 600_000 });
    expect(classifyPlaybackChange(before, after, T0 + 600_000)).toBe('transport');
  });

  it('reads a rate change as transport', () => {
    const before = playing(60_000, 1);
    const after = playing(90_000, 2, { serverTs: T0 + 30_000, rate: 1.5 });
    expect(classifyPlaybackChange(before, after, T0 + 30_000)).toBe('transport');
  });

  it('reads a moved playhead as a host seek', () => {
    const before = playing(60_000, 1);
    const after = playing(600_000, 2, { serverTs: T0 + 30_000 });
    expect(classifyPlaybackChange(before, after, T0 + 30_000)).toBe('host-seek');
  });

  it('puts the seek/transport line exactly at the epsilon', () => {
    const now = T0 + 30_000;
    const before = playing(60_000, 1);
    const within = playing(90_000 + HOST_SEEK_EPSILON_MS, 2, { serverTs: now });
    const beyond = playing(90_000 + HOST_SEEK_EPSILON_MS + 1, 3, { serverTs: now });
    expect(classifyPlaybackChange(before, within, now)).toBe('transport');
    expect(classifyPlaybackChange(before, beyond, now)).toBe('host-seek');
  });
});

/* ── telling the controller instead of rebuilding it ── */

/** A controller that has already learned this viewer sits `lagMs` behind. */
function anchored(lagMs: number): DriftController {
  const controller = new DriftController(WATCH_ELASTIC);
  controller.noteSettledLag(lagMs);
  return controller;
}

describe('notePlaybackChange', () => {
  it('keeps the anchor across transport', () => {
    const controller = anchored(6000);
    notePlaybackChange(controller, 'transport');
    expect(controller.anchorOffsetMs()).toBe(6000);
  });

  it('re-arms learning across transport', () => {
    // Keeping the anchor is only half of it: nothing measured across a pause
    // describes the lag after it, so adoption has to be open again.
    const controller = anchored(6000);
    expect(controller.state().anchorArmed).toBe(false);
    notePlaybackChange(controller, 'transport');
    expect(controller.state().anchorArmed).toBe(true);
  });

  it('drops the anchor on a track change', () => {
    const controller = anchored(6000);
    notePlaybackChange(controller, 'track-change');
    expect(controller.anchorOffsetMs()).toBe(0);
  });

  it('drops the anchor when the host seeks', () => {
    const controller = anchored(6000);
    notePlaybackChange(controller, 'host-seek');
    expect(controller.anchorOffsetMs()).toBe(0);
  });

  it('survives a pause in the room, end to end', () => {
    // THE REGRESSION. The engine used to call reset() on every playback epoch,
    // and every play/pause/seek/rate in the room is a new epoch: six seconds of
    // learned comfort, thrown away because somebody pressed pause.
    const controller = anchored(6000);
    const before = playing(60_000, 1);
    const after = paused(90_000, 2, T0 + 30_000);
    notePlaybackChange(controller, classifyPlaybackChange(before, after, T0 + 30_000));
    expect(controller.anchorOffsetMs()).toBe(6000);
  });
});

/* ── where the hard resync puts the player ── */

describe('resyncSeekMs', () => {
  it('leaves an anchored viewer exactly where they are', () => {
    // The other half of the same bug: protecting the anchor in the controller
    // is worth nothing if the resync still yanks the player to the room's raw
    // projection six seconds ahead.
    expect(
      resyncSeekMs({ expectedMs: 90_000, actualMs: 84_000, anchorOffsetMs: 6000 }),
    ).toBeNull();
  });

  it('snaps an unanchored viewer who is genuinely lost', () => {
    expect(resyncSeekMs({ expectedMs: 90_000, actualMs: 30_000, anchorOffsetMs: 0 })).toBe(
      90_000,
    );
  });

  it('aims at the anchored position, not the room position', () => {
    expect(resyncSeekMs({ expectedMs: 90_000, actualMs: 30_000, anchorOffsetMs: 6000 })).toBe(
      84_000,
    );
  });

  it('holds still inside the deadband', () => {
    const inside = RESYNC_DEADBAND_MS - 1;
    expect(resyncSeekMs({ expectedMs: 90_000, actualMs: 90_000 - inside, anchorOffsetMs: 0 }))
      .toBeNull();
    expect(
      resyncSeekMs({ expectedMs: 90_000, actualMs: 90_000 - RESYNC_DEADBAND_MS - 1, anchorOffsetMs: 0 }),
    ).toBe(90_000);
  });

  it('never aims before the start of the item', () => {
    // An anchor larger than the elapsed position is ordinary in the first
    // seconds of a track; a negative currentTime is not a position at all.
    expect(resyncSeekMs({ expectedMs: 1000, actualMs: 5000, anchorOffsetMs: 15_000 })).toBe(0);
  });
});

/* ── one correction pass ── */

function fakePlayer(currentTimeSec: number, durationSec: number): CorrectablePlayer {
  return { currentTime: currentTimeSec, playbackRate: 1, duration: durationSec };
}

describe('correctOnce', () => {
  it('does not correct before the clock has an estimate', () => {
    // THE REGRESSION. serverNow() is the phone's own clock until the first
    // clock.pong lands, so this "60 s behind" is the device's skew, not drift.
    // Seeking on it moves the viewer somewhere nobody is; worse, the anchor
    // learns the skew and holds them there after the estimate arrives.
    const player = fakePlayer(30, 3600);
    const sample = correctOnce({
      player,
      playback: playing(90_000, 1),
      controller: new DriftController(WATCH_ELASTIC),
      serverNowTs: T0,
      hasEstimate: false,
      ended: false,
    });
    expect(sample).toBeNull();
    expect(player.currentTime).toBe(30);
    expect(player.playbackRate).toBe(1);
  });

  it('corrects the same drift once the estimate exists', () => {
    const player = fakePlayer(30, 3600);
    const sample = correctOnce({
      player,
      playback: playing(90_000, 1),
      controller: new DriftController(WATCH_ELASTIC),
      serverNowTs: T0,
      hasEstimate: true,
      ended: false,
    });
    expect(sample).toBe(60_000);
    // 60 s is past WATCH_ELASTIC's 12 s seek threshold.
    expect(player.currentTime).toBe(90);
  });

  it('sits still once this device`s source has run out', () => {
    const player = fakePlayer(3600, 3600);
    const sample = correctOnce({
      player,
      playback: playing(7_200_000, 1),
      controller: new DriftController(WATCH_ELASTIC),
      serverNowTs: T0,
      hasEstimate: true,
      ended: true,
    });
    expect(sample).toBe(0);
    expect(player.currentTime).toBe(3600);
  });

  it('sits still while the room is paused', () => {
    const player = fakePlayer(30, 3600);
    const sample = correctOnce({
      player,
      playback: paused(90_000, 1, T0),
      controller: new DriftController(WATCH_ELASTIC),
      serverNowTs: T0,
      hasEstimate: true,
      ended: false,
    });
    expect(sample).toBe(0);
    expect(player.currentTime).toBe(30);
  });

  it('hands the item`s length to the controller as a ceiling', () => {
    // The room's projection keeps climbing after the source runs out. Without
    // the clamp this is a two-hour drift and a seek past the end once per tick,
    // and seeking a finished player is what starts it again.
    const player = fakePlayer(95, 100);
    correctOnce({
      player,
      playback: playing(7_200_000, 1),
      controller: new DriftController(WATCH_ELASTIC),
      serverNowTs: T0,
      hasEstimate: true,
      ended: false,
    });
    expect(player.currentTime).toBe(95);
  });
});

/* ── the length this device measured ── */

function item(id: string, mediaRef: MediaRef): QueueItem {
  return {
    id: id as QueueItem['id'],
    mediaRef,
    title: id,
    durationMs: null,
    artworkUrl: null,
    addedBy: 'u1' as QueueItem['addedBy'],
    votesToSkip: [],
  };
}

const QUEUE = [item('q_a', FEATURE), item('q_b', SECOND)];

describe('durationReportFor', () => {
  it('names the row the length belongs to', () => {
    expect(durationReportFor({ queueIndex: 0, items: QUEUE, mediaRef: FEATURE }, 212_345)).toEqual(
      { itemId: 'q_a', durationMs: 212_345 },
    );
  });

  it('rounds off sub-millisecond noise', () => {
    // player.duration is seconds as a float; the last decimals of a ×1000 are
    // not a fact about the item.
    expect(
      durationReportFor({ queueIndex: 1, items: QUEUE, mediaRef: SECOND }, 212_345.6)?.durationMs,
    ).toBe(212_346);
  });

  it('says nothing for a live stream', () => {
    expect(durationReportFor({ queueIndex: 0, items: QUEUE, mediaRef: FEATURE }, Infinity))
      .toBeNull();
    expect(durationReportFor({ queueIndex: 0, items: QUEUE, mediaRef: FEATURE }, NaN)).toBeNull();
  });

  it('says nothing before the player has read metadata', () => {
    expect(durationReportFor({ queueIndex: 0, items: QUEUE, mediaRef: FEATURE }, 0)).toBeNull();
    // Rounds to zero, so it must be refused AFTER rounding, not before.
    expect(durationReportFor({ queueIndex: 0, items: QUEUE, mediaRef: FEATURE }, 0.4)).toBeNull();
  });

  it('says nothing when no queue row matches what is playing', () => {
    // Vote-skip carried the playing item off. A length written onto whatever
    // row shifted into the gap becomes the end the advance guard verifies
    // against — a wrong ending for an item nobody watched.
    expect(durationReportFor({ queueIndex: 0, items: [item('q_b', SECOND)], mediaRef: FEATURE }, 1000))
      .toBeNull();
  });

  it('produces a frame the contract accepts', () => {
    const payload = durationReportFor({ queueIndex: 0, items: QUEUE, mediaRef: FEATURE }, 212_345);
    const frame = { type: 'sync.duration', roomId: 'r1', seq: 0, ts: T0, payload };
    expect(ClientSyncDuration.safeParse(frame).success).toBe(true);
  });

  it('refuses exactly what the contract refuses', () => {
    // The guard above is not a hand-copied rule: `sync.duration` pins durationMs
    // finite and positive, so an unguarded live-stream report is a frame the
    // server drops at the door and a room that stays uninformed.
    for (const durationMs of [Infinity, NaN, 0]) {
      const frame = {
        type: 'sync.duration',
        roomId: 'r1',
        seq: 0,
        ts: T0,
        payload: { itemId: 'q_a', durationMs },
      };
      expect(ClientSyncDuration.safeParse(frame).success).toBe(false);
      expect(durationReportFor({ queueIndex: 0, items: QUEUE, mediaRef: FEATURE }, durationMs))
        .toBeNull();
    }
  });
});
