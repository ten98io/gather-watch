/**
 * The guard the design system exists for: every text token, on every surface
 * it can land on, in every theme.
 *
 * This lives HERE and not in a consumer on purpose. The palette shipped with
 * `textLow` at oklch 0.58 — measurably 3.53:1 on `surface3`, a WCAG AA failure
 * — for as long as it did precisely because the maths lived in one place
 * (mobile), the values in another (web), and nothing ran the one over the
 * other. A source of truth whose correctness is enforced only by whoever
 * happens to consume it is not a source of truth.
 *
 * Deliberately NOT asserting exact hex: the token values are allowed to be
 * tuned. What is not allowed is tuning one below the contrast it must hold.
 */
import { describe, expect, it } from 'vitest';

import {
  COLOR_TOKEN_NAMES,
  SURFACE_LADDER,
  TEXT_TOKENS,
  THEME_NAMES,
  WCAG_AA_TEXT,
  contrastRatio,
  effectiveSurfaces,
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
