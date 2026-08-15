import { describe, it, expect } from 'vitest';
import { runGateSimulation } from './gate-sim';

const SEEDS = [1, 42, 2024, 31337, 99991];

describe('sync gate: 4 clients, ±80ms clock offsets, ±0.2–0.5% media-clock skew, 5–120ms jitter, 60s @ 250ms ticks', () => {
  it('median absolute cross-client drift over final 30s is <= 150ms (seed 1337)', () => {
    const m = runGateSimulation(1337);
    expect(m.medianPairwiseDriftMs).toBeLessThanOrEqual(150);
  });

  it('server-truth: per-client median |actual - truePosition| over final 30s is <= 150ms (seed 1337)', () => {
    // Pairwise agreement alone is vacuous — 4 clients in lockstep at the wrong
    // position agree perfectly. A no-op controller never applies the 300s seek
    // and scores ~280,000ms here; the real controller must track the server.
    const m = runGateSimulation(1337);
    for (const err of m.medianServerErrorMs) expect(err).toBeLessThanOrEqual(150);
    for (const err of m.finalAbsErrorMs) expect(err).toBeLessThanOrEqual(300);
  });

  it('rate-nudge path is exercised: every client nudges at least once (seed 1337)', () => {
    // The simulated media-clock skew (±0.2–0.5%) makes free-running drift past
    // the 60ms deadband inevitable, so a controller that never nudges (or
    // nudges with the wrong sign) cannot hold the drift bounds above.
    const m = runGateSimulation(1337);
    for (const nudges of m.nudgeCounts) expect(nudges).toBeGreaterThan(0);
  });

  it('no client oscillates: rate sign flips < 10 per client (seed 1337)', () => {
    const m = runGateSimulation(1337);
    for (const flips of m.rateSignFlips) expect(flips).toBeLessThan(10);
  });

  it('holds across seeds', () => {
    for (const seed of SEEDS) {
      const m = runGateSimulation(seed);
      expect(m.medianPairwiseDriftMs).toBeLessThanOrEqual(150);
      for (const err of m.medianServerErrorMs) expect(err).toBeLessThanOrEqual(150);
      for (const nudges of m.nudgeCounts) expect(nudges).toBeGreaterThan(0);
      for (const flips of m.rateSignFlips) expect(flips).toBeLessThan(10);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = runGateSimulation(1337);
    const b = runGateSimulation(1337);
    expect(a).toEqual(b);
  });
});
