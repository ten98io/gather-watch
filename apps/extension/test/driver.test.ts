import { describe, expect, it } from 'vitest';

import {
  ElasticDriver,
  INTENT_ECHO_WINDOW_MS,
  INTERSTITIAL_MAX_DURATION_MS,
  INTERSTITIAL_PROJECTION_SLACK_MS,
  MediaEndDetector,
  MIN_SEEK_INTERVAL_MS,
  OBSERVER_CAPABILITIES,
  SYNC_PRESETS,
  TELEMETRY_STALE_MS,
  appliesVerbatim,
  elasticDecision,
  isInterstitialSource,
  mediaKeyOf,
  parseElasticDirective,
  profileForContent,
  projectedPositionMs,
  syncStatusLabel,
  voiceActiveFrom,
} from '../src/driver';
import type {
  DriveCommand,
  DriveReason,
  DriverTelemetry,
  ElasticDirective,
  ObservedEnd,
  RoomFrame,
} from '../src/driver';
import { LEGACY_BANDS, decideDrive } from '../src/mediaDriver';

/* ── a player that can be told to misbehave in the ways real ones do ── */

interface SimOptions {
  ticks: number;
  /** How far behind the room the player starts (ms). */
  lagMs?: number;
  tickMs?: number;
  roomRate?: number;
  /** false = accepts `playbackRate` and ignores it, like a DRM player. */
  honoursRate?: boolean;
  /** false = the seek does not land. */
  honoursSeek?: boolean;
  /** How stale each telemetry sample is when the tick reads it. */
  telemetryAgeMs?: number;
  /** Tick indices during which the player does not advance at all. */
  stallTicks?: readonly number[];
  /** The player is paused even though the room is playing. */
  playerPaused?: boolean;
  /** Which item the room is on throughout. Defaults to a YouTube video. */
  mediaKey?: string | null;
}

interface SimResult {
  commands: DriveCommand[];
  /** Telemetry as it was handed to the driver, tick by tick. */
  samples: DriverTelemetry[];
  finalPositionMs: number;
  finalExpectedMs: number;
}

const START_NOW = 1_700_000_000_000;
const START_EXPECTED = 600_000;

function simulate(driver: ElasticDriver, opts: SimOptions): SimResult {
  const tickMs = opts.tickMs ?? 1000;
  const roomRate = opts.roomRate ?? 1;
  const honoursRate = opts.honoursRate ?? true;
  const honoursSeek = opts.honoursSeek ?? true;
  const age = opts.telemetryAgeMs ?? 0;
  const stalls = new Set(opts.stallTicks ?? []);
  const playing = !(opts.playerPaused ?? false);

  let now = START_NOW;
  let expected = START_EXPECTED;
  let position = START_EXPECTED - (opts.lagMs ?? 0);
  let rate = 1;

  const commands: DriveCommand[] = [];
  const samples: DriverTelemetry[] = [];

  for (let i = 0; i < opts.ticks; i += 1) {
    const stalled = stalls.has(i);
    // The sample was captured `age` ms ago, so it reports the position the
    // player had then — exactly the staleness the background worker sees.
    const sample: DriverTelemetry = {
      positionMs: playing && !stalled ? position - age * rate : position,
      durationMs: 5_400_000,
      playing,
      rate,
      atMs: now - age,
    };
    samples.push(sample);

    const room: RoomFrame = {
      expectedMs: expected,
      playing: true,
      rate: roomRate,
      mediaKey: opts.mediaKey === undefined ? 'yt:abc' : opts.mediaKey,
    };
    const cmd = driver.tick(room, sample, now);
    commands.push(cmd);

    if (cmd.seekToMs !== null && honoursSeek) position = cmd.seekToMs;
    if (cmd.setRate !== null && honoursRate) rate = cmd.setRate;

    now += tickMs;
    expected += tickMs * roomRate;
    if (playing && !stalled) position += tickMs * rate;
  }

  return { commands, samples, finalPositionMs: position, finalExpectedMs: expected };
}

function seeks(commands: readonly DriveCommand[]): DriveCommand[] {
  return commands.filter((c) => c.seekToMs !== null);
}

/* ─────────────────────────────── the bands ──────────────────────────────── */

describe('sync presets', () => {
  it('carries the retuned elastic bands, not frame-lock', () => {
    expect(SYNC_PRESETS.watch.deadbandMs).toBe(2000);
    expect(SYNC_PRESETS.watch.seekThresholdMs).toBe(12_000);
    expect(SYNC_PRESETS.watch.minRate).toBe(0.97);
    expect(SYNC_PRESETS.watch.maxRate).toBe(1.03);
    // Music: tighter position bands, far tighter rate authority (pitch).
    expect(SYNC_PRESETS.listen.deadbandMs).toBe(1500);
    expect(SYNC_PRESETS.listen.seekThresholdMs).toBe(8000);
    expect(SYNC_PRESETS.listen.minRate).toBe(0.99);
    expect(SYNC_PRESETS.listen.maxRate).toBe(1.01);
    expect(SYNC_PRESETS.strict.anchorEnabled).toBe(false);
  });
});

