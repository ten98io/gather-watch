/**
 * useSyncEngine — wires @gather/sync-core's drift-corrected playback to a
 * Mode A PlayerAdapter. The math (ClockEstimator offset, expectedPositionMs,
 * DriftController nudge/seek hysteresis) is NOT reimplemented here; this hook
 * only bridges it to the adapter's imperative API. Web port of
 * apps/mobile/src/sync/useSyncEngine.ts.
 */
import { useEffect, useRef } from 'react';
import {
  DriftController,
  LISTEN_ELASTIC,
  WATCH_ELASTIC,
  expectedPositionMs,
} from '@gather/sync-core';
import type { PlaybackState } from '@gather/contracts';
import type { ClockEstimator } from '@gather/api-client';
import { mediaKindFor } from '@/lib/media-kind';
import type { PlayerAdapter } from './adapter';
import { mediaKey } from './adapter';
import { attachContentDucking } from './ducking';
import { getVoiceActive, subscribeVoiceActive } from './room-audio';

export interface SyncEngineInput {
  adapter: PlayerAdapter | null;
  playback: PlaybackState | null;
  clock: ClockEstimator;
  /** Called with each drift sample (debug HUD). */
  onDriftSample?: ((driftMs: number) => void) | undefined;
  /** Interval between correction passes. Default 500 ms. */
  tickMs?: number;
}

/**
 * Applies server-authoritative playback to the adapter:
 *  - on state/track change: snap position (past deadband), rate, play/pause;
 *  - every tick: DriftController decides none/nudge/seek inside the elastic
 *    band for the playing item's media kind.
 */
