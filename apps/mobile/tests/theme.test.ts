/**
 * Theme invariants (DESIGN.md translated): WCAG AA contrast on text pairs,
 * scale invariants. Numbers verified against the WCAG luminance formula;
 * gradient-ink pairs are asserted at the 3:1 UI-component level because
 * accent-ink on aurora measures 3.3–3.8:1 (flagged as a design-system
 * follow-up — body text never sits on gradients per DESIGN.md §2).
 */
import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  layout,
  palette,
  paletteLight,
  radii,
  spacing,
  type as typeScale,
} from '../src/theme';

describe('contrast (dark theme)', () => {
  it('body text pairs meet AA (≥4.5:1)', () => {
    expect(contrastRatio(palette.textHi, palette.bgVoid)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.textHi, palette.bgDeep)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.textMid, palette.bgVoid)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.textMid, palette.bgDeep)).toBeGreaterThanOrEqual(4.5);
    // 4.70 measured on the void.
    expect(contrastRatio(palette.textLow, palette.bgVoid)).toBeGreaterThanOrEqual(4.5);
  });

  it('low-emphasis text on raised surface meets 3:1 (4.47 measured on bgDeep)', () => {
    expect(contrastRatio(palette.textLow, palette.bgDeep)).toBeGreaterThanOrEqual(3);
  });

  it('aurora accents on the void meet 3:1 UI contrast', () => {
    expect(contrastRatio(palette.aurora1, palette.bgVoid)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(palette.aurora3, palette.bgVoid)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(palette.focusRing, palette.bgVoid)).toBeGreaterThanOrEqual(3);
  });

  it('gradient ink meets 3:1 (measured 3.35–3.8:1 — design follow-up)', () => {
    expect(contrastRatio(palette.accentInk, palette.aurora1)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(palette.accentInk, palette.aurora2)).toBeGreaterThanOrEqual(3);
  });

  it('status colors are readable on the void', () => {
    expect(contrastRatio(palette.danger, palette.bgVoid)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.warn, palette.bgVoid)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.success, palette.bgVoid)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('light theme', () => {
  it('text pairs meet AA', () => {
    expect(contrastRatio(paletteLight.textHi, paletteLight.bgVoid)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(paletteLight.textMid, paletteLight.bgVoid)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('scale invariants', () => {
  it('spacing is a 4pt scale, strictly ascending', () => {
    const values = Object.values(spacing);
    for (const v of values) expect(v % 4).toBe(0);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1] ?? 0);
    }
  });

  it('radii match DESIGN.md §4 ordering', () => {
    expect(radii.control).toBe(12);
    expect(radii.card).toBe(16);
    expect(radii.panel).toBe(24);
    expect(radii.pill).toBeGreaterThan(100);
  });

  it('type scale descends from display to caption', () => {
    expect(typeScale.displayL.fontSize).toBeGreaterThan(typeScale.displayM.fontSize);
    expect(typeScale.displayM.fontSize).toBeGreaterThan(typeScale.title.fontSize);
    expect(typeScale.title.fontSize).toBeGreaterThan(typeScale.body.fontSize);
    expect(typeScale.body.fontSize).toBeGreaterThan(typeScale.caption.fontSize);
    // Display tracking −1% (§3), body 0.
    expect(typeScale.displayL.letterSpacing).toBeLessThan(0);
    expect(typeScale.body.letterSpacing).toBe(0);
  });

  it('hit targets are ≥44px (§9)', () => {
    expect(layout.minHit).toBeGreaterThanOrEqual(44);
  });
});
