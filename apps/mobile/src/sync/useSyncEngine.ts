/**
 * useSyncEngine — wires @gather/sync-core's drift-corrected playback to an
 * expo-video player. The math (ClockEstimator offset, expectedPositionMs,
 * DriftController nudge/seek hysteresis) is NOT reimplemented here; this hook
 * only bridges it to the player's imperative API.
 *
 * Transport: sync state rides the room WS today (server-authoritative
 * sync.state + clock.ping/pong). The P2P beacon seam that used to be
 * documented here WAS REMOVED with the master clock: @gather/p2p's
 * BeaconSender/BeaconFollower were deleted in the owner-authorized orphan
 * cleanup (they were built for the deleted MasterElection and nothing ever
 * constructed them). Only the BeaconState TYPE survives in @gather/p2p, and
 * only because the SyncTransport seam type below pins the shape; no p2p
 * runtime code is loaded by the app. A future p2p transport would have to
 * bring its own beacon machinery AND a way to choose the sender.
 */
import { useEffect, useRef } from 'react';
import {
  DriftController,
  LISTEN_ELASTIC,
  WATCH_ELASTIC,
  expectedPositionMs,
} from '@gather/sync-core';
import type { MediaRef, PlaybackState } from '@gather/contracts';
import type { ClockEstimator } from '@gather/api-client';
import type { BeaconState } from '@gather/p2p';
import type { VideoPlayer } from 'expo-video';
import { mediaIdentity } from './advance';

/** Transport marker. `ws` is the only implemented arm; `p2p` merely pins the
 *  @gather/p2p BeaconState shape — the beacon machinery behind it was removed
 *  with the master clock (see header). */
export type SyncTransport =
  | { kind: 'ws' }
  | { kind: 'p2p'; latestBeacon: BeaconState | null };

export interface SyncEngineInput {
  player: VideoPlayer | null;
  playback: PlaybackState | null;
  clock: ClockEstimator;
  /** Called with each drift sample (debug HUD). */
  onDriftSample?: (driftMs: number) => void;
  /** Interval between correction passes. Default 500 ms. */
  tickMs?: number;
  /**
   * E17 — somebody in the room has a MIC OPEN (docs/EXTENSION_FIRST.md Part 1,
   * "Consequence B"): while that is true the elastic band tightens, converging
   * with rate only, so a spoken reaction lands near the thing it is about.
   *
   * PRESENCE, NOT MEASURED SPEECH — see src/sync/voice.ts. The controller's
   * ramps are 2 s in and 8 s out; a signal that flips on every syllable would
   * leave it permanently mid-ramp, converging on neither band.
   */
  voiceActive?: boolean | undefined;
  /**
   * This device's source ran out. Called once per media+epoch, from the same
   * signal that latches the end guard below.
   *
   * IT IS THE ROOM'S ONLY REPORTER IN A MOBILE-ONLY ROOM. The queue moves on
   * when some client says the item it was playing has ended (`sync.advance`,
   * ungated and compare-and-set — packages/contracts ws.ts). A host watching
   * on their phone with nobody on the web used to emit no such report from
   * anywhere, and the room sat on the first item forever. Wired in Stage.tsx
   * to {@link RoomConnection.reportEndedItem}, which names the item and fires
   * once for it.
   */
  onEnded?: (() => void) | undefined;
  /**
   * This device's player learned the item's length. Called ONCE PER TRACK with
   * a finite positive number of ms.
   *
   * THE ROOM HAS NO OTHER SOURCE FOR IT. `QueueItem.durationMs` is null for
   * nearly every row (see sync/advance.ts `durationReportFor`), and that null
   * is what makes the server's advance guard price a skip at 20 s instead of
   * verifying an ending, keeps `DriftController`'s terminal clamp switched off,
   * and leaves the transport with no scrubber. Wired in Stage.tsx to a
   * `sync.duration` send.
   *
   * RETURNS WHETHER IT WENT OUT, and the return is load-bearing. The consumer
   * resolves which queue row is playing before it can name one, and that
   * resolution legitimately answers "none" — the queue snapshot has not landed
   * yet on a fresh join, or the row was carried off by a vote-skip. A latch set
   * on the attempt rather than on the send would retire this item on this
   * device forever after one such answer, and the row would keep the null this
   * whole mechanism exists to fill.
   */
  onDuration?: ((durationMs: number) => boolean) | undefined;
  /**
   * This device's player is stalled on the network. A stall is the canonical
   * reason a viewer's settled lag CHANGES, so the controller is told about it
   * (`noteBuffering`) instead of being left to discover it eight seconds later
   * through its stalemate re-arm.
   */
  buffering?: boolean | undefined;
}