describe('profileForContent', () => {
  it('follows the room kind when it is known', () => {
    expect(profileForContent({ roomKind: 'listen', mediaTag: 'video' })).toBe('listen');
    expect(profileForContent({ roomKind: 'watch', providerId: 'spotify' })).toBe('watch');
  });

  it('reads an audio element or a music service as a listen room', () => {
    expect(profileForContent({ mediaTag: 'audio' })).toBe('listen');
    expect(profileForContent({ providerId: 'soundcloud' })).toBe('listen');
    expect(profileForContent({ providerId: 'youtubemusic' })).toBe('listen');
  });

  it('defaults to watch for video and for anything unknown', () => {
    expect(profileForContent({})).toBe('watch');
    expect(profileForContent({ providerId: 'netflix', mediaTag: 'video' })).toBe('watch');
    expect(profileForContent({ providerId: null, mediaTag: null })).toBe('watch');
  });
});

describe('mediaKeyOf', () => {
  it('identifies the media, not the transport state', () => {
    expect(mediaKeyOf(null)).toBeNull();
    expect(mediaKeyOf({ kind: 'youtube', videoId: 'abc' })).toBe('youtube:abc');
    expect(mediaKeyOf({ kind: 'hls', assetId: 'a1' as never, url: 'https://x/y.m3u8' })).toBe(
      'hls:a1',
    );
    expect(
      mediaKeyOf({
        kind: 'embed',
        provider: 'spotify',
        embedUrl: 'https://open.spotify.com/embed/track/1',
        title: null,
      }),
    ).toBe('embed:spotify:https://open.spotify.com/embed/track/1');
  });

  /**
   * A page ref is the whole point of the generic driver: an arbitrary site
   * with a <video> in it. Two different pages must not share a key, or moving
   * between them is invisible to the driver and it keeps the anchor it learned
   * on the previous item.
   */
  it('names a plain web page by its url', () => {
    expect(mediaKeyOf({ kind: 'page', url: 'https://example.com/watch' })).toBe(
      'page:https://example.com/watch',
    );
    expect(mediaKeyOf({ kind: 'page', url: 'https://example.com/a' })).not.toBe(
      mediaKeyOf({ kind: 'page', url: 'https://example.com/b' }),
    );
  });

  /**
   * What a shared key costs, concretely. A key change is how the driver learns
   * that the player in front of it is a NEW one — it then forgets what it
   * learned about the last one (see noteTrackChange → forgetPlayerBeliefs). A
   * page with no key of its own kept every page in a room looking like one
   * endless item, so a site whose player had refused a seek condemned every
   * page queued after it to be driven as unseekable too.
   */
  it('lets the driver see one page ending and another starting', () => {
    /** Learn on a player that ignores seeks while the room is on `first`, then
     *  move the room to `second` and report whether seeking is back on. */
    const seekableAfter = (first: string | null, second: string | null): boolean => {
      const driver = new ElasticDriver({ profile: 'watch' });
      simulate(driver, { ticks: 60, lagMs: 30_000, honoursSeek: false, mediaKey: first });
      expect(driver.state().seekAvailable).toBe(false);
      const now = START_NOW + 60_000;
      driver.tick(
        { expectedMs: 1000, playing: true, rate: 1, mediaKey: second },
        { positionMs: 1000, durationMs: 60_000, playing: true, rate: 1, atMs: now },
        now,
      );
      return driver.state().seekAvailable;
    };

    const a = mediaKeyOf({ kind: 'page', url: 'https://a' });
    const b = mediaKeyOf({ kind: 'page', url: 'https://b' });
    // A different page is a different player: it gets the benefit of the doubt.
    expect(seekableAfter(a, b)).toBe(true);
    // The control, and the exact shape of the defect: pages that key the same
    // — which is what every page did — inherit the last one's verdict.
    expect(seekableAfter(a, a)).toBe(false);
    expect(seekableAfter(null, null)).toBe(false);
  });
});

describe('voiceActiveFrom', () => {
  const entry = (userId: string, micOn: boolean, state = 'watching') => ({ userId, state, micOn });

  it('is false when nobody is on mic', () => {
    expect(voiceActiveFrom([entry('a', false), entry('b', false)])).toBe(false);
    expect(voiceActiveFrom([])).toBe(false);
  });

  it('is true as soon as anybody in a shared room is on mic', () => {
    expect(voiceActiveFrom([entry('a', true), entry('b', false)])).toBe(true);
    expect(voiceActiveFrom([entry('a', false), entry('b', true)])).toBe(true);
  });

  it('ignores offline members, and a mic with nobody to talk to', () => {
    // Talking alone is not a conversation: nothing to stay in step with.
    expect(voiceActiveFrom([entry('a', true)])).toBe(false);
    expect(voiceActiveFrom([entry('a', true), entry('b', true, 'offline')])).toBe(false);
  });
});

/* ─────────────────────────── the elastic driver ─────────────────────────── */

describe('ElasticDriver — a viewer 8 s behind', () => {
  it('converges without ever seeking, by learning the offset', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const { commands } = simulate(driver, { ticks: 30, lagMs: 8000 });

    expect(seeks(commands)).toHaveLength(0);
    expect(commands.some((c) => c.reason === 'nudge')).toBe(true);

    // The lag was adopted rather than fought: that is the whole point.
    expect(driver.state().anchorOffsetMs).toBeGreaterThan(4000);
    expect(driver.state().anchorOffsetMs).toBeLessThanOrEqual(8000);

    // …and once it is adopted the player is left completely alone.
    expect(commands.slice(-6).every((c) => c.idle)).toBe(true);
  });

  it('would have hard-seeked under the old fixed thresholds', () => {
    // 8 s is four times the legacy hard-seek threshold. This is the behaviour
    // docs/EXTENSION_FIRST.md rejects, kept here as the contrast.
    const legacy = decideDrive(
      { positionMs: 592_000, durationMs: 5_400_000, playing: true, rate: 1, volume: 1, muted: false },
      600_000,
      { playing: true, rate: 1 },
      LEGACY_BANDS,
    );
    expect(legacy.seekToMs).toBe(600_000);
  });

  it('seeks only when genuinely lost (past 12 s)', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const { commands } = simulate(driver, { ticks: 4, lagMs: 30_000 });
    const seeked = seeks(commands);
    expect(seeked.length).toBeGreaterThan(0);
    expect(seeked[0]?.reason).toBe('seek');
  });
});

