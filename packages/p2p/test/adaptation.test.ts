import { describe, expect, it } from 'vitest';
import { BitrateGovernor, LinkAdaptor, applyMaxBitrate } from '../src/adaptation';
import type { LinkSample } from '../src/adaptation';
import type { RtpParametersLike, RtpSenderLike } from '../src/types';
import { VirtualClock } from './harness';

const bad = (timestampMs: number): LinkSample => ({ timestampMs, rttMs: 40, lossFraction: 0.08 });
const good = (timestampMs: number): LinkSample => ({ timestampMs, rttMs: 40, lossFraction: 0.001 });

describe('BitrateGovernor', () => {
  it('downgrades on sustained loss and clamps at the floor', () => {
    const gov = new BitrateGovernor();
    expect(gov.onSample(bad(0))).toBeNull();
    expect(gov.onSample(bad(2000))).toBe(1_750_000);

    // Keep feeding bad samples every 2000ms: each consecutive pair steps the
    // target down 0.7x until it clamps at exactly 200_000, never below.
    let previous = gov.targetBps();
    for (let i = 0; i < 20; i += 1) {
      const next = gov.onSample(bad(4000 + i * 2000));
      if (next !== null) {
        expect(next).toBeLessThan(previous);
        expect(next).toBeGreaterThanOrEqual(200_000);
        previous = next;
      }
      expect(gov.targetBps()).toBeGreaterThanOrEqual(200_000);
    }
    expect(gov.targetBps()).toBe(200_000);
  });

  it('recovers only after cooldown and clamps at the ceiling', () => {
    const gov = new BitrateGovernor();
    gov.onSample(bad(0));
    expect(gov.onSample(bad(2000))).toBe(1_750_000);

    // Good samples every 2000ms: the first raise needs BOTH the 3rd
    // consecutive good sample AND >= 4000ms since the drop.
    expect(gov.onSample(good(4000))).toBeNull(); // streak 1
    expect(gov.onSample(good(6000))).toBeNull(); // streak 2
    // streak 3, and 8000 - 2000 = 6000 >= 4000 → raise.
    expect(gov.onSample(good(8000))).toBe(2_012_500);

    // Continued good samples keep raising by 1.15x until the ceiling.
    let raised = false;
    for (let i = 0; i < 37; i += 1) {
      const next = gov.onSample(good(10_000 + i * 2000));
      if (next !== null) {
        raised = true;
        expect(next).toBeLessThanOrEqual(8_000_000);
      }
      expect(gov.targetBps()).toBeLessThanOrEqual(8_000_000);
    }
    expect(raised).toBe(true);
    expect(gov.targetBps()).toBe(8_000_000);
  });

  it('mixed samples do not flap', () => {
    const gov = new BitrateGovernor();
    for (let i = 0; i < 12; i += 1) {
      const sample = i % 2 === 0 ? bad(i * 2000) : good(i * 2000);
      expect(gov.onSample(sample)).toBeNull();
    }
    expect(gov.targetBps()).toBe(2_500_000);
  });

  it('rtt spike counts as bad', () => {
    const gov = new BitrateGovernor();
    const calm = (timestampMs: number): LinkSample => ({ timestampMs, rttMs: 40, lossFraction: 0 });
    const spike = (timestampMs: number): LinkSample => ({ timestampMs, rttMs: 400, lossFraction: 0 });

    expect(gov.onSample(calm(0))).toBeNull();
    expect(gov.onSample(calm(2000))).toBeNull();
    // Third consecutive good sample raises (no prior change → cooldown open).
    expect(gov.onSample(calm(4000))).toBe(2_875_000);

    expect(gov.onSample(spike(6000))).toBeNull(); // first bad sample rearms the streak
    expect(gov.onSample(spike(8000))).toBe(2_012_500); // round(2_875_000 * 0.7)
  });
});

describe('LinkAdaptor', () => {
  it('drives from pollFn and stop() halts', async () => {
    const clock = new VirtualClock();
    const scripted: LinkSample[] = [bad(100), bad(200)];
    let polls = 0;
    const applied: number[] = [];
    const adaptor = new LinkAdaptor({
      pollFn: () => {
        const sample = scripted[polls] ?? good(300 + polls * 100);
        polls += 1;
        return Promise.resolve(sample);
      },
      apply: (bps) => {
        applied.push(bps);
      },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      intervalMs: 100,
    });

    adaptor.start();
    await clock.advance(250); // ticks at +100 (bad) and +200 (bad → downgrade)
    expect(polls).toBe(2);
    expect(applied).toEqual([1_750_000]);

    adaptor.stop();
    await clock.advance(1000);
    expect(polls).toBe(2);
    expect(applied).toEqual([1_750_000]);
  });
});

describe('applyMaxBitrate', () => {
  it('writes maxBitrate into every encoding, preserving other fields', async () => {
    const parameters: RtpParametersLike = {
      encodings: [{ active: true }, { active: false, maxBitrate: 100_000 }],
    };
    let received: RtpParametersLike | null = null;
    const sender: RtpSenderLike = {
      track: null,
      getParameters: () => parameters,
      setParameters: (p) => {
        received = p;
        return Promise.resolve();
      },
    };

    await applyMaxBitrate(sender, 500_000);

    expect(parameters.encodings[0]).toEqual({ active: true, maxBitrate: 500_000 });
    expect(parameters.encodings[1]).toEqual({ active: false, maxBitrate: 500_000 });
    // setParameters received the same (mutated) parameters object.
    expect(received).toBe(parameters);
  });
});
