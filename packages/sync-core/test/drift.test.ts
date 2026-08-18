import { describe, it, expect } from 'vitest';
import { DriftController } from '../src/drift';

describe('DriftController', () => {
  it('stays idle inside the deadband: |drift| <= 60 → none, 60.1 → nudge', () => {
    const d = new DriftController();
    expect(d.decide(1059, 1000)).toEqual({ action: 'none', rate: 1 });
    expect(d.isNudging()).toBe(false);

    const edge = new DriftController();
    expect(edge.decide(1060, 1000)).toEqual({ action: 'none', rate: 1 });

    const over = new DriftController();
    const res = over.decide(1060.1, 1000);
    expect(res.action).toBe('nudge');
    expect(over.isNudging()).toBe(true);
  });

  it('nudges proportionally: drift +300 → 1.03, -300 → 0.97', () => {
    const pos = new DriftController();
    const r1 = pos.decide(1300, 1000);
    expect(r1.action).toBe('nudge');
    expect(r1.rate).toBeCloseTo(1.03, 10);

    const neg = new DriftController();
    const r2 = neg.decide(700, 1000);
    expect(r2.action).toBe('nudge');
    expect(r2.rate).toBeCloseTo(0.97, 10);
  });

  it('clamps the nudge rate at 1.05 / 0.95', () => {
    const pos = new DriftController();
    const r1 = pos.decide(3000, 1000); // drift +2000 → 1.2 pre-clamp
    expect(r1.action).toBe('nudge');
    expect(r1.rate).toBe(1.05);

    const neg = new DriftController();
    const r2 = neg.decide(1000, 3000); // drift -2000 → 0.8 pre-clamp
    expect(r2.action).toBe('nudge');
    expect(r2.rate).toBe(0.95);
  });

  it('seeks beyond the threshold and clamps toMs at >= 0', () => {
    const pos = new DriftController();
    expect(pos.decide(3001, 1000)).toEqual({ action: 'seek', toMs: 3001, rate: 1 });
    expect(pos.isNudging()).toBe(false);

    const neg = new DriftController();
    expect(neg.decide(1000, 3001)).toEqual({ action: 'seek', toMs: 1000, rate: 1 });

    const clamped = new DriftController();
    expect(clamped.decide(-500, 2000)).toEqual({ action: 'seek', toMs: 0, rate: 1 });
  });

  it('hysteresis: keeps nudging above releaseMs, stops at/below it, stays idle after', () => {
    const d = new DriftController();
    // Enter nudging at drift 100.
    const enter = d.decide(1100, 1000);
    expect(enter.action).toBe('nudge');
    expect(d.isNudging()).toBe(true);

    // drift 40: inside the deadband but above releaseMs (20) → STILL nudging.
    const hold = d.decide(1040, 1000);
    expect(hold.action).toBe('nudge');
    expect(hold.rate).toBeCloseTo(1.004, 10);
    expect(d.isNudging()).toBe(true);

    // drift 10 <= releaseMs → back to none.
    expect(d.decide(1010, 1000)).toEqual({ action: 'none', rate: 1 });
    expect(d.isNudging()).toBe(false);

    // drift 40 again: not nudging anymore and inside the deadband → none.
    // This is the oscillation guard.
    expect(d.decide(1040, 1000)).toEqual({ action: 'none', rate: 1 });
  });

  it('a seek clears the nudging state', () => {
    const d = new DriftController();
    expect(d.decide(1100, 1000).action).toBe('nudge');
    expect(d.decide(4000, 1000)).toEqual({ action: 'seek', toMs: 4000, rate: 1 });
    expect(d.isNudging()).toBe(false);
    // drift 40 now: inside deadband, not nudging → none.
    expect(d.decide(1040, 1000)).toEqual({ action: 'none', rate: 1 });
  });

  it('per-call opts override the constructor defaults for that call only', () => {
    const d = new DriftController();
    // Default deadband 60: drift 15 → none.
    expect(d.decide(1015, 1000)).toEqual({ action: 'none', rate: 1 });
    // With deadbandMs 10 the same drift nudges.
    const res = d.decide(1015, 1000, { deadbandMs: 10 });
    expect(res.action).toBe('nudge');
    expect(res.rate).toBeCloseTo(1.0015, 10);
  });

  it('reset() clears the nudging state', () => {
    const d = new DriftController();
    expect(d.decide(1100, 1000).action).toBe('nudge');
    expect(d.isNudging()).toBe(true);
    d.reset();
    expect(d.isNudging()).toBe(false);
    expect(d.decide(1040, 1000)).toEqual({ action: 'none', rate: 1 });
  });
});

describe('DriftController terminal state (durationMs)', () => {
  it('an expectation past the end reads as in-sync, not as "behind"', () => {
    // The item is 60 s long and has run out; the room's projection keeps
    // climbing. Without a duration this is a 40 s deficit forever.
    const runaway = new DriftController();
    expect(runaway.decide(100_000, 60_000)).toEqual({
      action: 'seek',
      toMs: 100_000,
      rate: 1,
    });

    const d = new DriftController();
    expect(d.decide(100_000, 60_000, { durationMs: 60_000 })).toEqual({
      action: 'none',
      rate: 1,
    });
    expect(d.isNudging()).toBe(false);
  });

  it('never prescribes a seek past the end', () => {
    const d = new DriftController();
    // Well past the seek threshold, but the player is only slightly short of
    // the end: the correction may only ever name a position inside the media.
    const res = d.decide(100_000, 40_000, { durationMs: 60_000 });
    expect(res.action).toBe('seek');
    if (res.action === 'seek') expect(res.toMs).toBe(60_000);
  });

  it('corrects normally while the expectation is inside the media', () => {
    const d = new DriftController();
    const res = d.decide(20_300, 20_000, { durationMs: 60_000 });
    expect(res.action).toBe('nudge');
    expect(res.rate).toBeCloseTo(1.03, 10);
  });

  it('ignores a duration that is unknown or nonsense', () => {
    // 0 is "not known yet" for every adapter (pre-metadata / YouTube
    // pre-ready); a live stream reports Infinity. Neither may clamp anything.
    const unknown = new DriftController();
    expect(unknown.decide(100_000, 60_000, { durationMs: 0 }).action).toBe('seek');

    const live = new DriftController();
    expect(live.decide(100_000, 60_000, { durationMs: Infinity }).action).toBe('seek');
  });
});