export function useSyncEngine(input: SyncEngineInput): void {
  const { adapter, playback, clock, tickMs } = input;
  const onDriftSample = input.onDriftSample;

  /**
   * Elastic bands, chosen by what is PLAYING — the same rule the extension's
   * driver applies (apps/extension/src/driver.ts). The web sat on the
   * frame-lock defaults (60 ms deadband, 2 s hard seek) long after
   * docs/EXTENSION_FIRST.md described elastic sync as shipped, which is why a
   * correction loop here ran at 2 Hz instead of once every twelve seconds.
   * Rate authority is the axis that differs: ±3% is invisible on dialogue and
   * nearly a semitone of pitch on music.
   */
  const profile = mediaKindFor(playback?.mediaRef ?? null) === 'music' ? 'listen' : 'watch';
  const controllerRef = useRef<DriftController | null>(null);
  const profileRef = useRef<string | null>(null);
  /**
   * E17 — docs/EXTENSION_FIRST.md Part 1, "Consequence B". Voice is ~50–150 ms
   * peer-to-peer while an elastic room lets viewers sit seconds apart, so a
   * live mic is the one spoiler vector media-anchored chat cannot close: the
   * band has to tighten while people are talking. The extension has done this
   * since it shipped; the web, where most people watch, did not.
   *
   * THE SOURCE IS PRESENCE MIC STATE, NOT MEASURED SPEECH — see
   * lib/player/room-audio.ts. The controller's ramps are 2 s in and 8 s out;
   * feeding it the 150 ms speech detector would leave it permanently mid-ramp,
   * converging on neither band. Measured speech drives ducking instead, one
   * effect below, and the two must not be crossed.
   *
   * Held in a ref as well as pushed, because a profile flip (video → music)
   * builds a FRESH controller mid-session, and a new controller that has never
   * been told about the open mics in the room starts out loose.
   */
  const voiceActiveRef = useRef<boolean>(getVoiceActive());
  if (controllerRef.current === null || profileRef.current !== profile) {
    controllerRef.current = new DriftController(
      profile === 'listen' ? LISTEN_ELASTIC : WATCH_ELASTIC,
    );
    controllerRef.current.setVoiceActive(voiceActiveRef.current);
    profileRef.current = profile;
  }

  // Subscribing calls back immediately with the current value, so a stage that
  // mounts into a room already mid-conversation is tightened at once.
  useEffect(
    () =>
      subscribeVoiceActive((active) => {
        voiceActiveRef.current = active;
        controllerRef.current?.setVoiceActive(active);
      }),
    [],
  );

  /**
   * E18 — ducking. The other half of "someone is talking while the content
   * plays", on the other signal and the other timescale: the content steps
   * back for MEASURED SPEECH and comes back when it stops. Attached here
   * because this hook is already the one place that owns applying the room to
   * the mounted adapter, and it receives exactly the adapters that have a
   * volume to duck (isFullSyncKind). See lib/player/ducking.ts for the target,
   * the envelope, and why a duck can never move the user's own volume.
   */
  useEffect(() => {
    if (adapter === null) return undefined;
    return attachContentDucking(adapter);
  }, [adapter]);

  const lastKeyRef = useRef<string>('none');
  /** Which media + epoch this engine is correcting right now. */
  const key = mediaKey(playback?.mediaRef, playback?.seq);

  // Hard resync on state/track changes (late joiners land here too).
  useEffect(() => {
    if (adapter === null || playback === null || key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    controllerRef.current?.reset();

    const expected = expectedPositionMs(playback, clock.serverNow(Date.now()));
    if (Math.abs(expected - adapter.positionMs()) > 250) {
      adapter.seekTo(expected);
    }
    adapter.setRate(playback.rate);
    if (playback.playing) {
      adapter.play();
    } else {
      adapter.pause();
    }
  }, [adapter, playback, clock, key]);

  /**
   * END GUARD. The room's projected position keeps climbing after this
   * device's source runs out, so from that moment every correction is a seek
   * past the end — and seeking a finished player starts it again, which ends
   * it again, twice a second. Once the item has ended here, this engine stops
   * correcting and waits for the next track.
   *
   * This is also what a FOLLOWER needs: elastic sync leaves viewers seconds
   * apart, so a follower reaches the credits while the room is still on the
   * old item, and must simply sit still until the advance arrives.
   *
   * Keyed on the same media+epoch as the resync above, and torn down with it —
   * a latch that outlived its item would silence the engine for the next one.
   */
  const endedRef = useRef(false);
  useEffect(() => {
    endedRef.current = false;
    if (adapter === null) return undefined;
    const off = adapter.on('ended', () => {
      endedRef.current = true;
    });
    return () => {
      off();
      endedRef.current = false;
    };
  }, [adapter, key]);

  // Continuous drift correction.
  useEffect(() => {
    if (adapter === null || playback === null) return;
    const controller = controllerRef.current;
    if (controller === null) return;

    const tick = (): void => {
      // Nothing to correct: the item is over here, or the room is paused.
      // Under the duration clamp below the real drift at the end IS ~0, so
      // reporting 0 to the HUD is honest rather than a frozen last reading.
      if (endedRef.current || !playback.playing) {
        onDriftSample?.(0);
        return;
      }
      const expected = expectedPositionMs(playback, clock.serverNow(Date.now()));
      const actual = adapter.positionMs();
      onDriftSample?.(expected - actual);
      // 0 while the duration is unknown (pre-metadata / YouTube pre-ready),
      // which the controller reads as "do not clamp".
      const durationMs = adapter.durationMs();
      const decision = controller.decide(
        expected,
        actual,
        durationMs > 0 ? { durationMs } : undefined,
      );
      if (decision.action === 'seek') {
        adapter.seekTo(decision.toMs);
        adapter.setRate(playback.rate);
      } else if (decision.action === 'nudge') {
        adapter.setRate(playback.rate * decision.rate);
      } else {
        adapter.setRate(playback.rate);
      }
    };

    const handle = setInterval(tick, tickMs ?? 500);
    return () => clearInterval(handle);
  }, [adapter, playback, clock, onDriftSample, tickMs]);
}