describe('ElasticDriver — a player that ignores playbackRate', () => {
  it('stops being nudged once the read-back proves the assignment was dropped', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const { commands } = simulate(driver, { ticks: 20, lagMs: 5000, honoursRate: false });

    // Exactly one attempt: prescribe, read back, conclude.
    expect(commands.filter((c) => c.setRate !== null)).toHaveLength(1);
    expect(commands[0]?.setRate).toBeCloseTo(1.03, 5);
    expect(commands.slice(1).every((c) => c.setRate === null)).toBe(true);

    // The capability is now reported honestly…
    expect(driver.capabilities().canSetRate).toBe(false);
    // …and the offset is absorbed by the anchor instead of by repeated seeks.
    expect(seeks(commands)).toHaveLength(0);
    expect(driver.state().anchorOffsetMs).toBeGreaterThan(2000);
    expect(commands.some((c) => c.reason === 'rate-locked')).toBe(true);
  });

  it('does not mistake the user changing speed for a refusal', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const room: RoomFrame = { expectedMs: 100_000, playing: true, rate: 1, mediaKey: 'm' };
    const first = driver.tick(
      room,
      { positionMs: 95_000, durationMs: 0, playing: true, rate: 1, atMs: START_NOW },
      START_NOW,
    );
    expect(first.setRate).not.toBeNull();
    // The player reports 1.5 — it moved, so the assignment was not ignored;
    // somebody pressed the site's own speed control.
    driver.tick(
      { ...room, expectedMs: 101_000 },
      { positionMs: 96_500, durationMs: 0, playing: true, rate: 1.5, atMs: START_NOW + 1000 },
      START_NOW + 1000,
    );
    expect(driver.capabilities().canSetRate).toBe(true);
  });
});

describe('ElasticDriver — live voice (Consequence B)', () => {
  it('holds the seek while anybody is on mic, and converges with rate instead', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    driver.setVoiceActive(true);
    const { commands } = simulate(driver, { ticks: 40, lagMs: 20_000 });

    expect(seeks(commands)).toHaveLength(0);
    expect(commands.some((c) => c.reason === 'nudge')).toBe(true);
    expect(driver.state().voiceTightening).toBe(true);
    // The band tightened: the anchor is squeezed toward the voice target
    // rather than parking the viewer 20 s back.
    expect(Math.abs(driver.state().anchorOffsetMs)).toBeLessThanOrEqual(1000);
  });

  it('does seek at the same drift once the room goes quiet', () => {
    const quiet = new ElasticDriver({ profile: 'watch' });
    const { commands } = simulate(quiet, { ticks: 4, lagMs: 20_000 });
    expect(seeks(commands).length).toBeGreaterThan(0);
  });

  /**
   * Suppression protects a live reaction, and past a point there is no longer
   * one to protect: sync-core lifts it above `voiceSeekCeilingMs` (30 s, twice
   * the largest lag the elastic design will deliberately hold) because rate
   * alone cannot rescue a viewer that far back — five minutes at the watch
   * band's ±3% is over two hours of playback. The extension used to ask the
   * voice question a SECOND time in its own seek gate and refuse every one of
   * those rescues, so a viewer who lost five minutes to a stall stayed lost
   * for as long as anybody in the room held a mic open.
   */
  it('seeks a viewer minutes behind even while somebody is on mic', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    driver.setVoiceActive(true);
    const { commands } = simulate(driver, { ticks: 4, lagMs: 300_000 });

    expect(seeks(commands).length).toBeGreaterThan(0);
    expect(driver.state().voiceTightening).toBe(true);
  });

  it('still refuses that seek when the player itself cannot seek', () => {
    const driver = new ElasticDriver({ profile: 'watch', capabilities: { canSeek: false } });
    driver.setVoiceActive(true);
    const { commands } = simulate(driver, { ticks: 4, lagMs: 300_000 });

    // The controller's decision is not authority over the player: what this
    // driver knows about the element outranks it, mic or no mic.
    expect(seeks(commands)).toHaveLength(0);
    expect(commands.some((c) => c.reason === 'seek-suppressed')).toBe(true);
  });
});

/**
 * Telemetry crosses a process boundary: the content script reads the element,
 * posts it, and the worker decides against that reading some time later —
 * while the media kept playing. Measuring at the reading rather than at the
 * decision therefore reports a lag equal to the sample's age, in the one
 * direction that prescribes a speed-up or a seek.
 */
