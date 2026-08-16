/**
 * The guard the design system exists for: every text token, on every surface
 * it can land on, and every fill, under the ink that lands on IT, in every
 * theme.
 *
 * This lives HERE and not in a consumer on purpose. The palette shipped with
 * `textLow` at oklch 0.58 — measurably 3.53:1 on `surface3`, a WCAG AA failure
 * — for as long as it did precisely because the maths lived in one place
 * (mobile), the values in another (web), and nothing ran the one over the
 * other. A source of truth whose correctness is enforced only by whoever
 * happens to consume it is not a source of truth.
 *
 * The same hole, a second time: the first version of this file walked the text
 * tokens over the SURFACE ladder and stopped there. Nothing checked an ink
 * over a FILL, so `accentInk` shipped at 3.80:1 on `accent` and 1.67:1 on
 * `warn` — every filled button label in the dark theme, under AA. A guard that
 * covers one axis is not a guard, it is a sample.
 *
 * Deliberately NOT asserting exact hex: the token values are allowed to be
 * tuned. What is not allowed is tuning one below the contrast it must hold.
 */
import { describe, expect, it } from 'vitest';

import {
  COLOR_TOKEN_NAMES,
  FILL_TOKENS,
  INKS,
  SURFACE_LADDER,
  TEXT_TOKENS,
  THEME_NAMES,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_TEXT,
  contrastRatio,
  effectiveSurfaces,
  inkForFill,
  inkOn,
  resolveColorToken,
} from '../src/index';

describe('every text token is readable on every surface', () => {
  for (const theme of THEME_NAMES) {
    for (const token of TEXT_TOKENS) {
      it(`${theme}: ${token} holds ${WCAG_AA_TEXT}:1 across the ladder`, () => {
        const text = resolveColorToken(theme, token);
        const failures: string[] = [];
        for (const surface of effectiveSurfaces(theme)) {
          const ratio = contrastRatio(text.hex, surface.hex);
          if (ratio < WCAG_AA_TEXT) {
            failures.push(`${surface.label} ${ratio.toFixed(2)}:1`);
          }
        }
        // The message names the pair, so a failure says which surface to fix
        // rather than only that something is wrong.
        expect(failures, `${token} (${text.hex}) fails on: ${failures.join(', ')}`).toEqual([]);
      });
    }
  }
});

