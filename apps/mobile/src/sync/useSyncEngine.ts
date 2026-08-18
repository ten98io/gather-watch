/**
 * useSyncEngine — wires @gather/sync-core's drift-corrected playback to an
 * expo-video player. The math (ClockEstimator offset, expectedPositionMs,
 * DriftController nudge/seek hysteresis) is NOT reimplemented here; this hook
 * only bridges it to the player's imperative API.
 *
 * Transport: sync beacons/state ride the room WS today (server-authoritative
 * sync.state + clock.ping/pong). The v3.1 P2P path (master broadcasts beacons
 * over DataChannels; followers run the same estimator against beacon
 * timestamps) is a DOCUMENTED SEAM, not wired: @gather/p2p's
 * BeaconFollower/MasterElection require an injected RTCPeerConnection
 * (react-native-webrtc), which is a native-milestone install. Only p2p TYPES
 * are referenced below so the seam stays type-checked; no p2p runtime code
 * is loaded by the app.
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

/** Seam for the future beacon transport (see header). `ws` is the only
 *  implemented arm; `p2p` pins the @gather/p2p BeaconState shape the mobile
 *  follower will consume once react-native-webrtc lands. */
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

/** Key that identifies "which media + which epoch" for hard resyncs. */
function mediaKey(state: PlaybackState | null): string {
  const ref = state?.mediaRef;
  if (state === null || ref === null || ref === undefined) return 'none';
  const id =
    ref.kind === 'youtube' || ref.kind === 'vimeo'
      ? ref.videoId
      : ref.kind === 'embed'
        ? ref.embedUrl
        : ref.url;
  return `${ref.kind}:${id}:${state.seq}`;
}

/**
 * Applies server-authoritative playback to the player:
 *  - on state/track change: snap position (past deadband), rate, play/pause;
 *  - every tick: DriftController decides none/nudge/seek inside the elastic
 *    band for the playing item's media kind.
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

  const lastKeyRef = useRef<string>('none');
  const key = mediaKey(playback);

  // Hard resync on state/track changes (late joiners land here too).
  useEffect(() => {
    if (player === null || playback === null || key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    controllerRef.current?.reset();

    const expected = expectedPositionMs(playback, clock.serverNow(Date.now()));
    if (Math.abs(expected - player.currentTime * 1000) > 250) {
      player.currentTime = expected / 1000;
    }
    player.playbackRate = playback.rate;
    if (playback.playing) {
      player.play();
    } else {
      player.pause();
    }
  }, [player, playback, clock, key]);

  /** END GUARD (mirrors the web engine). The room's projected position keeps
   *  climbing after this device's source runs out, so from that moment every
   *  correction is a seek past the end — and seeking a finished player starts
   *  it again, which ends it again. Torn down and re-armed per media+epoch, or
   *  the latch would silence the engine for the following item. */
  const endedRef = useRef(false);
  useEffect(() => {
    endedRef.current = false;
    if (player === null) return undefined;
    const sub = player.addListener('playToEnd', () => {
      endedRef.current = true;
    });
    return () => {
      sub.remove();
      endedRef.current = false;
    };
  }, [player, key]);

  // Continuous drift correction.
  useEffect(() => {
    if (player === null || playback === null) return;
    const controller = controllerRef.current;
    if (controller === null) return;

    const tick = (): void => {
      // Nothing to correct: the item is over here, or the room is paused.
      if (endedRef.current || !playback.playing) {
        onDriftSample?.(0);
        return;
      }
      const expected = expectedPositionMs(playback, clock.serverNow(Date.now()));
      const actual = player.currentTime * 1000;
      onDriftSample?.(expected - actual);
      // Unknown before metadata arrives, which the controller reads as
      // "do not clamp".
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
    };

    const handle = setInterval(tick, tickMs ?? 500);
    return () => clearInterval(handle);
  }, [player, playback, clock, onDriftSample, tickMs]);
}