describe('ElasticDriver — the sample is measured at the decision, not at capture', () => {
  it('leaves a viewer who is exactly in sync alone, however stale the sample', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    // Read 3.9 s before the decision it feeds — the oldest a sample can be
    // and still be used at all (TELEMETRY_STALE_MS).
    const { commands } = simulate(driver, { ticks: 20, lagMs: 0, telemetryAgeMs: 3900 });

    expect(commands.every((c) => c.reason === 'idle')).toBe(true);
    expect(commands.every((c) => c.driftMs === 0)).toBe(true);
  });

  it('does not seek on a lag the sample only appears to have', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const now = START_NOW;
    // Read a second ago at 587.5 s, still playing: the element is at 588.5 s
    // now, 11.5 s behind the room — inside the watch band's 12 s seek escape.
    // Read as it stands, it is 12.5 s behind and gets a seek nobody needed.
    const cmd = driver.tick(
      { expectedMs: 600_000, playing: true, rate: 1, mediaKey: 'yt:abc' },
      { positionMs: 587_500, durationMs: 5_400_000, playing: true, rate: 1, atMs: now - 1000 },
      now,
    );

    expect(cmd.seekToMs).toBeNull();
    expect(cmd.reason).toBe('nudge');
    expect(cmd.driftMs).toBeCloseTo(11_500, 5);
  });

  it('projects nothing out of a player that is not playing', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const now = START_NOW;
    // A paused room and a paused player. Three seconds passed since the
    // reading and the element moved not one frame in them: projecting a
    // paused player invents playback that never happened, and would talk this
    // 12.5 s gap down under the seek escape.
    const cmd = driver.tick(
      { expectedMs: 600_000, playing: false, rate: 1, mediaKey: 'yt:abc' },
      { positionMs: 587_500, durationMs: 5_400_000, playing: false, rate: 1, atMs: now - 3000 },
      now,
    );

    expect(cmd.seekToMs).toBe(600_000);
    expect(cmd.driftMs).toBeCloseTo(12_500, 5);
  });

  it('never projects a sample past the end of the item', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const now = START_NOW;
    // Two seconds of item left when it was read three seconds ago: the
    // element is sitting on its last frame, not a second past an end that
    // does not exist. The room's projection is clamped to the same end, so
    // the honest answer for a finished item is a drift of zero — not a
    // viewer who is somehow ahead of a room that is simply over.
    const cmd = driver.tick(
      { expectedMs: 130_000, playing: true, rate: 1, mediaKey: 'yt:abc' },
      { positionMs: 98_000, durationMs: 100_000, playing: true, rate: 1, atMs: now - 3000 },
      now,
    );

    expect(cmd.driftMs).toBe(0);
    expect(cmd.seekToMs).toBeNull();
  });
});

describe('ElasticDriver — host intent', () => {
  it('re-anchors on a host seek and catches the viewer up', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    // Settle at an 8 s offset first.
    const sim = simulate(driver, { ticks: 12, lagMs: 8000 });
    expect(driver.state().anchorOffsetMs).toBeGreaterThan(4000);

    // The host jumps the room forward five minutes on the very next tick. The
    // room's timeline is discontinuous; ours is not — which is exactly how a
    // host seek is told apart from a correction we prescribed ourselves.
    const now = START_NOW + 12_000;
    const target = sim.finalExpectedMs + 300_000;
    const jumped = driver.tick(
      { expectedMs: target, playing: true, rate: 1, mediaKey: 'yt:abc' },
      {
        positionMs: sim.finalPositionMs,
        durationMs: 5_400_000,
        playing: true,
        rate: 1,
        atMs: now,
      },
      now,
    );

    expect(driver.state().anchorOffsetMs).toBe(0);
    expect(jumped.seekToMs).toBe(target);
    expect(jumped.reason).toBe('seek');
  });

  it('treats a new mediaKey as a track change and forgets the old offset', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    simulate(driver, { ticks: 12, lagMs: 8000 });
    expect(driver.state().anchorOffsetMs).toBeGreaterThan(0);

    const now = START_NOW + 12_000;
    driver.tick(
      { expectedMs: 0, playing: true, rate: 1, mediaKey: 'yt:next' },
      { positionMs: 0, durationMs: 0, playing: true, rate: 1, atMs: now },
      now,
    );
    expect(driver.state().anchorOffsetMs).toBe(0);
  });

  it('applies play/pause immediately, outside the comfort band', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const now = START_NOW;
    const playCmd = driver.tick(
      { expectedMs: 100_000, playing: true, rate: 1, mediaKey: 'm' },
      { positionMs: 99_900, durationMs: 0, playing: false, rate: 1, atMs: now },
      now,
    );
    expect(playCmd.transport).toBe('play');
    expect(playCmd.reason).toBe('transport');
    expect(playCmd.idle).toBe(false);

    const pauseCmd = driver.tick(
      { expectedMs: 100_000, playing: false, rate: 1, mediaKey: 'm' },
      { positionMs: 100_000, durationMs: 0, playing: true, rate: 1, atMs: now + 1000 },
      now + 1000,
    );
    expect(pauseCmd.transport).toBe('pause');
    expect(pauseCmd.seekToMs).toBeNull();
  });

  it('realigns on resume when the player sat paused through a long gap', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const now = START_NOW;
    const cmd = driver.tick(
      { expectedMs: 130_000, playing: true, rate: 1, mediaKey: 'm' },
      { positionMs: 100_000, durationMs: 0, playing: false, rate: 1, atMs: now },
      now,
    );
    expect(cmd.transport).toBe('play');
    expect(cmd.seekToMs).toBe(130_000);
  });
});