describe('every filled control is readable under the ink it gets', () => {
  for (const theme of THEME_NAMES) {
    for (const fill of FILL_TOKENS) {
      it(`${theme}: ${fill} holds ${WCAG_AA_TEXT}:1 under inkOn()`, () => {
        const bg = resolveColorToken(theme, fill).hex;
        const ink = inkOn(theme, fill);
        const ratio = contrastRatio(ink.hex, bg);
        // The message carries the measurement, so a regression says how far the
        // pair fell and which ink was on it, not only that something is wrong.
        expect(
          ratio,
          `${ink.name} (${ink.hex}) on ${fill} (${bg}) is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
      });
    }
  }

  it('always picks the better of the two inks, not merely a passing one', () => {
    for (const theme of THEME_NAMES) {
      for (const fill of FILL_TOKENS) {
        const bg = resolveColorToken(theme, fill).hex;
        const best = Math.max(
          contrastRatio(INKS.inkBlack.hex, bg),
          contrastRatio(INKS.inkWhite.hex, bg),
        );
        expect(contrastRatio(inkOn(theme, fill).hex, bg), `${theme}.${fill}`).toBe(best);
      }
    }
  });

  it('uses both inks, so neither theme is being served a single constant', () => {
    // The failure mode this whole mechanism replaces is ONE ink for everything.
    // An implementation that always answers the same way would satisfy every
    // ratio assertion above in dark and still be the original bug.
    const chosen = THEME_NAMES.flatMap((theme) =>
      FILL_TOKENS.map((fill) => `${theme}.${fill}=${inkOn(theme, fill).name}`),
    );
    const names = new Set(chosen.map((entry) => entry.split('=')[1]));
    expect([...names].sort(), chosen.join(' ')).toEqual(['inkBlack', 'inkWhite']);
  });

  it('answers from the fill colour alone, which a rebound --accent depends on', () => {
    // A listen room sets --accent to the track artwork, so the ink has to be a
    // function of the colour that landed and of nothing else — `inkOn` is only
    // `inkForFill` with the token already resolved.
    for (const theme of THEME_NAMES) {
      for (const fill of FILL_TOKENS) {
        expect(inkOn(theme, fill), `${theme}.${fill}`).toBe(
          inkForFill(resolveColorToken(theme, fill).hex),
        );
      }
    }
    // Absolute, and deliberately not a token: the sRGB endpoints are the only
    // two values in the system that no palette tuning can move.
    expect(INKS.inkBlack.hex).toBe('#000000');
    expect(INKS.inkWhite.hex).toBe('#ffffff');
  });

  it('records why --accent-ink could not stay the answer', () => {
    // Kept as an assertion rather than a comment: --accent-ink is what
    // DESIGN.md §8 puts on the primary button, so reaching for it again is the
    // obvious "simplification". It fails on EVERY dark fill.
    const failures: string[] = [];
    for (const fill of FILL_TOKENS) {
      const ratio = contrastRatio(
        resolveColorToken('dark', 'accentInk').hex,
        resolveColorToken('dark', fill).hex,
      );
      if (ratio < WCAG_AA_TEXT) failures.push(`${fill} ${ratio.toFixed(2)}:1`);
    }
    expect(failures, `dark fills --accent-ink still clears: ${failures.join(', ')}`).toHaveLength(
      FILL_TOKENS.length,
    );
  });

  it('the 135° aurora gradient takes one ink across all three of its stops', () => {
    // The primary button's fill is a gradient (DESIGN.md §2), so its label
    // crosses aurora1 → aurora2 → aurora3 and one ink has to serve all three.
    // Dark clears AA. LIGHT DOES NOT and is recorded here rather than hidden:
    // white measures 2.73:1 on light `aurora3` and black 3.96:1 on light
    // `aurora1`, so the best single ink for the light gradient is 3.96:1 — over
    // the 3:1 non-text bar, under the 4.5:1 text bar. Fixing it means moving
    // light `aurora1`/`aurora3`, which is a palette decision, not a test one.
    const floor = (theme: 'dark' | 'light', ink: string): number =>
      Math.min(
        ...(['aurora1', 'aurora2', 'aurora3'] as const).map((stop) =>
          contrastRatio(ink, resolveColorToken(theme, stop).hex),
        ),
      );
    const best = (theme: 'dark' | 'light'): number =>
      Math.max(floor(theme, INKS.inkBlack.hex), floor(theme, INKS.inkWhite.hex));

    expect(best('dark'), `dark gradient floor ${best('dark').toFixed(2)}:1`).toBeGreaterThanOrEqual(
      WCAG_AA_TEXT,
    );
    expect(
      best('light'),
      `light gradient floor ${best('light').toFixed(2)}:1 — below WCAG_AA_TEXT, see comment`,
    ).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
  });
});

describe('the palette itself is intact', () => {
  it('resolves every declared colour token in both themes', () => {
    for (const theme of THEME_NAMES) {
      for (const name of COLOR_TOKEN_NAMES) {
        const resolved = resolveColorToken(theme, name);
        expect(resolved, `${theme}.${name}`).toBeDefined();
        expect(resolved.hex, `${theme}.${name}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('offers the whole surface ladder in both themes', () => {
    for (const theme of THEME_NAMES) {
      const labels = effectiveSurfaces(theme).map((s) => s.token);
      for (const rung of SURFACE_LADDER) expect(labels, theme).toContain(rung);
    }
  });
});