/** The embed tier is all music services today; spelled out so a future video
 *  embed lands as video by choice. Mirrors apps/web/lib/media-kind.ts. */
const MUSIC_EMBED_PROVIDERS: ReadonlySet<string> = new Set([
  'spotify',
  'applemusic',
  'tidal',
  'deezer',
]);

/** Is the playing item music? Mirrors `mediaKindFor` in
 *  apps/web/lib/media-kind.ts — keep them in sync, the way permissions.ts
 *  mirrors the web's. Only the music/video split is needed here, so this
 *  answers with a boolean instead of the web's full MediaKind. */
function isMusicRef(ref: MediaRef | null | undefined): boolean {
  if (ref === null || ref === undefined) return false;
  switch (ref.kind) {
    case 'soundcloud':
      return true;
    case 'url':
      return ref.mime.startsWith('audio/');
    case 'embed':
      return MUSIC_EMBED_PROVIDERS.has(ref.provider);
    case 'youtube':
      return ref.music === true;
    // An arbitrary page is whatever the extension finds once it opens it, so
    // the url cannot be read for a kind. Not-music matches the web's
    // mediaKindFor default ('video') — the same choice, spelled as a boolean.
    case 'page':
    case 'vimeo':
    case 'hls':
      return false;
  }
}

/** WHICH CONTENT is on the stage, with no playback epoch in it. 'none' when
 *  nothing is. The controller's lifetime hangs on this and not on {@link
 *  mediaKey} — see {@link notePlaybackChange}. */
function trackKey(state: PlaybackState | null): string {
  const ref = state?.mediaRef;
  if (state === null || ref === null || ref === undefined) return 'none';
  return mediaIdentity(ref);
}

/** Key that identifies "which media + which epoch" for hard resyncs. */
function mediaKey(state: PlaybackState | null): string {
  const ref = state?.mediaRef;
  if (state === null || ref === null || ref === undefined) return 'none';
  return `${mediaIdentity(ref)}:${state.seq}`;
}

/** What the room did between two playback snapshots. */
export type PlaybackObservation = 'track-change' | 'host-seek' | 'transport';

/**
 * How far two consecutive projections may disagree and still be talking about
 * the same playhead.
 *
 * `PlaybackState` carries no verb — a play, a pause, a seek and a rate change
 * are the same shape with a fresh `seq` — so the projection is the only
 * witness a client has. Two snapshots that project to the same instant did not
 * move the playhead. A second is far above the arithmetic difference between a
 * paused snapshot and the playing one it was taken from (the server records
 * `positionMs` at the instant it stamps `serverTs`), and far below any seek a
 * person makes with a finger on a progress bar. Misreading a seek as transport
 * costs one stale anchor the controller will nudge out of; misreading transport
 * as a seek throws away a good anchor, which is the expensive direction.
 */
export const HOST_SEEK_EPSILON_MS = 1000;

/** Deadband on the hard resync's position snap. Below this the correction is
 *  not worth the re-buffer a seek costs. */
export const RESYNC_DEADBAND_MS = 250;

/** Read two consecutive playback snapshots for what the room actually did. */
export function classifyPlaybackChange(
  prev: PlaybackState | null,
  next: PlaybackState,
  serverNowTs: number,
): PlaybackObservation {
  // Nothing to compare against is a fresh start, and a fresh start is a track
  // start: whatever this viewer settles at is a lag worth learning from zero.
  if (prev === null || trackKey(prev) !== trackKey(next)) return 'track-change';
  const moved = Math.abs(
    expectedPositionMs(next, serverNowTs) - expectedPositionMs(prev, serverNowTs),
  );
  return moved > HOST_SEEK_EPSILON_MS ? 'host-seek' : 'transport';
}

