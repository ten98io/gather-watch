import { describe, it, expect } from 'vitest';
import {
  DriftController,
  STRICT_SYNC,
  WATCH_ELASTIC,
  LISTEN_ELASTIC,
} from '../src/drift';
import type { DriftAction, DriftDecideOptions } from '../src/drift';
import * as barrel from '../src/index';

/** Room position at `now`. Arbitrary but large enough that a seek target never
 *  clamps at 0, which would hide arithmetic errors. */
const BASE = 100_000;

/** One tick at wall time `now` with the viewer trailing the room by exactly
 *  `lagMs` (positive → behind). */
function tick(
  d: DriftController,
  lagMs: number,
  now: number,
  opts?: DriftDecideOptions,
): DriftAction {
  const expected = BASE + now;
  const actual = expected - lagMs;
  return d.decide(expected, actual, { ...opts, nowMs: now });
}

/** `count` ticks of a constant lag starting at `start`, every `tickMs`. */
function ticks(
  d: DriftController,
  lagMs: number,
  count: number,
  tickMs = 500,
  start = 0,
): DriftAction[] {
  const out: DriftAction[] = [];
  for (let i = 0; i < count; i += 1) out.push(tick(d, lagMs, start + i * tickMs));
  return out;
}

describe('drift presets', () => {
  it('STRICT_SYNC is exactly the historical default tuning', () => {
    expect(STRICT_SYNC).toEqual({
      deadbandMs: 60,
      releaseMs: 20,
      seekThresholdMs: 2000,
      convergeHorizonMs: 10000,
      minRate: 0.95,
      maxRate: 1.05,
      anchorEnabled: false,
    });
  });

  it('WATCH_ELASTIC and LISTEN_ELASTIC carry the spec bands', () => {
    expect(WATCH_ELASTIC.deadbandMs).toBe(2000);
    expect(WATCH_ELASTIC.seekThresholdMs).toBe(12000);
    expect(WATCH_ELASTIC.minRate).toBe(0.97);
    expect(WATCH_ELASTIC.maxRate).toBe(1.03);
    expect(WATCH_ELASTIC.anchorEnabled).toBe(true);

    expect(LISTEN_ELASTIC.deadbandMs).toBe(1500);
    expect(LISTEN_ELASTIC.seekThresholdMs).toBe(8000);
    expect(LISTEN_ELASTIC.minRate).toBe(0.99);
    expect(LISTEN_ELASTIC.maxRate).toBe(1.01);
    expect(LISTEN_ELASTIC.anchorEnabled).toBe(true);
  });

  it('listen clamps rate an order tighter than watch — pitch, not position', () => {
    // A 5% rate change is nearly a semitone; ±1% keeps the shift under a sixth
    // of one. Listen is NOT looser anywhere else: its deadband and seek
    // threshold are both tighter than watch's.
    const watchSpan = (WATCH_ELASTIC.maxRate ?? 1) - (WATCH_ELASTIC.minRate ?? 1);
    const listenSpan = (LISTEN_ELASTIC.maxRate ?? 1) - (LISTEN_ELASTIC.minRate ?? 1);
    expect(listenSpan).toBeLessThan(watchSpan);
    expect(LISTEN_ELASTIC.deadbandMs ?? 0).toBeLessThan(WATCH_ELASTIC.deadbandMs ?? 0);
    expect(LISTEN_ELASTIC.seekThresholdMs ?? 0).toBeLessThan(WATCH_ELASTIC.seekThresholdMs ?? 0);
  });

  it('presets are frozen so a caller cannot mutate shared tuning', () => {
    expect(Object.isFrozen(WATCH_ELASTIC)).toBe(true);
    expect(Object.isFrozen(LISTEN_ELASTIC)).toBe(true);
    expect(Object.isFrozen(STRICT_SYNC)).toBe(true);
  });

  it('is reachable from the package barrel', () => {
    expect(barrel.WATCH_ELASTIC).toBe(WATCH_ELASTIC);
    expect(barrel.LISTEN_ELASTIC).toBe(LISTEN_ELASTIC);
    expect(barrel.STRICT_SYNC).toBe(STRICT_SYNC);
    expect(barrel.DriftController).toBe(DriftController);
  });
});

