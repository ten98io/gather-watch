// @vitest-environment jsdom
/**
 * E18 / C14 — ducking. "Add graceful handling of video/audio track playing
 * while participants are talking on the call."
 *
 * Two promises are asserted here and they pull against each other:
 *
 *   1. While a peer is ACTUALLY SPEAKING the content steps back, and it comes
 *      back when they stop. Not on mic state — on speech.
 *   2. The user's own volume choice survives that, exactly. Ducking is a
 *      multiplier on their setting and can never become an assignment to it,
 *      which is what would turn "quieter for a moment" into "your slider moved
 *      and you did not move it".
 *
 * jsdom because the honest end of this is a real HTMLMediaElement's `volume`:
 * a mixer that computes the right number and an adapter that writes a
 * different one is the bug this file exists to catch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DUCK_ATTACK_MS,
  DUCK_HOLD_MS,
  DUCK_RELEASE_MS,
  DUCK_TARGET,
  DuckEnvelope,
  VolumeMixer,
  attachContentDucking,
} from '@/lib/player/ducking';
import { publishSpeechActive, resetRoomAudio } from '@/lib/player/room-audio';
import { NativeAdapter } from '@/lib/player/native';

describe('DuckEnvelope', () => {
  it('ramps down over the attack and reaches the target, not past it', () => {
    const env = new DuckEnvelope();
    env.setSpeaking(true, 0);
    expect(env.gain()).toBe(1);
    expect(env.step(DUCK_ATTACK_MS / 2)).toBeCloseTo(1 - (1 - DUCK_TARGET) / 2, 5);
    expect(env.step(DUCK_ATTACK_MS)).toBeCloseTo(DUCK_TARGET, 5);
    expect(env.step(DUCK_ATTACK_MS * 10)).toBeCloseTo(DUCK_TARGET, 5);
    expect(env.settled()).toBe(true);
  });

  /**
   * The anti-pumping guarantee. A speaker's inter-word gaps are 50–200 ms and
   * the detector reports every one of them as "stopped"; a bare boolean would
   * swing the film's level several times per sentence.
   */
  it('holds through the gaps inside a sentence instead of pumping', () => {
    const env = new DuckEnvelope();
    let t = 0;
    env.setSpeaking(true, t);
    t += DUCK_ATTACK_MS;
    env.step(t);
    expect(env.gain()).toBeCloseTo(DUCK_TARGET, 5);

    // Four word gaps, each well inside the hold, with speech in between.
    for (let i = 0; i < 4; i += 1) {
      env.setSpeaking(false, t);
      t += 150;
      env.step(t);
      env.setSpeaking(true, t);
      t += 150;
      env.step(t);
      expect(env.gain()).toBeCloseTo(DUCK_TARGET, 5);
    }
  });

  it('releases slowly once the speaker has actually stopped', () => {
    const env = new DuckEnvelope();
    env.setSpeaking(true, 0);
    env.step(DUCK_ATTACK_MS);
    env.setSpeaking(false, DUCK_ATTACK_MS);

    // Still held immediately after the hold opens.
    expect(env.step(DUCK_ATTACK_MS + DUCK_HOLD_MS - 1)).toBeCloseTo(DUCK_TARGET, 5);
    // Halfway through the release, halfway back. The release began the
    // instant the hold expired, which is 1 ms after the step above.
    const half = DUCK_ATTACK_MS + DUCK_HOLD_MS + DUCK_RELEASE_MS / 2;
    const released = (1 - DUCK_TARGET) * ((DUCK_RELEASE_MS / 2 + 1) / DUCK_RELEASE_MS);
    expect(env.step(half)).toBeCloseTo(DUCK_TARGET + released, 5);
    expect(env.step(half + DUCK_RELEASE_MS)).toBe(1);
    expect(env.settled()).toBe(true);
  });
});