/**
 * Tell the controller what happened INSTEAD OF BUILDING A NEW ONE.
 *
 * The elastic design's whole value is the learned anchor: the controller spends
 * seconds of playback working out how far behind this viewer comfortably sits
 * and then plays against that instead of fighting it. Every playback mutation
 * bumps `PlaybackState.seq` (services/api sync/service.ts takes a fresh
 * `playback:<room>` seq per write), so a controller torn down — or `reset()` —
 * per seq is a controller torn down on every play, pause, seek and rate change
 * in the room. It restarts at anchor 0 and immediately prescribes a correction
 * back to frame-lock, which is exactly the behaviour the bands exist to stop.
 *
 * So only a TRACK CHANGE drops the anchor. A host seek drops it too, because
 * the old offset describes a position nobody is at any more. Everything else is
 * a disturbance: keep the anchor, re-arm learning, and throw away the settle
 * window, since no lag measured across a pause describes the one after it.
 */
export function notePlaybackChange(
  controller: DriftController,
  observation: PlaybackObservation,
): void {
  switch (observation) {
    case 'track-change':
      controller.noteTrackChange();
      return;
    case 'host-seek':
      controller.noteHostSeek();
      return;
    case 'transport':
      controller.noteBuffering();
      return;
  }
}

/**
 * Where the hard resync should put this device's player, or null to leave it
 * where it is.
 *
 * THE TARGET IS ANCHORED. Snapping to the room's raw projection would undo at
 * the player what {@link notePlaybackChange} just protected in the controller:
 * a viewer holding a learned 6 s lag would be yanked 6 s forward by any play or
 * pause anyone in the room presses. The anchor is the position this viewer is
 * deliberately playing at, so it is the position a resync aims for.
 */
export function resyncSeekMs(input: {
  expectedMs: number;
  actualMs: number;
  anchorOffsetMs: number;
}): number | null {
  const target = Math.max(0, input.expectedMs - input.anchorOffsetMs);
  return Math.abs(target - input.actualMs) > RESYNC_DEADBAND_MS ? target : null;
}

/** The slice of expo-video's player one correction pass reads and writes.
 *  Structural so a test can drive it without a native module. SECONDS, which
 *  is expo-video's unit — everything sync-core says is in ms. */
export interface CorrectablePlayer {
  currentTime: number;
  playbackRate: number;
  readonly duration: number;
}

export interface CorrectionInput {
  player: CorrectablePlayer;
  playback: PlaybackState;
  controller: DriftController;
  /** `clock.serverNow(Date.now())`, taken once for the whole pass. */
  serverNowTs: number;
  /** `clock.hasEstimate()` — see the null return. */
  hasEstimate: boolean;
  /** This device's source has run out (the engine's end guard). */
  ended: boolean;
}

/**
 * One correction pass. Returns the drift sample for the HUD, or null when
 * drift is not a measurable quantity right now.
 *
 * THE CLOCK GATE IS THE FIRST THING IT ASKS. Before a single clock.pong is
 * accepted, `ClockEstimator.offsetMs()` is the 0 PLACEHOLDER and `serverNow()`
 * is just this phone's own clock, so the projected position is wrong by however
 * far the device clock sits from the server's. Correcting against that is worse
 * than not correcting twice over: the seek escape moves the viewer to a
 * position nobody is at, and — because the controller cannot tell a wrong
 * projection from a real lag — the anchor LEARNS the skew and holds the viewer
 * there long after the estimate arrives. Reporting null rather than 0 keeps the
 * HUD from claiming a measurement that was never taken.
 *
 * The hard resync deliberately does NOT take this gate: it runs once per epoch
 * and its alternative is leaving a late joiner sitting at position zero, so
 * landing on roughly the right minute under an unknown skew is the better of
 * the two. A 2 Hz loop against the same unknown is not.
 */