describe('DriftController — backward compatibility', () => {
  it('default construction still frame-locks: 60 ms deadband, 2 s seek, ±5%', () => {
    const d = new DriftController();
    expect(d.decide(1060, 1000)).toEqual({ action: 'none', rate: 1 });
    expect(d.decide(1060.1, 1000).action).toBe('nudge');

    const fresh = new DriftController();
    expect(fresh.decide(3001, 1000)).toEqual({ action: 'seek', toMs: 3001, rate: 1 });

    const clampHigh = new DriftController();
    expect(clampHigh.decide(3000, 1000).rate).toBe(1.05);
    const clampLow = new DriftController();
    expect(clampLow.decide(1000, 3000).rate).toBe(0.95);
  });

  it('constructing from STRICT_SYNC is indistinguishable from the bare default', () => {
    const bare = new DriftController();
    const strict = new DriftController(STRICT_SYNC);
    const cases: ReadonlyArray<readonly [number, number]> = [
      [1059, 1000],
      [1100, 1000],
      [1040, 1000],
      [1010, 1000],
      [4000, 1000],
      [-500, 2000],
    ];
    for (const [expected, actual] of cases) {
      expect(strict.decide(expected, actual)).toEqual(bare.decide(expected, actual));
      expect(strict.isNudging()).toBe(bare.isNudging());
    }
  });

  it('anchoring is off by default: an 8 s lag still seeks and no anchor is learned', () => {
    const d = new DriftController();
    const decisions = ticks(d, 8000, 12);
    for (const decision of decisions) expect(decision.action).toBe('seek');
    expect(d.anchorOffsetMs()).toBe(0);
    expect(d.state().anchorOffsetMs).toBe(0);
  });

  it('reset() still clears the nudging state (and now the anchor too)', () => {
    const d = new DriftController(WATCH_ELASTIC);
    ticks(d, 8000, 8);
    expect(d.anchorOffsetMs()).toBeGreaterThan(0);
    d.reset();
    expect(d.isNudging()).toBe(false);
    expect(d.anchorOffsetMs()).toBe(0);
  });

  it('falls back to its clock source when a call omits nowMs', () => {
    let clock = 0;
    const d = new DriftController({ ...WATCH_ELASTIC, now: () => clock });
    for (let i = 0; i < 8; i += 1) {
      clock = i * 500;
      d.decide(BASE + clock, BASE + clock - 8000);
    }
    expect(d.anchorOffsetMs()).toBeGreaterThan(7900);
    expect(d.anchorOffsetMs()).toBeLessThanOrEqual(8000);
  });
});

