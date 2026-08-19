/**
 * `<ArtworkBackdrop>`'s veil, measured — the file its comment points at.
 *
 * The listen composition sets its provider line, its title and its whole
 * up-next list directly on top of a blurred album cover, and a cover is
 * ARBITRARY: it can be pure white and it can be pure black. So the veil is not
 * an effect with a taste value, it is the thing that decides whether the
 * surface a listen room is mostly made of carries text at all.
 *
 * This is `--scrim`'s discipline (packages/design/test/palette.test.ts) applied
 * to the mirror-image problem: a scrim has to suppress the brightest pixel
 * available, and a veil has to survive both extremes at once. The model is what
 * the browser composites — `--bg-void` at `BACKDROP_DIM` over the artwork, then
 * `--text-low` on the result. Blur and `saturate(1.4)` are not modelled because
 * neither moves an extreme: a blurred white is white, and saturating a grey
 * leaves it grey.
 *
 * Deliberately NOT here: the layer bookkeeping (which cross-fade layer is
 * mounted when). That is behaviour; this is legibility.
 */
import { describe, expect, it } from 'vitest';
import type { ThemeName } from '@gather/design';
import {
  THEME_NAMES,
  WCAG_AA_TEXT,
  compositeOver,
  contrastRatio,
  resolveColorToken,
} from '@gather/design';
import { BACKDROP_DIM } from '@/components/ui/artwork-backdrop';

/**
 * The two artwork extremes, as absolute sRGB endpoints and not palette values:
 * a cover is somebody else's image and does not know what theme it landed in.
 */
const ARTWORK_EXTREMES = ['#ffffff', '#000000'] as const;

/** `--text-low` on the veiled backdrop, at whichever extreme is worse. */
function veilFloor(theme: ThemeName, dim: number): number {
  const veil = resolveColorToken(theme, 'bgVoid').hex;
  const low = resolveColorToken(theme, 'textLow').hex;
  return Math.min(
    ...ARTWORK_EXTREMES.map((art) => contrastRatio(low, compositeOver(veil, dim, art))),
  );
}

describe('the artwork backdrop stays a backdrop', () => {
  it.each(THEME_NAMES)('holds --text-low over any cover on %s', (theme) => {
    expect(veilFloor(theme, BACKDROP_DIM)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  /**
   * The failure this replaces, kept as a test so it cannot come back as a
   * "the artwork is too dark, let's show more of it" tweak. At the 0.7 the
   * product shipped, a white cover put dark-theme metadata at 2.49:1 and a
   * black one put light-theme metadata at 2.71:1 — under AA against roughly
   * half the album covers in the world.
   */
  it.each(THEME_NAMES)('fails on %s at the 0.7 veil that shipped', (theme) => {
    expect(veilFloor(theme, 0.7)).toBeLessThan(WCAG_AA_TEXT);
  });

  /** Each theme is bound by the OPPOSITE cover, which is why both are walked:
   *  a veil of the near-black void hides a white cover on dark and a black one
   *  on light, and a one-sided check would have passed at 0.7. */
  it('is bound by the extreme that is furthest from the veil', () => {
    const dark = resolveColorToken('dark', 'bgVoid').hex;
    const light = resolveColorToken('light', 'bgVoid').hex;
    const lowDark = resolveColorToken('dark', 'textLow').hex;
    const lowLight = resolveColorToken('light', 'textLow').hex;
    const on = (veil: string, low: string, art: string): number =>
      contrastRatio(low, compositeOver(veil, BACKDROP_DIM, art));
    expect(on(dark, lowDark, '#ffffff')).toBeLessThan(on(dark, lowDark, '#000000'));
    expect(on(light, lowLight, '#000000')).toBeLessThan(on(light, lowLight, '#ffffff'));
  });
});