export function correctOnce(input: CorrectionInput): number | null {
  const { player, playback, controller, serverNowTs, ended } = input;
  // Nothing to correct: the item is over here, or the room is paused. Under
  // the duration clamp below the real drift at the end IS ~0, so 0 is honest
  // rather than a frozen last reading.
  if (ended || !playback.playing) return 0;
  if (!input.hasEstimate) return null;

  const expected = expectedPositionMs(playback, serverNowTs);
  const actual = player.currentTime * 1000;
  // Unknown before metadata arrives (0) and absent on a live stream
  // (Infinity/NaN), both of which the controller reads as "do not clamp".
  const durationMs = player.duration * 1000;
  const decision = controller.decide(
    expected,
    actual,
    Number.isFinite(durationMs) && durationMs > 0 ? { durationMs } : undefined,
  );
  if (decision.action === 'seek') {
    player.currentTime = decision.toMs / 1000;
    player.playbackRate = playback.rate;
  } else if (decision.action === 'nudge') {
    player.playbackRate = playback.rate * decision.rate;
  } else if (player.playbackRate !== playback.rate) {
    player.playbackRate = playback.rate;
  }
  return expected - actual;
}

/** The one thing this wiring needs of expo-video's player: its end signal.
 *  Structural so a test can supply it without a native module. */
export interface EndSignalPlayer {
  addListener(name: 'playToEnd', listener: () => void): { remove(): void };
}

/**
 * The end of this device's source, wired to BOTH things that must happen —
 * the latch that stops drift correction, and the report that moves the room's
 * queue on. Extracted from the hook rather than inlined so it can be tested
 * without a React renderer (this app's vitest is node-only, no RN).
 *
 * Returns the teardown, which un-latches as well as unsubscribing: the guard
 * belongs to ONE media+epoch, and a latch left standing would silence the
 * engine for the following item.
 */
export function armEndOfItem(
  player: EndSignalPlayer,
  ended: { current: boolean },
  onEnded: () => void,
): () => void {
  ended.current = false;
  const sub = player.addListener('playToEnd', () => {
    ended.current = true;
    onEnded();
  });
  return () => {
    sub.remove();
    ended.current = false;
  };
}

/**
 * Applies server-authoritative playback to the player:
 *  - on state/track change: snap position (past deadband, and toward the
 *    learned anchor), rate, play/pause;
 *  - every tick: report a newly learned duration once, then let DriftController
 *    decide none/nudge/seek inside the elastic band for the playing item's
 *    media kind.
 *
 * ONE CONTROLLER PER PROFILE, not per epoch. It is told what the room did
 * ({@link notePlaybackChange}) rather than rebuilt or reset, so its anchor
 * survives every play, pause, seek and rate change.
 */
