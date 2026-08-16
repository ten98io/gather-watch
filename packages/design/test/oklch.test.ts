/**
 * Conversion correctness. If these pass, every generated hex in the product is
 * trustworthy; if they fail, nothing downstream is worth checking.
 *
 * The reference values are the published OKLCH coordinates of the sRGB
 * primaries, not numbers this implementation produced.
 */
import { describe, expect, it } from 'vitest';
import {
  SRGB_GAMUT_EPSILON,
  hexToOklch,
  hexToRgb,
  linearSrgbToSrgb,
  oklchToHex,
  oklchToLinearSrgb,
  oklchToOklab,
  oklchToSrgb,
  rgbToHex,
  srgbToLinearSrgb,
} from '../src/oklch';

describe('oklch → srgb, known values', () => {
  it('renders the achromatic endpoints exactly', () => {
    expect(oklchToHex({ l: 1, c: 0, h: 0 })).toBe('#ffffff');
    expect(oklchToHex({ l: 0, c: 0, h: 0 })).toBe('#000000');
  });

  it('round-trips the mid-grey ramp with no drift', () => {
    // Every step is a colour sRGB can name exactly, so a correct implementation
    // returns the identical byte. A wrong transfer function shows up here first.
    for (const hex of ['#000000', '#202020', '#404040', '#808080', '#c0c0c0', '#ffffff']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });

  it('round-trips every 8-bit grey', () => {
    for (let v = 0; v <= 255; v += 1) {
      const hex = rgbToHex({ r: v, g: v, b: v });
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });

  it('matches the published OKLCH coordinates of the sRGB primaries', () => {
    const red = hexToOklch('#ff0000');
    expect(red.l).toBeCloseTo(0.62796, 4);
    expect(red.c).toBeCloseTo(0.25768, 4);
    expect(red.h).toBeCloseTo(29.234, 2);

    const green = hexToOklch('#00ff00');
    expect(green.l).toBeCloseTo(0.86644, 4);
    expect(green.c).toBeCloseTo(0.29483, 4);
    expect(green.h).toBeCloseTo(142.495, 2);

    const blue = hexToOklch('#0000ff');
    expect(blue.l).toBeCloseTo(0.45201, 4);
    expect(blue.c).toBeCloseTo(0.31321, 4);
    expect(blue.h).toBeCloseTo(264.052, 2);
  });

  it('round-trips the primaries and secondaries back to their bytes', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });

  it('reports in-gamut colours as in-gamut, with chroma untouched', () => {
    const result = oklchToSrgb({ l: 0.13, c: 0.02, h: 285 });
    expect(result.inGamut).toBe(true);
    expect(result.chroma).toBe(0.02);
    expect(result.hex).toBe('#07060f');
  });
});

describe('gamut handling is honest', () => {
  it('reduces chroma and says so, instead of emitting garbage', () => {
    // --focus-ring: oklch(0.72 0.20 295) names a violet sRGB cannot show.
    const result = oklchToSrgb({ l: 0.72, c: 0.2, h: 295 });
    expect(result.inGamut).toBe(false);
    expect(result.chroma).toBeLessThan(0.2);
    expect(result.chroma).toBeCloseTo(0.1631, 3);
    expect(result.hex).toBe('#ad8dff');
  });

  it('preserves lightness and hue while reducing chroma', () => {
    // The whole point of chroma reduction over channel clamping. Compare with
    // the naive result below.
    const back = hexToOklch(oklchToHex({ l: 0.72, c: 0.2, h: 295 }));
    expect(back.l).toBeCloseTo(0.72, 2);
    expect(back.h).toBeCloseTo(295, 0);
  });

  it('is measurably better than the channel clamping it replaces', () => {
    // #b085ff is what apps/mobile had hand-written for this token. It is a
    // different colour: 3 degrees of hue and a step of lightness away.
    const naive = hexToOklch('#b085ff');
    expect(naive.h).toBeCloseTo(298.06, 1);
    expect(Math.abs(naive.h - 295)).toBeGreaterThan(2.5);
    expect(Math.abs(naive.l - 0.72)).toBeGreaterThan(
      Math.abs(hexToOklch('#ad8dff').l - 0.72),
    );
  });

  it('clamps lightness outside [0,1] rather than inventing a colour', () => {
    expect(oklchToHex({ l: 1.4, c: 0, h: 0 })).toBe('#ffffff');
    expect(oklchToHex({ l: -0.3, c: 0.1, h: 200 })).toBe('#000000');
  });

  it('leaves a grey in gamut at every lightness, so bisection always terminates', () => {
    for (let l = 0; l <= 1; l += 0.05) {
      const linear = oklchToLinearSrgb({ l, c: 0, h: 0 });
      for (const channel of [linear.r, linear.g, linear.b]) {
        expect(channel).toBeGreaterThanOrEqual(-SRGB_GAMUT_EPSILON);
        expect(channel).toBeLessThanOrEqual(1 + SRGB_GAMUT_EPSILON);
      }
    }
  });
});

describe('component functions', () => {
  it('converts polar to cartesian on the expected axes', () => {
    const lab = oklchToOklab({ l: 0.5, c: 0.1, h: 0 });
    expect(lab.a).toBeCloseTo(0.1, 10);
    expect(lab.b).toBeCloseTo(0, 10);
    const quarter = oklchToOklab({ l: 0.5, c: 0.1, h: 90 });
    expect(quarter.a).toBeCloseTo(0, 10);
    expect(quarter.b).toBeCloseTo(0.1, 10);
  });

  it('has inverse transfer functions', () => {
    for (const v of [0, 0.001, 0.0031308, 0.04045, 0.2, 0.5, 1]) {
      expect(srgbToLinearSrgb(linearSrgbToSrgb(v))).toBeCloseTo(v, 10);
    }
  });

  it('normalises hue into [0, 360)', () => {
    expect(hexToOklch('#0000ff').h).toBeGreaterThanOrEqual(0);
    expect(hexToOklch('#0000ff').h).toBeLessThan(360);
    expect(hexToOklch('#ff0000').h).toBeGreaterThanOrEqual(0);
  });
});

describe('hex parsing', () => {
  it('parses and formats round-trip', () => {
    expect(hexToRgb('#07060f')).toEqual({ r: 7, g: 6, b: 15 });
    expect(rgbToHex({ r: 7, g: 6, b: 15 })).toBe('#07060f');
  });

  it('accepts upper case and normalises to lower', () => {
    expect(rgbToHex(hexToRgb('#AD8DFF'))).toBe('#ad8dff');
  });

  it('throws rather than guessing at malformed input', () => {
    expect(() => hexToRgb('#fff')).toThrow(/not a #rrggbb color/);
    expect(() => hexToRgb('ad8dff')).toThrow(/not a #rrggbb color/);
    expect(() => hexToRgb('')).toThrow(/not a #rrggbb color/);
  });

  it('clamps and rounds out-of-range channels when formatting', () => {
    expect(rgbToHex({ r: -5, g: 300, b: 127.6 })).toBe('#00ff80');
  });
});