describe('DriftController — learned anchor', () => {
  it('adopts a lag that holds steady for anchorAdoptAfterMs, then stops correcting', () => {
    const d = new DriftController(WATCH_ELASTIC);
    const decisions = ticks(d, 8000, 8); // 0 … 3500 ms

    // Before adoption it does what it can: a max-clamped nudge, never a seek.
    expect(decisions[0]?.action).toBe('nudge');
    expect(decisions[0]?.rate).toBeCloseTo(1.03, 10);
    expect(decisions.slice(0, 6).every((x) => x.action === 'nudge')).toBe(true);

    // At t = 3000 the lag is adopted and the viewer is simply left alone.
    expect(decisions[6]).toEqual({ action: 'none', rate: 1 });
    expect(d.anchorOffsetMs()).toBeGreaterThan(7900);
    expect(d.anchorOffsetMs()).toBeLessThanOrEqual(8000);
    expect(d.isNudging()).toBe(false);
    expect(d.state().anchorArmed).toBe(false);
  });

  it('a viewer 8 s behind converges to none rather than seek (elastic) …', () => {
    const d = new DriftController(WATCH_ELASTIC);
    const decisions = ticks(d, 8000, 30);
    expect(decisions.some((x) => x.action === 'seek')).toBe(false);
    expect(decisions.at(-1)).toEqual({ action: 'none', rate: 1 });
  });

  it('… while the very same case still seeks under STRICT_SYNC', () => {
    const d = new DriftController(STRICT_SYNC);
    const decisions = ticks(d, 8000, 30);
    expect(decisions.every((x) => x.action === 'seek')).toBe(true);
    expect(decisions[0]).toEqual({ action: 'seek', toMs: BASE, rate: 1 });
  });

  it('leans on the anchor in a listen room instead of ±5% pitch shifting', () => {
    const d = new DriftController(LISTEN_ELASTIC);
    const decisions = ticks(d, 4000, 10);
    for (const decision of decisions) {
      expect(decision.action).not.toBe('seek');
      if (decision.action === 'nudge') expect(decision.rate).toBeLessThanOrEqual(1.01);
    }
    expect(d.anchorOffsetMs()).toBeGreaterThan(3900);
    expect(d.anchorOffsetMs()).toBeLessThanOrEqual(4000);
  });

  it('a jittery lag is never adopted — only a settled one', () => {
    const d = new DriftController(WATCH_ELASTIC);
    // ±1500 ms swings, far beyond anchorStabilityMs: the window keeps restarting.
    for (let i = 0; i < 20; i += 1) {
      tick(d, i % 2 === 0 ? 4000 : 5500, i * 500);
    }
    expect(d.anchorOffsetMs()).toBe(0);
  });

  it('decays the anchor toward 0 while playback is calm (ms per second of playback)', () => {
    const d = new DriftController(WATCH_ELASTIC); // 20 ms shed per second
    ticks(d, 8000, 4, 1000); // adopt at t = 3000
    const adopted = d.anchorOffsetMs();
    expect(adopted).toBeCloseTo(8000, -2);

    const after = ticks(d, 8000, 20, 1000, 4000); // 20 further seconds of calm
    for (const decision of after) expect(decision).toEqual({ action: 'none', rate: 1 });

    const shed = adopted - d.anchorOffsetMs();
    expect(shed).toBeGreaterThan(0);
    expect(shed).toBeCloseTo(20 * 20, -1); // ~400 ms over 20 s
    expect(d.anchorOffsetMs()).toBeLessThan(adopted);
  });

  it('decay is configurable and pauses while the controller is correcting', () => {
    const fast = new DriftController({ ...WATCH_ELASTIC, anchorDecayMsPerSec: 200 });
    ticks(fast, 8000, 4, 1000);
    const adopted = fast.anchorOffsetMs();
    ticks(fast, 8000, 10, 1000, 4000);
    // 200 ms/s for ~10 s, minus the ticks spent nudging once drift left the band.
    expect(adopted - fast.anchorOffsetMs()).toBeGreaterThan(1000);

    const none = new DriftController({ ...WATCH_ELASTIC, anchorDecayMsPerSec: 0 });
    ticks(none, 8000, 4, 1000);
    const held = none.anchorOffsetMs();
    ticks(none, 8000, 10, 1000, 4000);
    expect(none.anchorOffsetMs()).toBe(held);
  });

  it('caps the anchor magnitude at anchorMaxMs, in both directions', () => {
    const d = new DriftController(WATCH_ELASTIC);
    d.noteSettledLag(30_000);
    expect(d.anchorOffsetMs()).toBe(15_000);
    d.noteSettledLag(-30_000);
    expect(d.anchorOffsetMs()).toBe(-15_000);

    const tightCap = new DriftController({ ...WATCH_ELASTIC, anchorMaxMs: 5000 });
    tightCap.noteSettledLag(30_000);
    expect(tightCap.anchorOffsetMs()).toBe(5000);

    tightCap.noteSettledLag(Number.NaN);
    expect(tightCap.anchorOffsetMs()).toBe(5000);
  });

  it('a learned anchor never exceeds the cap either', () => {
    const d = new DriftController({ ...WATCH_ELASTIC, anchorMaxMs: 3000, seekThresholdMs: 60_000 });
    ticks(d, 25_000, 12);
    expect(Math.abs(d.anchorOffsetMs())).toBeLessThanOrEqual(3000);
  });

  it('resets the anchor on track change, host seek and explicit reanchor()', () => {
    const onTrackChange = new DriftController(WATCH_ELASTIC);
    ticks(onTrackChange, 8000, 8);
    expect(onTrackChange.anchorOffsetMs()).toBeGreaterThan(0);
    onTrackChange.noteTrackChange();
    expect(onTrackChange.anchorOffsetMs()).toBe(0);
    expect(onTrackChange.state().anchorArmed).toBe(true);

    const onHostSeek = new DriftController(WATCH_ELASTIC);
    ticks(onHostSeek, 8000, 8);
    onHostSeek.noteHostSeek();
    expect(onHostSeek.anchorOffsetMs()).toBe(0);

    const explicit = new DriftController(WATCH_ELASTIC);
    ticks(explicit, 8000, 8);
    explicit.reanchor();
    expect(explicit.anchorOffsetMs()).toBe(0);
    explicit.reanchor(2500);
    expect(explicit.anchorOffsetMs()).toBe(2500);
  });

  it('re-learns after a buffering event without discarding the current anchor', () => {
    const d = new DriftController(WATCH_ELASTIC);
    ticks(d, 8000, 8);
    const before = d.anchorOffsetMs();
    d.noteBuffering();
    expect(d.anchorOffsetMs()).toBeCloseTo(before, 10); // held, not dropped
    expect(d.state().anchorArmed).toBe(true);

    // The viewer settles 3 s further back; the new lag is adopted.
    ticks(d, 11_000, 10, 500, 4000);
    expect(d.anchorOffsetMs()).toBeCloseTo(11_000, -2);
  });

  it('seeks to the anchored position, not to the room position', () => {
    const d = new DriftController(WATCH_ELASTIC);
    d.noteSettledLag(5000);
    const decision = d.decide(BASE, BASE - 20_000, { nowMs: 0 });
    expect(decision).toEqual({ action: 'seek', toMs: BASE - 5000, rate: 1 });
  });

  it('absorbs a lag the nudge cannot close, even with no disturbance reported', () => {
    // Rate is nominally available but the player ignores it: the lag never moves.
    // anchorRearmAfterMs re-opens learning, and the adoption test sees no progress.
    const d = new DriftController(WATCH_ELASTIC);
    ticks(d, 8000, 8); // adopt 8000
    d.noteSettledLag(0); // pretend a caller pinned it back to 0
    const decisions = ticks(d, 8000, 60, 500, 4000);
    expect(decisions.some((x) => x.action === 'seek')).toBe(false);
    expect(decisions.at(-1)).toEqual({ action: 'none', rate: 1 });
    expect(d.anchorOffsetMs()).toBeGreaterThan(7000);
  });

  it('does not give up on a nudge that is actually working', () => {
    const d = new DriftController(WATCH_ELASTIC);
    d.noteSettledLag(0); // disarm the track-start adoption
    let lag = 8000;
    let last: DriftAction = { action: 'none', rate: 1 };
    for (let i = 0; i < 60; i += 1) {
      last = tick(d, lag, i * 500);
      if (last.action === 'nudge') lag -= (last.rate - 1) * 500; // the rate is honoured
    }
    expect(last.action).toBe('nudge');
    expect(d.anchorOffsetMs()).toBe(0); // no stalemate: nothing was adopted
    expect(lag).toBeLessThan(8000);
  });
});

