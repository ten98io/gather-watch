/**
 * useSyncEngine — wires @gather/sync-core's drift-corrected playback to a
 * Mode A PlayerAdapter. The math (ClockEstimator offset, expectedPositionMs,
 * DriftController nudge/seek hysteresis) is NOT reimplemented here; this hook
 * only bridges it to the adapter's imperative API. Web port of
 * apps/mobile/src/sync/useSyncEngine.ts.
 */
import { useEffect, useRef } from 'react';
import { DriftController, expectedPositionMs } from '@gather/sync-core';
import type { PlaybackState } from '@gather/contracts';
import type { ClockEstimator } from '@gather/api-client';
import type { PlayerAdapter } from './adapter';
import { mediaKey } from './adapter';

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
 *  - every tick: DriftController decides none/nudge(rate 0.95–1.05)/seek(>2 s).
 */
export function useSyncEngine(input: SyncEngineInput): void {
  const { adapter, playback, clock, tickMs } = input;
  const onDriftSample = input.onDriftSample;
  const controllerRef = useRef<DriftController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new DriftController();
  const lastKeyRef = useRef<string>('none');

  // Hard resync on state/track changes (late joiners land here too).
  useEffect(() => {
    const key = mediaKey(playback?.mediaRef, playback?.seq);
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
  }, [adapter, playback, clock]);

  // Continuous drift correction.
  useEffect(() => {
    if (adapter === null || playback === null) return;
    const controller = controllerRef.current;
    if (controller === null) return;

    const tick = (): void => {
      if (!playback.playing) {
        onDriftSample?.(0);
        return;
      }
      const expected = expectedPositionMs(playback, clock.serverNow(Date.now()));
      const actual = adapter.positionMs();
      onDriftSample?.(expected - actual);
      const decision = controller.decide(expected, actual);
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