export function useSyncEngine(input: SyncEngineInput): void {
  const { player, playback, clock, tickMs } = input;
  const onDriftSample = input.onDriftSample;

  /** Elastic bands, chosen by what is PLAYING — the same rule the extension's
   *  driver applies. Rate authority is the axis that differs: ±3% is invisible
   *  on dialogue and nearly a semitone of pitch on music. */
  const profile = isMusicRef(playback?.mediaRef) ? 'listen' : 'watch';
  const controllerRef = useRef<DriftController | null>(null);
  const profileRef = useRef<string | null>(null);
  const voiceActive = input.voiceActive ?? false;
  if (controllerRef.current === null || profileRef.current !== profile) {
    controllerRef.current = new DriftController(
      profile === 'listen' ? LISTEN_ELASTIC : WATCH_ELASTIC,
    );
    // A profile flip (video → music) builds a FRESH controller mid-session; one
    // that has never been told about the open mics in the room starts loose.
    controllerRef.current.setVoiceActive(voiceActive);
    profileRef.current = profile;
  }

  // E17 — the adaptive comfort band, from presence mic state (see the input's
  // doc comment and src/sync/voice.ts).
  useEffect(() => {
    controllerRef.current?.setVoiceActive(voiceActive);
  }, [voiceActive]);

  // A stall: keep the anchor, re-arm learning, drop the settle window. Rising
  // edge only — while the stall lasts there is nothing new to tell it.
  const buffering = input.buffering ?? false;
  useEffect(() => {
    if (buffering) controllerRef.current?.noteBuffering();
  }, [buffering]);

  const lastKeyRef = useRef<string>('none');
  /** The snapshot the last resync was computed from — the only witness to what
   *  the room DID, since a PlaybackState names no verb. */
  const lastPlaybackRef = useRef<PlaybackState | null>(null);
  const key = mediaKey(playback);
  const track = trackKey(playback);

  // Hard resync on state/track changes (late joiners land here too).
  useEffect(() => {
    if (player === null || playback === null || key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    const controller = controllerRef.current;
    const serverNowTs = clock.serverNow(Date.now());
    // NOT `reset()`. Every play/pause/seek/rate bumps the epoch in `key`, and
    // resetting per epoch threw away the learned anchor several times a
    // session — see notePlaybackChange.
    if (controller !== null) {
      const observation = classifyPlaybackChange(lastPlaybackRef.current, playback, serverNowTs);
      notePlaybackChange(controller, observation);
    }
    lastPlaybackRef.current = playback;

    const target = resyncSeekMs({
      expectedMs: expectedPositionMs(playback, serverNowTs),
      actualMs: player.currentTime * 1000,
      anchorOffsetMs: controller?.anchorOffsetMs() ?? 0,
    });
    if (target !== null) {
      player.currentTime = target / 1000;
    }
    player.playbackRate = playback.rate;
    if (playback.playing) {
      player.play();
    } else {
      player.pause();
    }
  }, [player, playback, clock, key]);

  /** Reporting the end and the length, kept fresh in refs so the subscription
   *  and the tick below stay keyed on the player and the item alone instead of
   *  re-arming whenever the screen hands down a new closure. Mirrors the web
   *  stage's `advanceRef`. */
  const onEndedRef = useRef<(() => void) | undefined>(undefined);
  const onDurationRef = useRef<((durationMs: number) => boolean) | undefined>(undefined);
  useEffect(() => {
    onEndedRef.current = input.onEnded;
    onDurationRef.current = input.onDuration;
  });

  /** Which TRACK this device has already reported a length for. Keyed on the
   *  track and not the epoch: a seek changes neither how long the item is nor
   *  the fact that the room has already been told. */
  const durationSentRef = useRef<string | null>(null);

  /** END GUARD (mirrors the web engine). The room's projected position keeps
   *  climbing after this device's source runs out, so from that moment every
   *  correction is a seek past the end — and seeking a finished player starts
   *  it again, which ends it again. Torn down and re-armed per media+epoch, or
   *  the latch would silence the engine for the following item.
   *
   *  The SAME signal reports the ending to the room (see `onEnded` above): one
   *  end, one subscription, two consequences — a phone that latched without
   *  reporting is exactly how a mobile-only room stalled. */
  const endedRef = useRef(false);
  useEffect(() => {
    endedRef.current = false;
    if (player === null) return undefined;
    return armEndOfItem(player, endedRef, () => onEndedRef.current?.());
  }, [player, key]);

  // Continuous drift correction.
  useEffect(() => {
    if (player === null || playback === null) return;
    const controller = controllerRef.current;
    if (controller === null) return;

    const tick = (): void => {
      // Read on the tick rather than once at mount: the player only learns the
      // length after the source loads. Ahead of the correction below because a
      // paused or finished item still has a length worth reporting, and those
      // are the two cases correctOnce returns early on.
      if (track !== 'none' && durationSentRef.current !== track) {
        const learned = player.duration * 1000;
        // 0 before metadata, Infinity/NaN on a live stream — neither is a
        // length. `durationReportFor` refuses them again on the way to the
        // wire, where the contract's finite/positive pin lives.
        // Latch only on a report that actually left: see `onDuration`.
        if (Number.isFinite(learned) && learned > 0) {
          if (onDurationRef.current?.(learned) === true) durationSentRef.current = track;
        }
      }

      const sample = correctOnce({
        player,
        playback,
        controller,
        serverNowTs: clock.serverNow(Date.now()),
        hasEstimate: clock.hasEstimate(),
        ended: endedRef.current,
      });
      // null = the clock has no estimate yet, so no drift was measured. Not 0.
      if (sample !== null) onDriftSample?.(sample);
    };

    const handle = setInterval(tick, tickMs ?? 500);
    return () => clearInterval(handle);
  }, [player, playback, clock, onDriftSample, tickMs, track]);
}
