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

  it('a rejected sample leaves hasEstimate false: 0 is a placeholder, not a measurement', () => {
    const clock = new ClockEstimator();
    expect(clock.addSample({ clientSendTs: 1000, serverTs: 1000, clientRecvTs: 900 })).toBe(false);
    // The only way to tell "no estimate yet" from a true zero offset.
    expect(clock.hasEstimate()).toBe(false);
    expect(clock.offsetMs()).toBe(0);
    expect(clock.addSample(sample(2000, 0, 40))).toBe(true);
    expect(clock.hasEstimate()).toBe(true);
    expect(clock.offsetMs()).toBe(0);
  });

  it('exposes a state snapshot including the re-anchor signal', () => {
    const clock = new ClockEstimator();
    expect(clock.state()).toEqual({
      hasEstimate: false,
      offsetMs: 0,
      sampleCount: 0,
      reanchorCount: 0,
      lastReanchorMs: 0,
    });
    expect(clock.addSample(sample(0, -500, 80))).toBe(true);
    expect(clock.state()).toEqual({
      hasEstimate: true,
      offsetMs: -500,
      sampleCount: 1,
      reanchorCount: 0,
      lastReanchorMs: 0,
    });
  });
});

describe('ClockEstimator step handling', () => {
  it('holds a single over-threshold sample instead of smoothing toward it', () => {
    const clock = new ClockEstimator();
    expect(clock.addSample(sample(0, -500, 80))).toBe(true);
    // +30 s device-clock jump. One sample is not evidence: the EWMA would have
    // moved 25% of the way (to 7000) toward a number that may be a freak.
    expect(clock.addSample(sample(5000, 29_500, 80))).toBe(false);
    expect(clock.offsetMs()).toBe(-500);
    expect(clock.sampleCount()).toBe(1);
    expect(clock.reanchorCount()).toBe(0);
  });

  it('re-anchors in ONE move once a second sample confirms the step', () => {
    const clock = new ClockEstimator();
    expect(clock.addSample(sample(0, -500, 80))).toBe(true);
    expect(clock.addSample(sample(5000, 29_500, 80))).toBe(false); // held
    expect(clock.addSample(sample(10_000, 29_500, 80))).toBe(true); // confirmed
    expect(clock.offsetMs()).toBe(29_500);
    expect(clock.reanchorCount()).toBe(1);
    expect(clock.lastReanchorMs()).toBe(30_000);
    expect(clock.state().reanchorCount).toBe(1);
  });

  it('anchors on the MEAN of the confirming run, not on its last member', () => {
    const clock = new ClockEstimator({ stepAgreementMs: 250 });
    expect(clock.addSample(sample(0, 0, 80))).toBe(true);
    expect(clock.addSample(sample(5000, 5000, 80))).toBe(false);
    expect(clock.addSample(sample(10_000, 5100, 80))).toBe(true);
    expect(clock.offsetMs()).toBe(5050);
  });

  it('a lone outlier that survived the RTT filter never re-anchors anything', () => {
    const clock = new ClockEstimator();
    expect(clock.addSample(sample(0, -500, 80))).toBe(true);
    expect(clock.addSample(sample(5000, 60_000, 80))).toBe(false); // freak, held
    // The clock never moved: the next honest sample withdraws the candidate and
    // ordinary EWMA resumes from the estimate the freak never touched.
    expect(clock.addSample(sample(10_000, -480, 80))).toBe(true);
    expect(clock.offsetMs()).toBe(-495);
    expect(clock.reanchorCount()).toBe(0);
    // ...and the withdrawn candidate is not remembered: a LATER freak of the
    // same size still needs its own confirmation.
    expect(clock.addSample(sample(15_000, 60_000, 80))).toBe(false);
    expect(clock.offsetMs()).toBe(-495);
    expect(clock.reanchorCount()).toBe(0);
  });

  it('over-threshold samples that disagree with each other never confirm a step', () => {
    const clock = new ClockEstimator();
    expect(clock.addSample(sample(0, 0, 80))).toBe(true);
    // Three big samples, each far from the last: noise, not one new offset.
    expect(clock.addSample(sample(5000, 20_000, 80))).toBe(false);
    expect(clock.addSample(sample(10_000, -20_000, 80))).toBe(false);
    expect(clock.addSample(sample(15_000, 40_000, 80))).toBe(false);
    expect(clock.offsetMs()).toBe(0);
    expect(clock.reanchorCount()).toBe(0);
    // The last of them is now the run's only member; a sample agreeing with IT
    // is what finally re-anchors.
    expect(clock.addSample(sample(20_000, 40_100, 80))).toBe(true);
    expect(clock.offsetMs()).toBe(40_050);
    expect(clock.reanchorCount()).toBe(1);
  });

  it('leaves small drift to the EWMA: no step, no re-anchor', () => {
    const clock = new ClockEstimator({ alpha: 0.5 });
    expect(clock.addSample(sample(0, -500, 80))).toBe(true);
    // 900 ms is under the 1000 ms default threshold — ordinary drift.
    expect(clock.addSample(sample(5000, 400, 80))).toBe(true);
    expect(clock.offsetMs()).toBe(-50);
    expect(clock.reanchorCount()).toBe(0);
    expect(clock.sampleCount()).toBe(2);
  });

  it('honours a custom stepThresholdMs', () => {
    const clock = new ClockEstimator({ stepThresholdMs: 100 });
    expect(clock.addSample(sample(0, 0, 80))).toBe(true);
    expect(clock.addSample(sample(5000, 400, 80))).toBe(false); // > 100 → candidate
    expect(clock.addSample(sample(10_000, 400, 80))).toBe(true); // confirmed
    expect(clock.offsetMs()).toBe(400);
    expect(clock.reanchorCount()).toBe(1);
  });

  it('opts out with stepThresholdMs 0 or Infinity — pure EWMA, as before', () => {
    for (const stepThresholdMs of [0, Infinity]) {
      const clock = new ClockEstimator({ stepThresholdMs });
      expect(clock.addSample(sample(0, 0, 80))).toBe(true);
      expect(clock.addSample(sample(5000, 30_000, 80))).toBe(true);
      // Plain alpha 0.25 crawl, and nothing reports a re-anchor.
      expect(clock.offsetMs()).toBe(7500);
      expect(clock.reanchorCount()).toBe(0);
    }
  });

  it('clamps stepConfirmSamples to a floor of 2 so one sample can never re-anchor', () => {
    const clock = new ClockEstimator({ stepConfirmSamples: 1 });
    expect(clock.addSample(sample(0, 0, 80))).toBe(true);
    expect(clock.addSample(sample(5000, 30_000, 80))).toBe(false);
    expect(clock.offsetMs()).toBe(0);
    expect(clock.addSample(sample(10_000, 30_000, 80))).toBe(true);
    expect(clock.offsetMs()).toBe(30_000);
  });

  it('accepts a longer confirmation run when asked for one', () => {
    const clock = new ClockEstimator({ stepConfirmSamples: 3 });
    expect(clock.addSample(sample(0, 0, 80))).toBe(true);
    expect(clock.addSample(sample(5000, 30_000, 80))).toBe(false);
    expect(clock.addSample(sample(10_000, 30_000, 80))).toBe(false);
    expect(clock.offsetMs()).toBe(0);
    expect(clock.addSample(sample(15_000, 30_000, 80))).toBe(true);
    expect(clock.offsetMs()).toBe(30_000);
    expect(clock.reanchorCount()).toBe(1);
  });

  it('the RTT filter still outranks step detection', () => {
    const clock = new ClockEstimator();
    for (let i = 0; i < 3; i += 1) {
      expect(clock.addSample(sample(i * 1000, 0, 100))).toBe(true);
    }
    // Both samples would confirm a step, but their RTTs are 5x the median: a
    // long round-trip is exactly how a bogus offset gets manufactured, so they
    // are dropped before the offset math ever sees them.
    expect(clock.addSample(sample(5000, 30_000, 500))).toBe(false);
    expect(clock.addSample(sample(10_000, 30_000, 500))).toBe(false);
    expect(clock.offsetMs()).toBe(0);
    expect(clock.reanchorCount()).toBe(0);
  });

  it('covers an NTP correction in 2 samples where the EWMA needs ~10', () => {
    // The defect this exists for: at one heartbeat per 5 s, a smoothed 30 s step
    // leaves the room computing its position against a wrong offset for ~50 s,
    // and the drift controller hard-seeks every viewer to chase the difference.
    const stepping = new ClockEstimator();
    const smoothing = new ClockEstimator({ stepThresholdMs: 0 });
    expect(stepping.addSample(sample(0, 200, 80))).toBe(true);
    expect(smoothing.addSample(sample(0, 200, 80))).toBe(true);
    for (let i = 1; i <= 3; i += 1) {
      // Post-step samples carry a little jitter, as real ones do.
      const offset = 30_200 + (i % 2 === 0 ? 40 : -40);
      stepping.addSample(sample(i * 5000, offset, 80));
      smoothing.addSample(sample(i * 5000, offset, 80));
    }
    expect(Math.abs(stepping.offsetMs() - 30_200)).toBeLessThan(50);
    expect(stepping.reanchorCount()).toBe(1);
    // Three samples of EWMA are still ~13 s of error — enough for a room-wide seek.
    expect(Math.abs(smoothing.offsetMs() - 30_200)).toBeGreaterThan(12_000);
  });
});