describe("ElasticDriver — the user's own intent", () => {
  const playingRoom = (expectedMs: number): RoomFrame => ({
    expectedMs,
    playing: true,
    rate: 1,
    mediaKey: 'yt:abc',
  });
  const sample = (positionMs: number, playing: boolean, atMs: number): DriverTelemetry => ({
    positionMs,
    durationMs: 5_400_000,
    playing,
    rate: 1,
    atMs,
  });

  /** A driver one aligned, playing tick into a room. */
  function settled(now: number): ElasticDriver {
    const driver = new ElasticDriver({ profile: 'watch' });
    driver.tick(playingRoom(600_000), sample(600_000, true, now), now);
    return driver;
  }

  it('does not fight a forwarded pause while the room echoes it back', () => {
    const now = START_NOW;
    const driver = settled(now);

    // The user paused the site's player at 600_400; the intent went to the
    // room. The next tick still sees the ROOM playing — the echo is in flight.
    driver.noteLocalIntent('pause', 600_400, now + 400);
    const cmd = driver.tick(playingRoom(601_000), sample(600_400, false, now + 1000), now + 1000);

    expect(cmd.transport).toBe('none');
    expect(cmd.idle).toBe(true);
    expect(cmd.reason).toBe('user-intent');
  });

  it('resumes correcting when the room never echoed — the room said no', () => {
    const now = START_NOW;
    const driver = settled(now);
    driver.noteLocalIntent('pause', 600_400, now + 400);

    const at = now + 400 + INTENT_ECHO_WINDOW_MS + 100;
    const cmd = driver.tick(playingRoom(601_000), sample(600_400, false, at), at);

    expect(cmd.transport).toBe('play');
    expect(cmd.reason).toBe('transport');
  });

  it('stands down once the echo arrives, and the shield does not linger', () => {
    const now = START_NOW;
    const driver = settled(now);
    driver.noteLocalIntent('pause', 600_400, now + 400);

    // The echo: the room is paused where the user paused. Nothing to fight.
    const echoed = driver.tick(
      { expectedMs: 600_400, playing: false, rate: 1, mediaKey: 'yt:abc' },
      sample(600_400, false, now + 1000),
      now + 1000,
    );
    expect(echoed.reason).not.toBe('user-intent');
    expect(echoed.transport).toBe('none');

    // The shield is spent: a later mismatch is ordinary drift again.
    const later = driver.tick(playingRoom(602_000), sample(600_400, false, now + 2000), now + 2000);
    expect(later.transport).toBe('play');
  });

  it('shields a forwarded seek from being yanked back, then adopts the echo', () => {
    const now = START_NOW;
    const driver = settled(now);

    // The user scrubbed five minutes ahead; a seek back would be the yank.
    driver.noteLocalIntent('seek', 900_000, now + 500);
    const shielded = driver.tick(playingRoom(601_000), sample(900_500, true, now + 1000), now + 1000);
    expect(shielded.seekToMs).toBeNull();
    expect(shielded.reason).toBe('user-intent');

    // The echo lands: the room's timeline is now the user's. No correction.
    const echoed = driver.tick(playingRoom(901_500), sample(901_500, true, now + 2000), now + 2000);
    expect(echoed.reason).not.toBe('user-intent');
    expect(echoed.seekToMs).toBeNull();
    expect(echoed.transport).toBe('none');
  });

  it('a newer gesture supersedes the pending one', () => {
    const now = START_NOW;
    const driver = settled(now);
    driver.noteLocalIntent('pause', 600_400, now + 400);
    // The user changed their mind and pressed play again; the room echoes a
    // playing state — which must satisfy the CURRENT intent, not the old one.
    driver.noteLocalIntent('play', 600_400, now + 800);
    const cmd = driver.tick(playingRoom(601_000), sample(600_500, true, now + 1000), now + 1000);
    expect(cmd.reason).not.toBe('user-intent');
  });
});

describe('ElasticDriver — honest stops', () => {
  it('never corrects into a stall', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const { commands } = simulate(driver, {
      ticks: 8,
      lagMs: 0,
      stallTicks: [3, 4, 5],
    });
    const stalledTicks = commands.filter((c) => c.reason === 'stalled');
    expect(stalledTicks.length).toBeGreaterThan(0);
    expect(stalledTicks.every((c) => c.idle)).toBe(true);
    expect(driver.state().stalled).toBe(false); // recovered by the last tick
  });

  it('stops asking for seeks a player keeps ignoring, and adopts the lag', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const { commands } = simulate(driver, {
      ticks: 60,
      lagMs: 30_000,
      honoursSeek: false,
      honoursRate: false,
    });
    // Bounded, not one per tick — and it gives up rather than seeking forever.
    expect(seeks(commands).length).toBeLessThanOrEqual(3);
    expect(driver.state().seekAvailable).toBe(false);
    expect(commands.some((c) => c.reason === 'seek-suppressed')).toBe(true);
    expect(driver.state().anchorOffsetMs).not.toBe(0);
  });

  it('throttles seeks so a fighting player cannot be stormed', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const { commands } = simulate(driver, { ticks: 4, lagMs: 30_000, honoursSeek: false });
    const seeked = seeks(commands);
    expect(seeked).toHaveLength(1);
    expect(MIN_SEEK_INTERVAL_MS).toBeGreaterThanOrEqual(4000);
  });

  it('falls back to plain follow-the-room when nothing reports back', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const now = START_NOW;
    const cmd = driver.tick(
      { expectedMs: 100_000, playing: true, rate: 1, mediaKey: 'm' },
      null,
      now,
    );
    expect(cmd.reason).toBe('no-telemetry');
    expect(cmd.wirePositionMs).toBe(100_000);
    // Stale telemetry is the same as no telemetry.
    const stale = driver.tick(
      { expectedMs: 101_000, playing: true, rate: 1, mediaKey: 'm' },
      {
        positionMs: 40_000,
        durationMs: 0,
        playing: true,
        rate: 1,
        atMs: now - TELEMETRY_STALE_MS - 1,
      },
      now + 1000,
    );
    expect(stale.reason).toBe('no-telemetry');
  });

  it('treats a long gap between ticks as a wake, not as drift', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    simulate(driver, { ticks: 12, lagMs: 8000 });
    const anchored = driver.state().anchorOffsetMs;
    expect(anchored).toBeGreaterThan(0);

    // The service worker was terminated for a minute and came back.
    const now = START_NOW + 120_000;
    const cmd = driver.tick(
      { expectedMs: 720_000, playing: true, rate: 1, mediaKey: 'yt:abc' },
      { positionMs: 712_000, durationMs: 0, playing: true, rate: 1, atMs: now },
      now,
    );
    // No panic seek: an 8 s offset is still inside the elastic band.
    expect(cmd.seekToMs).toBeNull();
  });
});

