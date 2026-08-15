import { describe, it, expect } from 'vitest';
import { ClockEstimator } from '../src/clock';
import type { ClockSample } from '../src/clock';

/** Builds a sample whose offset (serverTs minus client-clock midpoint) is exactly
 *  `offset` and whose RTT is exactly `rtt`. */
function sample(sendTs: number, offset: number, rtt: number): ClockSample {
  return {
    clientSendTs: sendTs,
    serverTs: sendTs + rtt / 2 + offset,
    clientRecvTs: sendTs + rtt,
  };
}

describe('ClockEstimator', () => {
  it('reports no estimate before any sample', () => {
    const clock = new ClockEstimator();
    expect(clock.hasEstimate()).toBe(false);
    expect(clock.offsetMs()).toBe(0);
    expect(clock.serverNow(1234)).toBe(1234);
    expect(clock.sampleCount()).toBe(0);
  });

  it('converges exactly on symmetric samples (equal one-way delays)', () => {
    // Client clock = server clock + 500, so the estimator should measure
    // (server - client) = -500. With d1 === d2 the offset sample is exact:
    // serverTs = (S - O) + d1, clientRecvTs = S + d1 + d2.
    const clock = new ClockEstimator();
    const s: ClockSample = { clientSendTs: 1000, serverTs: 540, clientRecvTs: 1080 };
    expect(clock.addSample(s)).toBe(true);
    expect(clock.offsetMs()).toBeCloseTo(-500, 10);

    // More symmetric samples at other send times keep the estimate exactly there.
    expect(clock.addSample({ clientSendTs: 5000, serverTs: 4540, clientRecvTs: 5080 })).toBe(true);
    expect(clock.addSample({ clientSendTs: 9000, serverTs: 8540, clientRecvTs: 9080 })).toBe(true);
    expect(clock.offsetMs()).toBeCloseTo(-500, 10);
  });

  it('sets the estimate directly from the first accepted sample', () => {
    const clock = new ClockEstimator({ alpha: 0.5 });
    expect(clock.addSample(sample(1000, -500, 80))).toBe(true);
    expect(clock.offsetMs()).toBe(-500);
    expect(clock.hasEstimate()).toBe(true);
    expect(clock.sampleCount()).toBe(1);
  });

  it('moves the estimate by alpha * (o2 - o1) on the second sample (EWMA)', () => {
    const clock = new ClockEstimator({ alpha: 0.5 });
    expect(clock.addSample(sample(1000, -500, 80))).toBe(true); // o1 = -500
    expect(clock.addSample(sample(2000, -490, 80))).toBe(true); // o2 = -490
    // estimate = -500 + 0.5 * (-490 - (-500)) = -495
    expect(clock.offsetMs()).toBe(-495);
    expect(clock.sampleCount()).toBe(2);
  });

  it('discards RTT outliers (> 2x median) and keeps accepting good samples', () => {
    const clock = new ClockEstimator();
    // Three plausible samples activate the filter (minSamplesForFilter = 3).
    expect(clock.addSample(sample(0, -500, 100))).toBe(true);
    expect(clock.addSample(sample(1000, -500, 100))).toBe(true);
    expect(clock.addSample(sample(2000, -500, 100))).toBe(true);
    const before = clock.offsetMs();
    const countBefore = clock.sampleCount();

    // rtt 500 > 2 * median(100) → discarded, estimate untouched.
    expect(clock.addSample(sample(3000, -500, 500))).toBe(false);
    expect(clock.offsetMs()).toBe(before);
    expect(clock.sampleCount()).toBe(countBefore);

    // A subsequent good sample is still accepted.
    expect(clock.addSample(sample(4000, -500, 100))).toBe(true);
    expect(clock.sampleCount()).toBe(countBefore + 1);
  });

  it('accepts wild RTTs while the filter is inactive (< minSamplesForFilter)', () => {
    const clock = new ClockEstimator();
    expect(clock.addSample(sample(0, 0, 5))).toBe(true);
    expect(clock.addSample(sample(1000, 0, 9999))).toBe(true);
    expect(clock.addSample(sample(2000, 0, 12))).toBe(true);
    expect(clock.sampleCount()).toBe(3);
  });

  it('rejects negative RTT and NaN fields without changing state', () => {
    const clock = new ClockEstimator();
    expect(clock.addSample({ clientSendTs: 1000, serverTs: 1000, clientRecvTs: 900 })).toBe(false);
    expect(clock.addSample({ clientSendTs: NaN, serverTs: 1000, clientRecvTs: 1100 })).toBe(false);
    expect(clock.addSample({ clientSendTs: 1000, serverTs: NaN, clientRecvTs: 1100 })).toBe(false);
    expect(clock.addSample({ clientSendTs: 1000, serverTs: 1000, clientRecvTs: NaN })).toBe(false);
    expect(clock.hasEstimate()).toBe(false);
    expect(clock.sampleCount()).toBe(0);
    expect(clock.offsetMs()).toBe(0);
  });

  it('slides the RTT window so a former outlier becomes acceptable', () => {
    const clock = new ClockEstimator();
    // Fill the window (rttWindow = 10) with rtt = 100.
    for (let i = 0; i < 10; i += 1) {
      expect(clock.addSample(sample(i * 1000, 0, 100))).toBe(true);
    }
    // rtt 250 > 2 * 100 → outlier, but rejected samples still enter the window.
    // After 5 rejections the window is [100 x5, 250 x5] with median 175,
    // so the 6th rtt=250 sample (250 <= 2 * 175) is accepted.
    for (let i = 0; i < 5; i += 1) {
      expect(clock.addSample(sample(10_000 + i * 1000, 0, 250))).toBe(false);
    }
    expect(clock.sampleCount()).toBe(10);
    expect(clock.addSample(sample(15_000, 0, 250))).toBe(true);
    expect(clock.sampleCount()).toBe(11);
  });
});
