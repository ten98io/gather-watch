import { describe, expect, it } from 'vitest';
import {
  CLAIM_TTL_MS,
  INCUMBENT_MARGIN,
  claimScore,
  electFrame,
  pruneClaims,
  rankClaims,
} from '../src/frameElection';
import type { FrameClaim } from '../src/frameElection';
import type { MediaMetrics } from '../src/mediaDriver';

const NOW = 1_700_000_000_000;

function metrics(over: Partial<MediaMetrics> = {}): MediaMetrics {
  return {
    tag: 'video',
    area: 1280 * 720,
    durationSec: 3600,
    readyState: 4,
    paused: false,
    muted: false,
    hasSource: true,
    ...over,
  };
}

function claim(frameId: number, over: Partial<FrameClaim> = {}): FrameClaim {
  return { frameId, url: `https://example.com/#${frameId}`, metrics: metrics(), at: NOW, ...over };
}

describe('electFrame', () => {
  it('elects nothing when no frame claims a player', () => {
    expect(electFrame([], { now: NOW, incumbent: null })).toBeNull();
    expect(
      electFrame([claim(3, { metrics: null })], { now: NOW, incumbent: null }),
    ).toBeNull();
  });

  it('picks the one real player out of N claiming frames', () => {
    const player = claim(7); // 1280×720, playing, 1 h
    const adSlot = claim(2, { metrics: metrics({ area: 300 * 250, durationSec: 15, muted: true }) });
    const heroLoop = claim(1, {
      metrics: metrics({ area: 1600 * 400, durationSec: 8, muted: true, readyState: 4 }),
    });
    expect(electFrame([adSlot, heroLoop, player], { now: NOW, incumbent: null })).toBe(7);
  });

  it('ignores stale claims from frames that unloaded silently', () => {
    const gone = claim(5, { at: NOW - CLAIM_TTL_MS - 1 });
    const live = claim(9, { metrics: metrics({ area: 640 * 360 }) });
    expect(electFrame([gone, live], { now: NOW, incumbent: 5 })).toBe(9);
  });

  it('breaks exact ties towards the outer frame', () => {
    expect(electFrame([claim(4), claim(0), claim(2)], { now: NOW, incumbent: null })).toBe(0);
  });

  it('defends the incumbent against a marginally better challenger', () => {
    const incumbent = claim(3, { metrics: metrics({ area: 1000 * 1000 }) });
    const slightlyBetter = claim(8, { metrics: metrics({ area: 1000 * 1000 * 1.2 }) });
    expect(electFrame([incumbent, slightlyBetter], { now: NOW, incumbent: 3 })).toBe(3);

    const clearlyBetter = claim(8, {
      metrics: metrics({ area: 1000 * 1000 * (INCUMBENT_MARGIN + 0.2) }),
    });
    expect(electFrame([incumbent, clearlyBetter], { now: NOW, incumbent: 3 })).toBe(8);
  });

  it('hands over when the incumbent stops claiming at all', () => {
    const other = claim(6);
    expect(electFrame([other], { now: NOW, incumbent: 1 })).toBe(6);
  });
});

describe('rankClaims / claimScore', () => {
  it('scores a claim by its metrics and drops scoreless ones', () => {
    expect(claimScore(claim(1, { metrics: null }))).toBe(0);
    const ranked = rankClaims([claim(1), claim(2, { metrics: metrics({ area: 0 }) })], NOW);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.claim.frameId).toBe(1);
  });
});

describe('pruneClaims', () => {
  it('removes expired entries and reports whether anything changed', () => {
    const claims = new Map<number, FrameClaim>([
      [1, claim(1)],
      [2, claim(2, { at: NOW - CLAIM_TTL_MS - 1 })],
    ]);
    expect(pruneClaims(claims, NOW)).toBe(true);
    expect([...claims.keys()]).toEqual([1]);
    expect(pruneClaims(claims, NOW)).toBe(false);
  });
});
