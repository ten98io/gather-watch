/**
 * WCAG contrast maths and the thresholds this design system holds itself to.
 *
 * Owns: relative luminance, contrast ratio, alpha compositing of a translucent
 * surface onto an opaque one, and the named minimums.
 *
 * Deliberately NOT: which pairs must be checked (that is src/tokens.ts's
 * surface ladder plus the guard test), and nothing about OKLCH — these are
 * sRGB-space formulas because WCAG 2.x is defined in sRGB.
 *
 * Moved here from apps/mobile/src/theme.ts: the utilities were right, the
 * location was wrong. Mobile had the maths and still shipped a token that
 * failed, because nothing ran the maths over the whole ladder.
 */

import { hexToRgb, rgbToHex } from './oklch';

/** WCAG 2.1 AA, normal-size text. */
export const WCAG_AA_TEXT = 4.5;

/**
 * WCAG 2.1 AA, large text — ≥18pt, or ≥14pt bold (≈24px / ≈18.7px bold).
 *
 * Nothing in this system's text tokens is allowed to use it. The type ramp
 * (DESIGN.md §3) puts metadata at `text-label` 13px/500 and `text-caption`
 * 11px/500, both of which are normal-size text by the definition above, so
 * `--text-low` is held to WCAG_AA_TEXT like every other text token. The
 * constant exists so the bar is named rather than assumed.
 */
export const WCAG_AA_LARGE_TEXT = 3;

/**
 * WCAG 2.1 AA 1.4.11, non-text contrast: UI component boundaries, focus
 * indicators, and graphics required to understand content. Status dots, the
 * focus ring and the accent edge are held here.
 */
export const WCAG_AA_NON_TEXT = 3;

/**
 * Relative luminance of a `#rrggbb` colour, per WCAG 2.x.
 *
 * The 0.03928 threshold is the one written in the WCAG text (the sRGB spec
 * says 0.04045); at 8-bit input the two are indistinguishable, because no
 * channel value lands between them. Kept as WCAG writes it.
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two `#rrggbb` colours, 1–21. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Composite a translucent colour onto an opaque one, the way a compositor
 * does: source-over in gamma-encoded sRGB, not in a linear or perceptual
 * space. This is what makes a glass surface checkable — `--surface-glass` is
 * white at 5%, and the thing text actually sits on is that mixed onto whatever
 * is behind it.
 *
 * `alpha` is 0–1 and is clamped. At 0 the base is returned unchanged, at 1 the
 * overlay is.
 */
export function compositeOver(overlayHex: string, alpha: number, baseHex: string): string {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  const over = hexToRgb(overlayHex);
  const base = hexToRgb(baseHex);
  return rgbToHex({
    r: over.r * a + base.r * (1 - a),
    g: over.g * a + base.g * (1 - a),
    b: over.b * a + base.b * (1 - a),
  });
}