describe('DriftController — adaptive band for live voice', () => {
  it('tightens the band toward voiceTargetMs while voice is live', () => {
    const d = new DriftController({ ...WATCH_ELASTIC, anchorEnabled: false });
    // 1.5 s sits inside the 2 s elastic deadband.
    expect(tick(d, 1500, 0)).toEqual({ action: 'none', rate: 1 });

    d.setVoiceActive(true);
    const decisions = ticks(d, 1500, 8, 500, 500);
    expect(decisions.at(-1)?.action).toBe('nudge');
    expect(d.isVoiceTightening()).toBe(true);
    expect(d.state().voiceBlend).toBe(1);
  });

  it('never escalates to a seek while voice is active, up to the ceiling', () => {
    const d = new DriftController(WATCH_ELASTIC);
    d.setVoiceActive(true);
    const decisions = ticks(d, 30_000, 60); // 2.5× the seek threshold, for 30 s
    expect(decisions.some((x) => x.action === 'seek')).toBe(false);
    for (const decision of decisions) {
      if (decision.action === 'nudge') expect(decision.rate).toBeCloseTo(1.03, 10);
    }
    // The anchor is squeezed to the voice target: a 1 s band is meaningless if
    // the viewer is still anchored 8 s back.
    expect(Math.abs(d.anchorOffsetMs())).toBeLessThanOrEqual(1000);
  });

  /**
   * The rescue clause. Suppression protects a live reaction; a viewer minutes
   * behind is not having one, and rate alone can never bring them back — 5
   * minutes at the watch band's ±3% is over two hours of playback. Tightening
   * must raise the bar for a seek, not remove it.
   */
  it('still rescues a viewer 5 minutes behind, mic open or not', () => {
    const d = new DriftController(WATCH_ELASTIC);
    d.setVoiceActive(true);
    const decision = tick(d, 300_000, 0);
    expect(decision).toEqual({ action: 'seek', toMs: BASE, rate: 1 });
    expect(d.isVoiceTightening()).toBe(true);
  });

  it('rescues a listen room the same way — the ceiling is not per-band', () => {
    const d = new DriftController(LISTEN_ELASTIC);
    d.setVoiceActive(true);
    expect(tick(d, 300_000, 0).action).toBe('seek');
  });

  it('holds the line exactly at the ceiling and breaks it one tick past', () => {
    const at = new DriftController({ ...WATCH_ELASTIC, anchorEnabled: false });
    at.setVoiceActive(true);
    expect(at.decide(BASE, BASE - 30_000, { nowMs: 0 }).action).toBe('nudge');

    const past = new DriftController({ ...WATCH_ELASTIC, anchorEnabled: false });
    past.setVoiceActive(true);
    expect(past.decide(BASE, BASE - 30_001, { nowMs: 0 }).action).toBe('seek');
  });

  it('the ceiling is configurable, and Infinity restores absolute suppression', () => {
    const tight = new DriftController({
      ...WATCH_ELASTIC,
      anchorEnabled: false,
      voiceSeekCeilingMs: 15_000,
    });
    tight.setVoiceActive(true);
    expect(tick(tight, 20_000, 0).action).toBe('seek');

    const absolute = new DriftController({
      ...WATCH_ELASTIC,
      anchorEnabled: false,
      voiceSeekCeilingMs: Number.POSITIVE_INFINITY,
    });
    absolute.setVoiceActive(true);
    expect(ticks(absolute, 600_000, 20).some((x) => x.action === 'seek')).toBe(false);
  });

  it('the ceiling measures the ANCHORED drift, so a held anchor is not double-counted', () => {
    // The viewer is deliberately parked 10 s back and the room is 10 s ahead of
    // them: the raw lag is 20 s but the drift against their own anchor is 10 s.
    // A ceiling read off the raw lag would rescue a viewer who is exactly where
    // the controller put them.
    const d = new DriftController({ ...WATCH_ELASTIC, voiceSeekCeilingMs: 15_000 });
    d.noteSettledLag(10_000);
    d.setVoiceActive(true);
    expect(d.decide(BASE, BASE - 20_000, { nowMs: 0 }).action).toBe('nudge');
  });

  it('the rescue lands on the anchored position, like every other seek', () => {
    const d = new DriftController({ ...WATCH_ELASTIC, anchorMaxMs: 40_000 });
    d.noteSettledLag(40_000);
    d.setVoiceActive(true);
    // Squeezing the anchor toward the voice target takes the full attack ramp,
    // so the first tick still holds a large anchor and the seek must respect it.
    const decision = d.decide(BASE, BASE - 300_000, { nowMs: 0 });
    expect(decision).toEqual({ action: 'seek', toMs: BASE - 40_000, rate: 1 });
  });

  it('squeezes an existing anchor down smoothly, not in a step', () => {
    const d = new DriftController(WATCH_ELASTIC);
    d.noteSettledLag(8000);
    tick(d, 8000, 0);
    d.setVoiceActive(true);

    const seen: number[] = [];
    for (let i = 1; i <= 5; i += 1) {
      tick(d, 8000, i * 500);
      seen.push(d.anchorOffsetMs());
    }
    // Monotonically down, in steps, over the 2 s attack ramp — not one jump.
    expect(seen[0]).toBeLessThan(8000);
    expect(seen[0]).toBeGreaterThan(1000);
    expect(seen.at(-1)).toBeCloseTo(1000, 6);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i] ?? 0).toBeLessThanOrEqual(seen[i - 1] ?? 0);
    }
  });

  it('relaxes back to the elastic band over voiceReleaseMs, not at once', () => {
    const d = new DriftController({ ...WATCH_ELASTIC, anchorEnabled: false });
    d.setVoiceActive(true);
    const held = ticks(d, 20_000, 10); // past the 12 s seek threshold
    expect(held.every((x) => x.action === 'nudge')).toBe(true);

    d.setVoiceActive(false);
    const relaxing = ticks(d, 20_000, 24, 500, 5000);
    const firstSeek = relaxing.findIndex((x) => x.action === 'seek');
    expect(relaxing[0]?.action).toBe('nudge'); // no step back to seeking
    expect(firstSeek).toBeGreaterThanOrEqual(10); // ~8 s of release ramp
    expect(firstSeek).toBeLessThan(20);
    expect(d.isVoiceTightening()).toBe(false);
  });

  it('voiceSuppressSeek: false lets the caller opt back into hard seeks', () => {
    const d = new DriftController({
      ...WATCH_ELASTIC,
      anchorEnabled: false,
      voiceSuppressSeek: false,
    });
    d.setVoiceActive(true);
    expect(tick(d, 20_000, 0).action).toBe('seek');
  });
});

