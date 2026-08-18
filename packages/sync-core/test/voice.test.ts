import { describe, expect, it } from 'vitest';
import { DriftController, WATCH_ELASTIC, voiceActiveFrom } from '../src/index';

const entry = (state: string, micOn: boolean): { state: string; micOn: boolean } => ({
  state,
  micOn,
});

describe('voiceActiveFrom', () => {
  it('is false when nobody has a mic open', () => {
    expect(voiceActiveFrom([])).toBe(false);
    expect(voiceActiveFrom([entry('watching', false), entry('listening', false)])).toBe(false);
  });

  it('is true when anyone in a shared room is on mic', () => {
    expect(voiceActiveFrom([entry('in-call', true), entry('watching', false)])).toBe(true);
    expect(voiceActiveFrom([entry('watching', false), entry('in-call', true)])).toBe(true);
  });

  it('ignores offline rows and refuses to count a room of one', () => {
    expect(voiceActiveFrom([entry('in-call', true)])).toBe(false);
    expect(voiceActiveFrom([entry('in-call', true), entry('offline', true)])).toBe(false);
  });

  it('treats a missing micOn as no mic', () => {
    expect(voiceActiveFrom([{ state: 'in-call' }, { state: 'watching' }])).toBe(false);
  });
});

/**
 * The band-versus-ducking distinction, asserted at the source both platforms
 * now share. The controller's own ramp behaviour is covered by
 * drift-elastic.test.ts; what this pins is that a PRESENCE-derived boolean is
 * the thing that reaches it, and that a room where the mic state never changed
 * cannot make the band move — no matter what the speech detector is doing.
 */
describe('presence drives the band, speech does not', () => {
  const step = (d: DriftController, from: number, ticks: number): void => {
    for (let i = 1; i <= ticks; i += 1) {
      d.decide(5_000, 5_000 - 3_000, { ...WATCH_ELASTIC, nowMs: from + i * 500 });
    }
  };

  it('tightens while a mic is open and relaxes once every mic closes', () => {
    const d = new DriftController({ ...WATCH_ELASTIC, now: () => 0 });
    const roster = [entry('in-call', true), entry('watching', false)];

    d.setVoiceActive(voiceActiveFrom(roster));
    step(d, 0, 8);
    expect(d.isVoiceTightening()).toBe(true);
    expect(d.state().voiceBlend).toBeGreaterThan(0.9);

    const quiet = [entry('watching', false), entry('watching', false)];
    d.setVoiceActive(voiceActiveFrom(quiet));
    step(d, 4_000, 40);
    expect(d.state().voiceBlend).toBe(0);
    expect(d.isVoiceTightening()).toBe(false);
  });
});
