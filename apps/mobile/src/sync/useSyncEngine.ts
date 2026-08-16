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
import { DriftController, expectedPositionMs } from '@gather/sync-core';
import type { PlaybackState } from '@gather/contracts';
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
 *  - every tick: DriftController decides none/nudge(rate 0.95–1.05)/seek(>2 s).
 */
export function useSyncEngine(input: SyncEngineInput): void {
  const { player, playback, clock, tickMs } = input;
  const onDriftSample = input.onDriftSample;
  const controllerRef = useRef<DriftController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new DriftController();
  const lastKeyRef = useRef<string>('none');

  // Hard resync on state/track changes (late joiners land here too).
  useEffect(() => {
    const key = mediaKey(playback);
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
  }, [player, playback, clock]);

  // Continuous drift correction.
  useEffect(() => {
    if (player === null || playback === null) return;
    const controller = controllerRef.current;
    if (controller === null) return;

    const tick = (): void => {
      if (!playback.playing) {
        onDriftSample?.(0);
        return;
      }
      const expected = expectedPositionMs(playback, clock.serverNow(Date.now()));
      const actual = player.currentTime * 1000;
      onDriftSample?.(expected - actual);
      const decision = controller.decide(expected, actual);
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
