/**
 * E17 on mobile — the adaptive comfort band (docs/EXTENSION_FIRST.md Part 1,
 * "Consequence B"). Until now `DriftController.setVoiceActive` was called from
 * exactly one place in the product, the browser extension; the mobile app ran
 * the elastic band wide open no matter who was on mic.
 *
 * SCOPE OF WHAT THIS FILE CAN PROVE. This package's vitest is node-only and
 * deliberately renderer-free (see vitest.config.ts), so the hook itself is not
 * mountable here. What is asserted instead is the whole of the decision the
 * hook makes: the selector Stage passes to `useSyncEngine`, read off a real
 * RoomState presence map, and the band that results from feeding it to the
 * same controller the hook builds. The one link not covered is the `useEffect`
 * that forwards it — which is also the one line of it that carries no logic.
 */
import { describe, expect, it } from 'vitest';
import type { PresenceEntry, UserId } from '@gather/contracts';
import { DriftController, WATCH_ELASTIC } from '@gather/sync-core';
import { roomVoiceActive } from '../src/sync/voice';

const ME = 'u-me' as UserId;
const PEER = 'u-peer' as UserId;

const entry = (
  userId: UserId,
  state: PresenceEntry['state'],
  micOn: boolean,
): PresenceEntry => ({
  userId,
  state,
  micOn,
  camOn: false,
  sharing: false,
  lastSeenTs: 0,
});

describe('roomVoiceActive', () => {
  it('is true while anybody in a shared room has a mic open', () => {
    expect(
      roomVoiceActive({
        presence: { [ME]: entry(ME, 'in-call', true), [PEER]: entry(PEER, 'watching', false) },
      }),
    ).toBe(true);
  });

  it('is false with every mic closed, and false for a room of one', () => {
    expect(
      roomVoiceActive({
        presence: { [ME]: entry(ME, 'watching', false), [PEER]: entry(PEER, 'watching', false) },
      }),
    ).toBe(false);
    expect(roomVoiceActive({ presence: { [ME]: entry(ME, 'in-call', true) } })).toBe(false);
    expect(roomVoiceActive({ presence: {} })).toBe(false);
  });
});

/**
 * The band this selector buys, through the controller the mobile hook builds
 * for a video room. WATCH_ELASTIC ignores drift under 2 s; voice-tightened it
 * converges toward 1 s. So the same steady 1.5 s lag is silence in a quiet
 * room and a rate nudge in a room with an open mic.
 */
describe('the band a mobile room actually gets', () => {
  const LAG_MS = 1_500;
  const TICK_MS = 500;

  const QUIET = {
    presence: { [ME]: entry(ME, 'watching', false), [PEER]: entry(PEER, 'watching', false) },
  };
  const TALKING = {
    presence: { [ME]: entry(ME, 'in-call', true), [PEER]: entry(PEER, 'watching', false) },
  };

  /** Run the controller for a stretch at a fixed lag; returns each tick's
   *  prescribed rate (1 when it decided to do nothing). */
  const run = (
    d: DriftController,
    from: number,
    ticks: number,
    lagMs: number,
  ): { rates: number[]; end: number } => {
    const rates: number[] = [];
    let t = from;
    for (let i = 0; i < ticks; i += 1) {
      t += TICK_MS;
      const decision = d.decide(10_000, 10_000 - lagMs, { ...WATCH_ELASTIC, nowMs: t });
      rates.push(decision.action === 'nudge' ? decision.rate : 1);
      expect(decision.action).not.toBe('seek');
    }
    return { rates, end: t };
  };

  /** Fresh per case: a controller that has already learned an anchor for this
   *  lag would sit still for reasons that have nothing to do with the band. */
  const controller = (): DriftController =>
    new DriftController({ ...WATCH_ELASTIC, now: () => 0 });

  it('leaves a 1.5 s lag alone while every mic is closed', () => {
    const d = controller();
    d.setVoiceActive(roomVoiceActive(QUIET));
    expect(run(d, 0, 4, LAG_MS).rates.every((r) => r === 1)).toBe(true);
  });

  it('tightens onto the very same lag once one mic opens', () => {
    const d = controller();
    d.setVoiceActive(roomVoiceActive(TALKING));
    // Past the 2 s voice attack, short of the 3 s anchor adoption.
    expect(run(d, 0, 5, LAG_MS).rates.some((r) => r !== 1)).toBe(true);
  });

  it('relaxes back once every mic closes again', () => {
    const d = controller();
    d.setVoiceActive(roomVoiceActive(TALKING));
    const tightened = run(d, 0, 5, LAG_MS);
    expect(tightened.rates.some((r) => r !== 1)).toBe(true);

    // The room settles (the nudge did its job), so hysteresis lets go, and
    // every mic closes. Past the controller's 8 s voice release.
    d.setVoiceActive(roomVoiceActive(QUIET));
    const settled = run(d, tightened.end, 20, 200);
    expect(d.state().voiceBlend).toBe(0);

    // Now the same 1.5 s opens up again. In a quiet room that is inside the
    // band, and the band is what this asserts — not a learned anchor, which
    // 200 ms of calm is too small to have adopted.
    expect(run(d, settled.end, 4, LAG_MS).rates.every((r) => r === 1)).toBe(true);
  });
});
