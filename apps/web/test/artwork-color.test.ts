import { describe, expect, it } from 'vitest';
import {
  ACCENT_C_MAX,
  ACCENT_C_MIN,
  ACCENT_L_MAX,
  ACCENT_L_MIN,
  ARTWORK_FALLBACK_ACCENT,
  accentFromPixels,
  artworkGradient,
  clampAccent,
  dominantFromPixels,
  formatOklch,
  rgbToOklch,
  seedHash,
} from '@/lib/artwork-color';

/** Pull the numbers back out of `oklch(L C H)`. */
function parseOklch(css: string): { l: number; c: number; h: number } {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(css);
  if (match === null) throw new Error(`not an oklch() string: ${css}`);
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

/** RGBA byte array of `count` identical pixels. */
function pixels(r: number, g: number, b: number, a = 255, count = 256): number[] {
  return Array.from({ length: count }, () => [r, g, b, a]).flat();
}

describe('seedHash', () => {
  it('is deterministic and unsigned', () => {
    expect(seedHash('Never Gonna Give You Up')).toBe(seedHash('Never Gonna Give You Up'));
    expect(seedHash('')).toBeGreaterThanOrEqual(0);
    for (const seed of ['a', 'b', 'Playin', '🎧 track', 'x'.repeat(300)]) {
      const hash = seedHash(seed);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(2 ** 32);
    }
  });

  it('separates similar strings', () => {
    expect(seedHash('Track 1')).not.toBe(seedHash('Track 2'));
    expect(seedHash('ab')).not.toBe(seedHash('ba'));
  });
});

describe('artworkGradient', () => {
  it('returns the same gradient for the same seed, every call', () => {
    const first = artworkGradient('Blue Monday');
    const second = artworkGradient('Blue Monday');
    expect(second).toEqual(first);
    // Stable across clients too: the value is fixed, not merely self-consistent.
    expect(first.css).toBe(artworkGradient('Blue Monday').css);
  });

  it('produces a 135deg gradient of two oklch stops', () => {
    const { css, from, to } = artworkGradient('YouTube · dQw4w9WgXcQ');
    expect(css).toBe(`linear-gradient(135deg, ${from} 0%, ${to} 100%)`);
    for (const stop of [from, to]) {
      const { l, c, h } = parseOklch(stop);
      expect(l).toBeGreaterThan(0.3);
      expect(l).toBeLessThan(0.6);
      expect(c).toBeLessThan(0.2);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('keeps the two stops within a readable hue distance', () => {
    for (const seed of ['a', 'Shared media', 'Live set 2026', '🎬', 'x'.repeat(120)]) {
      const { from, to } = artworkGradient(seed);
      const delta = Math.abs(parseOklch(to).h - parseOklch(from).h);
      const spread = Math.min(delta, 360 - delta);
      expect(spread).toBeGreaterThanOrEqual(28);
      expect(spread).toBeLessThanOrEqual(92);
    }
  });

  it('gives different seeds different gradients', () => {
    const seen = new Set(
      ['Track 1', 'Track 2', 'Track 3', 'Album art', 'Shared media'].map(
        (s) => artworkGradient(s).css,
      ),
    );
    expect(seen.size).toBe(5);
  });

  it('never renders an empty gradient for an empty seed', () => {
    const { css } = artworkGradient('');
    expect(css).toBe(artworkGradient('playin').css);
    expect(css).toContain('oklch(');
  });
});

describe('rgbToOklch', () => {
  it('matches the reference conversion for the sRGB primaries', () => {
    expect(rgbToOklch({ r: 255, g: 255, b: 255 }).l).toBeCloseTo(1, 2);
    expect(rgbToOklch({ r: 0, g: 0, b: 0 }).l).toBeCloseTo(0, 3);
    const red = rgbToOklch({ r: 255, g: 0, b: 0 });
    expect(red.l).toBeCloseTo(0.628, 2);
    expect(red.c).toBeCloseTo(0.258, 2);
    expect(red.h).toBeCloseTo(29.2, 0);
    const blue = rgbToOklch({ r: 0, g: 0, b: 255 });
    expect(blue.h).toBeCloseTo(264.1, 0);
  });

  it('reports zero chroma for greys', () => {
    expect(rgbToOklch({ r: 128, g: 128, b: 128 }).c).toBeLessThan(0.001);
  });
});

describe('clampAccent', () => {
  const inBand = (css: string): void => {
    const { l, c, h } = parseOklch(css);
    expect(l).toBeGreaterThanOrEqual(ACCENT_L_MIN);
    expect(l).toBeLessThanOrEqual(ACCENT_L_MAX);
    expect(c).toBeGreaterThanOrEqual(ACCENT_C_MIN);
    expect(c).toBeLessThanOrEqual(ACCENT_C_MAX);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  };

  it('pulls too-dark, too-bright and too-vivid colours into the AA band', () => {
    // Near-black navy, blown-out yellow, neon magenta, muted teal.
    for (const rgb of [
      { r: 8, g: 10, b: 60 },
      { r: 255, g: 250, b: 120 },
      { r: 255, g: 0, b: 200 },
      { r: 40, g: 120, b: 110 },
    ]) {
      const css = clampAccent(rgbToOklch(rgb));
      expect(css).not.toBeNull();
      inBand(css as string);
    }
  });

  it('keeps a colour that is already in band untouched', () => {
    const source = { l: 0.63, c: 0.12, h: 210 };
    expect(clampAccent(source)).toBe(formatOklch(source));
  });

  it('refuses greys rather than inventing a hue', () => {
    expect(clampAccent(rgbToOklch({ r: 128, g: 128, b: 128 }))).toBeNull();
    expect(clampAccent(rgbToOklch({ r: 250, g: 250, b: 252 }))).toBeNull();
    expect(clampAccent({ l: Number.NaN, c: 0.1, h: 10 })).toBeNull();
  });

  it('normalises hue into 0..360', () => {
    expect(parseOklch(clampAccent({ l: 0.6, c: 0.1, h: -30 }) as string).h).toBeCloseTo(330, 1);
    expect(parseOklch(clampAccent({ l: 0.6, c: 0.1, h: 400 }) as string).h).toBeCloseTo(40, 1);
  });

  it('is deterministic to three decimals', () => {
    const source = rgbToOklch({ r: 17, g: 190, b: 240 });
    expect(clampAccent(source)).toBe(clampAccent(source));
  });
});

describe('dominantFromPixels', () => {
  it('returns the modal colour of a flat image', () => {
    expect(dominantFromPixels(pixels(200, 40, 60))).toEqual({ r: 200, g: 40, b: 60 });
  });

  it('prefers the saturated area over a larger grey mass', () => {
    const grey = pixels(120, 120, 122, 255, 200);
    const vivid = pixels(220, 30, 40, 255, 56);
    const dominant = dominantFromPixels([...grey, ...vivid]);
    expect(dominant).not.toBeNull();
    expect((dominant as { r: number }).r).toBeGreaterThan(180);
  });

  it('ignores letterboxing, blown-out white and transparent pixels', () => {
    expect(dominantFromPixels(pixels(0, 0, 0))).toBeNull();
    expect(dominantFromPixels(pixels(255, 255, 255))).toBeNull();
    expect(dominantFromPixels(pixels(200, 40, 60, 0))).toBeNull();
    const framed = [...pixels(0, 0, 0, 255, 200), ...pixels(40, 90, 200, 255, 56)];
    expect(dominantFromPixels(framed)).toEqual({ r: 40, g: 90, b: 200 });
  });

  it('tolerates empty and truncated buffers', () => {
    expect(dominantFromPixels([])).toBeNull();
    expect(dominantFromPixels([200, 40, 60])).toBeNull();
  });
});

describe('accentFromPixels', () => {
  it('clamps a sampled colour into the band', () => {
    const css = accentFromPixels(pixels(12, 14, 90));
    expect(css).not.toBe(ARTWORK_FALLBACK_ACCENT);
    const { l, c } = parseOklch(css);
    expect(l).toBeGreaterThanOrEqual(ACCENT_L_MIN);
    expect(l).toBeLessThanOrEqual(ACCENT_L_MAX);
    expect(c).toBeGreaterThanOrEqual(ACCENT_C_MIN);
    expect(c).toBeLessThanOrEqual(ACCENT_C_MAX);
  });

  it('falls back to the aurora accent for grey, empty and unusable artwork', () => {
    expect(accentFromPixels(pixels(130, 130, 130))).toBe(ARTWORK_FALLBACK_ACCENT);
    expect(accentFromPixels([])).toBe(ARTWORK_FALLBACK_ACCENT);
    expect(accentFromPixels(pixels(0, 0, 0))).toBe(ARTWORK_FALLBACK_ACCENT);
  });
});