/**
 * E9. The room's position keeps being projected forward after the source runs
 * out, so an unclamped expectation reads as "this viewer is minutes behind"
 * forever — and the prescription for that is a seek past the end, which is
 * what starts a finished player again. The controller has a terminal state for
 * exactly this; the extension is the surface that has to hand it the length.
 */
describe('ElasticDriver — the end of an item', () => {
  const ended = (durationMs: number, atMs: number): DriverTelemetry => ({
    positionMs: durationMs,
    durationMs,
    playing: false,
    rate: 1,
    atMs,
  });

  it('does not chase a room position that has run past the end of the item', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const now = START_NOW;
    // The room is 30 s past a 100 s item — far outside the 12 s seek band.
    const cmd = driver.tick(
      { expectedMs: 130_000, playing: false, rate: 1, mediaKey: 'page:https://x/y' },
      ended(100_000, now),
      now,
    );

    expect(cmd.seekToMs).toBeNull();
    expect(cmd.driftMs).toBe(0);
    expect(cmd.idle).toBe(true);
  });

  it('keeps saying so, tick after tick, instead of oscillating', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    let now = START_NOW;
    let expected = 130_000;
    const seeked: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const cmd = driver.tick(
        { expectedMs: expected, playing: false, rate: 1, mediaKey: 'page:https://x/y' },
        ended(100_000, now),
        now,
      );
      if (cmd.seekToMs !== null) seeked.push(cmd.seekToMs);
      now += 1000;
      expected += 1000;
    }
    expect(seeked).toEqual([]);
  });

  it('still corrects a genuine lag inside the item', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const now = START_NOW;
    // 40 s in on a 100 s item, room at 90 s: a real 50 s lag, worth a seek.
    const cmd = driver.tick(
      { expectedMs: 90_000, playing: true, rate: 1, mediaKey: 'page:https://x/y' },
      { positionMs: 40_000, durationMs: 100_000, playing: true, rate: 1, atMs: now },
      now,
    );
    expect(cmd.seekToMs).not.toBeNull();
  });

  it('clamps nothing while the player has not said how long the item is', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const now = START_NOW;
    // durationMs 0 is every adapter's "not known yet" — pre-metadata, or a
    // live stream. Guessing an end for it would stop correcting a real lag.
    const cmd = driver.tick(
      { expectedMs: 130_000, playing: true, rate: 1, mediaKey: 'page:https://x/y' },
      { positionMs: 100_000, durationMs: 0, playing: true, rate: 1, atMs: now },
      now,
    );
    expect(cmd.seekToMs).not.toBeNull();
  });
});

describe('ElasticDriver — the wire contract with the content script', () => {
  it('gives an old fixed-band content script exactly this decision', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const { commands, samples } = simulate(driver, {
      ticks: 24,
      lagMs: 6000,
      telemetryAgeMs: 400,
    });

    let position = START_EXPECTED - 6000;
    for (const [i, cmd] of commands.entries()) {
      const sample = samples[i];
      if (sample === undefined) continue;
      // What the element actually is at the moment the command lands.
      position = sample.positionMs + (sample.playing ? 400 * sample.rate : 0);
      const legacy = decideDrive(
        { positionMs: position, durationMs: 0, playing: true, rate: sample.rate, volume: 1, muted: false },
        cmd.wirePositionMs,
        { playing: true, rate: cmd.setRate ?? 1 },
        LEGACY_BANDS,
      );
      // The old bands seek when, and only when, the elastic decision seeks.
      if (cmd.seekToMs === null) expect(legacy.seekToMs).toBeNull();
      else expect(legacy.seekToMs).toBe(cmd.seekToMs);
    }
  });

  it('projects a stale sample forward at the rate it was running', () => {
    const sample: DriverTelemetry = {
      positionMs: 10_000,
      durationMs: 0,
      playing: true,
      rate: 1.03,
      atMs: 500,
    };
    expect(projectedPositionMs(sample, 1500)).toBeCloseTo(11_030, 5);
    expect(projectedPositionMs({ ...sample, playing: false }, 1500)).toBe(10_000);
    // Clock going backwards must never rewind the projection.
    expect(projectedPositionMs(sample, 0)).toBe(10_000);
  });
});

