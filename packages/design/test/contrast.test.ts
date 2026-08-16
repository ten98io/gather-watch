/**
 * The contrast utilities themselves. The token guard in tokens.test.ts is only
 * as good as these, so they are checked against WCAG's own reference points.
 */
import { describe, expect, it } from 'vitest';
import {
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NON_TEXT,
  WCAG_AA_TEXT,
  compositeOver,
  contrastRatio,
  relativeLuminance,
} from '../src/contrast';

describe('relativeLuminance', () => {
  it('matches the WCAG endpoints', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 10);
  });

  it('is monotonic along the grey ramp', () => {
    let previous = -1;
    for (let v = 0; v <= 255; v += 15) {
      const hex = `#${v.toString(16).padStart(2, '0').repeat(3)}`;
      const luminance = relativeLuminance(hex);
      expect(luminance).toBeGreaterThan(previous);
      previous = luminance;
    }
  });

  it('weights green above red above blue', () => {
    expect(relativeLuminance('#00ff00')).toBeGreaterThan(relativeLuminance('#ff0000'));
    expect(relativeLuminance('#ff0000')).toBeGreaterThan(relativeLuminance('#0000ff'));
  });

  it('rejects anything that is not #rrggbb', () => {
    expect(() => relativeLuminance('white')).toThrow(/not a #rrggbb color/);
  });
});

describe('contrastRatio', () => {
  it('spans 1 to 21', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#808080', '#808080')).toBeCloseTo(1, 10);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#07060f', '#8d8e9b')).toBeCloseTo(
      contrastRatio('#8d8e9b', '#07060f'),
      10,
    );
  });

  it('agrees with the canonical 4.5:1 boundary grey on white', () => {
    // #767676 is the darkest grey that still passes AA body text on white, and
    // #777777 is the first that does not. Any error in the transfer function
    // moves this boundary.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(WCAG_AA_TEXT);
  });

  it('states its thresholds', () => {
    expect(WCAG_AA_TEXT).toBe(4.5);
    expect(WCAG_AA_LARGE_TEXT).toBe(3);
    expect(WCAG_AA_NON_TEXT).toBe(3);
  });
});

describe('compositeOver', () => {
  it('returns the base at alpha 0 and the overlay at alpha 1', () => {
    expect(compositeOver('#ffffff', 0, '#07060f')).toBe('#07060f');
    expect(compositeOver('#ffffff', 1, '#07060f')).toBe('#ffffff');
  });

  it('lands halfway at alpha 0.5', () => {
    expect(compositeOver('#ffffff', 0.5, '#000000')).toBe('#808080');
  });

  it('clamps alpha outside [0,1]', () => {
    expect(compositeOver('#ffffff', 5, '#000000')).toBe('#ffffff');
    expect(compositeOver('#ffffff', -2, '#000000')).toBe('#000000');
  });

  it('lightens a dark ground, which is what a white glass wash does', () => {
    const glass = compositeOver('#ffffff', 0.05, '#07060f');
    expect(relativeLuminance(glass)).toBeGreaterThan(relativeLuminance('#07060f'));
  });
});