describe('VolumeMixer', () => {
  it('keeps the user setting and the duck gain apart, and multiplies them', () => {
    const mixer = new VolumeMixer();
    mixer.setUserVolume(0.4);
    mixer.setDuck(0.35);
    expect(mixer.userVolume()).toBe(0.4);
    expect(mixer.effective()).toBeCloseTo(0.14, 5);
    mixer.setDuck(1);
    expect(mixer.effective()).toBe(0.4);
  });

  it('lets mute win over any duck gain', () => {
    const mixer = new VolumeMixer();
    mixer.setUserVolume(1);
    mixer.setMuted(true);
    mixer.setDuck(1);
    expect(mixer.effective()).toBe(0);
  });
});

describe('ducking a mounted adapter', () => {
  let clock = 0;
  const now = (): number => clock;
  const advance = (ms: number): void => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    resetRoomAudio();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetRoomAudio();
  });

  function mount(): { adapter: NativeAdapter; el: HTMLMediaElement; detach: () => void } {
    const el = document.createElement('video');
    const adapter = new NativeAdapter(el);
    const detach = attachContentDucking(adapter, { now });
    return { adapter, el, detach };
  }

  it('drops the content while a peer speaks and restores it after', () => {
    const { el, detach } = mount();
    expect(el.volume).toBe(1);

    publishSpeechActive(true);
    advance(DUCK_ATTACK_MS + 50);
    expect(el.volume).toBeCloseTo(DUCK_TARGET, 5);

    publishSpeechActive(false);
    advance(DUCK_HOLD_MS + DUCK_RELEASE_MS + 100);
    expect(el.volume).toBe(1);
    detach();
  });

  /**
   * The headline of the ask: "ducking must be a multiplier on their setting,
   * never an assignment that clobbers it."
   */
  it("survives a duck cycle without moving the user's own volume", () => {
    const { adapter, el, detach } = mount();
    adapter.setVolume(0.4);
    expect(el.volume).toBeCloseTo(0.4, 5);

    publishSpeechActive(true);
    advance(DUCK_ATTACK_MS + 50);
    expect(el.volume).toBeCloseTo(0.4 * DUCK_TARGET, 5);

    publishSpeechActive(false);
    advance(DUCK_HOLD_MS + DUCK_RELEASE_MS + 100);
    expect(el.volume).toBeCloseTo(0.4, 5);
    detach();
  });

  it('lets the user move their volume mid-duck and releases to the new value', () => {
    const { adapter, el, detach } = mount();
    adapter.setVolume(0.8);
    publishSpeechActive(true);
    advance(DUCK_ATTACK_MS + 50);

    adapter.setVolume(0.5);
    expect(el.volume).toBeCloseTo(0.5 * DUCK_TARGET, 5);

    publishSpeechActive(false);
    advance(DUCK_HOLD_MS + DUCK_RELEASE_MS + 100);
    expect(el.volume).toBeCloseTo(0.5, 5);
    detach();
  });

  it('never makes a muted player audible', () => {
    const { adapter, el, detach } = mount();
    adapter.setMuted(true);
    publishSpeechActive(true);
    advance(DUCK_ATTACK_MS + 50);
    publishSpeechActive(false);
    advance(DUCK_HOLD_MS + DUCK_RELEASE_MS + 100);
    expect(el.muted).toBe(true);
    detach();
  });

  /**
   * A3/B6 class: a duck whose publisher went away is a film quietly stuck at
   * 35% with nothing on screen to explain it.
   */
  it('restores unity gain when the ducking is detached mid-speech', () => {
    const { adapter, el, detach } = mount();
    adapter.setVolume(0.6);
    publishSpeechActive(true);
    advance(DUCK_ATTACK_MS + 50);
    expect(el.volume).toBeCloseTo(0.6 * DUCK_TARGET, 5);

    detach();
    expect(el.volume).toBeCloseTo(0.6, 5);

    // And it is genuinely unsubscribed: later speech moves nothing.
    publishSpeechActive(false);
    publishSpeechActive(true);
    advance(DUCK_ATTACK_MS + 500);
    expect(el.volume).toBeCloseTo(0.6, 5);
  });
});