describe('the elastic block, as it crosses to the content script', () => {
  /** The block exactly as background.ts's drive loop puts it on the wire. */
  const wireBlock = (cmd: DriveCommand): Record<string, unknown> => ({
    transport: cmd.transport,
    seekToMs: cmd.seekToMs,
    setRate: cmd.setRate,
    driftMs: Math.round(cmd.driftMs),
    anchorOffsetMs: Math.round(cmd.anchorOffsetMs),
    reason: cmd.reason,
  });

  const directive = (reason: string): ElasticDirective => ({
    transport: 'none',
    seekToMs: null,
    setRate: null,
    reason,
  });

  it('carries every decision a real run produces, unchanged', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const { commands } = simulate(driver, { ticks: 40, lagMs: 9000, stallTicks: [5, 6] });
    // A run that produced only one kind of decision would prove nothing.
    expect(new Set(commands.map((c) => c.reason)).size).toBeGreaterThan(2);

    for (const cmd of commands) {
      const parsed = parseElasticDirective(wireBlock(cmd));
      expect(parsed).not.toBeNull();
      if (parsed === null) continue;
      expect(elasticDecision(parsed)).toEqual({
        seekToMs: cmd.seekToMs,
        setRate: cmd.setRate,
        action: cmd.transport,
      });
    }
  });

  it('turns a decision to do nothing into nothing at all for the player', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    const { commands } = simulate(driver, { ticks: 30, lagMs: 8000 });
    const doNothing = commands.filter((c) => c.idle);
    expect(doNothing.length).toBeGreaterThan(0);

    for (const cmd of doNothing) {
      const parsed = parseElasticDirective(wireBlock(cmd));
      expect(parsed === null ? null : elasticDecision(parsed)).toEqual({
        seekToMs: null,
        setRate: null,
        action: 'none',
      });
    }
  });

  it('refuses a block it cannot trust, so the caller falls back instead of guessing', () => {
    const good = { transport: 'none', seekToMs: null, setRate: null, reason: 'idle' };
    expect(parseElasticDirective(good)).not.toBeNull();

    const untrustworthy: unknown[] = [
      null,
      undefined,
      'none',
      42,
      [],
      { ...good, transport: 'stop' },
      { seekToMs: null, setRate: null, reason: 'idle' }, // no transport at all
      { transport: 'none', setRate: null, reason: 'idle' }, // no seek field
      { transport: 'none', seekToMs: null, reason: 'idle' }, // no rate field
      { ...good, seekToMs: '600000' },
      { ...good, seekToMs: Number.NaN },
      { ...good, seekToMs: Number.POSITIVE_INFINITY },
      { ...good, setRate: 0 },
      { ...good, setRate: -1 },
      { ...good, setRate: 17 },
      { ...good, setRate: Number.NaN },
    ];
    for (const raw of untrustworthy) expect(parseElasticDirective(raw)).toBeNull();
  });

  it('lets a HUD number be wrong without costing a perfectly good command', () => {
    // driftMs and anchorOffsetMs are report-only; a content frame shows nothing.
    expect(
      parseElasticDirective({
        transport: 'none',
        seekToMs: null,
        setRate: 1.03,
        driftMs: Number.NaN,
        anchorOffsetMs: 'lots',
        reason: 'nudge',
      }),
    ).toEqual({ transport: 'none', seekToMs: null, setRate: 1.03, reason: 'nudge' });
  });

  it('keeps a reason it has never heard of, and says so when none was sent', () => {
    // A newer worker's vocabulary must not cost us its command.
    expect(parseElasticDirective({ ...directive('ad-break') })?.reason).toBe('ad-break');
    expect(
      parseElasticDirective({ transport: 'none', seekToMs: null, setRate: null })?.reason,
    ).toBe('');
  });

  it('hands the decision back only when the worker had no telemetry', () => {
    expect(appliesVerbatim(directive('no-telemetry'))).toBe(false);
    const owned: DriveReason[] = [
      'idle',
      'transport',
      'nudge',
      'seek',
      'seek-suppressed',
      'stalled',
      'rate-locked',
      'restore-rate',
      'user-intent',
    ];
    for (const reason of owned) expect(appliesVerbatim(directive(reason))).toBe(true);
    expect(appliesVerbatim(directive(''))).toBe(true);
  });
});

describe('ElasticDriver — configuration', () => {
  it('starts optimistic about the player and learns from evidence', () => {
    const driver = new ElasticDriver();
    expect(driver.capabilities()).toEqual(OBSERVER_CAPABILITIES);
    expect(driver.profile()).toBe('watch');
  });

  it('carries a proven rate refusal across a band change', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    simulate(driver, { ticks: 6, lagMs: 5000, honoursRate: false });
    expect(driver.capabilities().canSetRate).toBe(false);
    driver.setProfile('listen');
    expect(driver.profile()).toBe('listen');
    expect(driver.capabilities().canSetRate).toBe(false);
  });

  it('accepts a declared refusal up front (DRM players)', () => {
    const driver = new ElasticDriver({
      profile: 'watch',
      capabilities: { canSetRate: false, isDrmProtected: true },
    });
    const { commands } = simulate(driver, { ticks: 10, lagMs: 5000 });
    expect(commands.every((c) => c.setRate === null)).toBe(true);
    expect(seeks(commands)).toHaveLength(0);
  });

  it('reset forgets the anchor when the driven element changes', () => {
    const driver = new ElasticDriver({ profile: 'watch' });
    simulate(driver, { ticks: 12, lagMs: 8000 });
    expect(driver.state().anchorOffsetMs).toBeGreaterThan(0);
    driver.reset();
    expect(driver.state().anchorOffsetMs).toBe(0);
  });
});