describe('DriftController — rate control unavailable', () => {
  it('stops prescribing nudges and lets the anchor absorb the offset', () => {
    const d = new DriftController(WATCH_ELASTIC);
    d.setRateControlAvailable(false);
    const decisions = ticks(d, 5000, 12);
    expect(decisions.some((x) => x.action === 'nudge')).toBe(false);
    expect(decisions.some((x) => x.action === 'seek')).toBe(false);
    expect(decisions.at(-1)).toEqual({ action: 'none', rate: 1 });
    expect(d.anchorOffsetMs()).toBeGreaterThan(4900);
    expect(d.anchorOffsetMs()).toBeLessThanOrEqual(5000);
    expect(d.state().rateControlAvailable).toBe(false);
  });

  it('still seeks when drift exceeds the seek threshold', () => {
    const d = new DriftController(WATCH_ELASTIC);
    d.noteRateRejected();
    const decisions = ticks(d, 20_000, 6);
    expect(decisions.every((x) => x.action === 'seek')).toBe(true);
  });

  it('with anchoring off it simply holds still instead of nudging forever', () => {
    const d = new DriftController(); // strict defaults
    d.setRateControlAvailable(false);
    expect(d.decide(1500, 1000)).toEqual({ action: 'none', rate: 1 });
    expect(d.isNudging()).toBe(false);
    expect(d.decide(4000, 1000).action).toBe('seek');
  });

  it('resumes nudging once the caller reports rate control back', () => {
    const d = new DriftController({ ...WATCH_ELASTIC, anchorEnabled: false });
    d.setRateControlAvailable(false);
    expect(tick(d, 5000, 0).action).toBe('none');
    d.setRateControlAvailable(true);
    const resumed = tick(d, 5000, 500);
    expect(resumed.action).toBe('nudge');
    expect(resumed.rate).toBeCloseTo(1.03, 10);
  });
});