describe('syncStatusLabel', () => {
  const base = {
    profile: 'watch' as const,
    anchorOffsetMs: 0,
    voiceTightening: false,
    rateControlAvailable: true,
    seekAvailable: true,
    stalled: false,
    driftMs: 0,
  };

  it('says what the room is doing, never what the controller is doing', () => {
    expect(syncStatusLabel(base)).toBe('In sync');
    expect(syncStatusLabel({ ...base, voiceTightening: true })).toBe('Talking — staying in step');
    expect(syncStatusLabel({ ...base, stalled: true })).toBe('Buffering — holding your place');
    expect(syncStatusLabel({ ...base, anchorOffsetMs: 8200 })).toBe(
      'Playing smoothly, 8s behind the room',
    );
  });
});

/* ── the end of the media: the other half of "arrival, not intent" ── */

describe('MediaEndDetector', () => {
  const end = (over: Partial<ObservedEnd> = {}): ObservedEnd => ({
    sourceKey: '1:https://cdn.example.com/feature.m3u8',
    positionMs: 5_400_000,
    durationMs: 5_400_000,
    ended: true,
    ...over,
  });

  it('reports arrival at the end, with the duration beside it', () => {
    expect(new MediaEndDetector().observe(end())).toEqual({
      positionMs: 5_400_000,
      durationMs: 5_400_000,
    });
  });

  it('reports one end however many times the player says so', () => {
    const detector = new MediaEndDetector();
    expect(detector.observe(end())).not.toBeNull();
    expect(detector.observe(end())).toBeNull();
    expect(detector.observe(end())).toBeNull();
  });

  /** The stale end an SPA makes: the event lands after the next item was
   *  loaded into the same element, which is back at the start. */
  it('refuses an element that no longer says it ended', () => {
    expect(new MediaEndDetector().observe(end({ ended: false, positionMs: 0 }))).toBeNull();
  });

  it('refuses the end of nothing — no duration and no position', () => {
    expect(new MediaEndDetector().observe(end({ positionMs: 0, durationMs: 0 }))).toBeNull();
  });

  it('still reports an end whose duration was never known (a live stream)', () => {
    expect(new MediaEndDetector().observe(end({ durationMs: 0 }))).toEqual({
      positionMs: 5_400_000,
      durationMs: 0,
    });
  });

  it('reports the next item, in the same player, as its own end', () => {
    const detector = new MediaEndDetector();
    expect(detector.observe(end())).not.toBeNull();
    expect(detector.observe(end({ sourceKey: '1:https://cdn.example.com/next.m3u8' }))).toEqual({
      positionMs: 5_400_000,
      durationMs: 5_400_000,
    });
  });

  it('ends the same item twice when it is genuinely watched twice', () => {
    const detector = new MediaEndDetector();
    expect(detector.observe(end())).not.toBeNull();
    // The heartbeat finds the player back near the start: they hit replay.
    detector.notePosition(2_000, 5_400_000);
    expect(detector.observe(end())).not.toBeNull();
  });

  it('is not disarmed by the last frame twitching under a paused player', () => {
    const detector = new MediaEndDetector();
    expect(detector.observe(end())).not.toBeNull();
    detector.notePosition(5_399_000, 5_400_000);
    expect(detector.observe(end())).toBeNull();
  });

  it('cannot judge a replay it has no duration for, and stays latched', () => {
    const detector = new MediaEndDetector();
    expect(detector.observe(end({ durationMs: 0 }))).not.toBeNull();
    detector.notePosition(0, 0);
    expect(detector.observe(end({ durationMs: 0 }))).toBeNull();
  });

  it('forgets the latch when the driven element is replaced', () => {
    const detector = new MediaEndDetector();
    expect(detector.observe(end())).not.toBeNull();
    detector.reset();
    expect(detector.observe(end())).not.toBeNull();
  });
});

/* ── an ad in the driven element is not the room's item ── */

/**
 * The predicate behind the worker's three vetoes (background.ts): an ad
 * swapped into the driven element must not name the film's queue row in
 * `sync.advance`, must not fill the film's fill-once duration row, and must
 * not be hard-seeked to its own end by the drive loop — which is what
 * manufactured its 'ended' in the first place.
 */
describe('isInterstitialSource', () => {
  it('vetoes an ad-length source while the room is deep in a longer item', () => {
    // A 15 s preroll under a room ten minutes into a film.
    expect(isInterstitialSource(15_000, 600_000)).toBe(true);
  });

  it('passes a genuine short item near its own end — projection ≈ duration', () => {
    // A 90 s clip with the room sitting at its end: well under the slack.
    expect(isInterstitialSource(90_000, 90_000)).toBe(false);
    expect(isInterstitialSource(90_000, 100_000)).toBe(false);
  });

  it('never vetoes an unknown duration — 0 means pre-metadata or a live stream', () => {
    expect(isInterstitialSource(0, 10_000_000)).toBe(false);
    expect(isInterstitialSource(-1, 10_000_000)).toBe(false);
  });

  it('never vetoes a long item, however far the projection has run', () => {
    expect(isInterstitialSource(INTERSTITIAL_MAX_DURATION_MS + 1, 100_000_000)).toBe(false);
    expect(isInterstitialSource(5_400_000, 99_000_000)).toBe(false);
  });

  it('trips only past duration + slack, at the documented constants', () => {
    const edge = INTERSTITIAL_MAX_DURATION_MS + INTERSTITIAL_PROJECTION_SLACK_MS;
    expect(isInterstitialSource(INTERSTITIAL_MAX_DURATION_MS, edge)).toBe(false);
    expect(isInterstitialSource(INTERSTITIAL_MAX_DURATION_MS, edge + 1)).toBe(true);
  });
});
