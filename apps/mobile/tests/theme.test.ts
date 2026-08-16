/**
 * Theme invariants for the mobile adapter.
 *
 * These assert the two things that can actually break now that the values come
 * from @gather/design: that mobile really is reading the package (not a copy
 * that drifted again), and that the surface ladder mobile just gained holds
 * contrast at every step. The colour maths itself is the package's test.
 *
 * The old version of this file measured only text-on-bgVoid/bgDeep. That is
 * precisely why mobile shipped `textLow` at oklch 0.58 for months: the pair it
 * failed on — the raised surface — was not a pair mobile had.
 */
import { describe, expect, it } from 'vitest';
import {
  SURFACE_LADDER,
  TEXT_TOKENS,
  WCAG_AA_NON_TEXT,
  WCAG_AA_TEXT,
  effectiveSurfaces,
  resolveColorToken,
  rnThemes,
} from '@gather/design';
import type { ColorTokenName, ThemeName } from '@gather/design';
import {
  auroraGradient,
  contrastRatio,
  glow,
  layout,
  motion,
  palette,
  paletteLight,
  radii,
  relativeLuminance,
  spacing,
  theme,
  type as typeScale,
} from '../src/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];

describe('the tokens come from @gather/design', () => {
  it('palette is the package palette, not a copy', () => {
    expect(palette).toBe(rnThemes.dark.palette);
    expect(paletteLight).toBe(rnThemes.light.palette);
    expect(auroraGradient).toBe(rnThemes.dark.auroraGradient);
    expect(glow).toBe(rnThemes.dark.glow);
  });

  it('carries the accessibility fix mobile missed (textLow 0.58 → 0.65)', () => {
    // The stale hand-converted value. Kept here as the regression it was, not
    // as a token: it fails AA on the raised surface the ladder now includes.
    const STALE_TEXT_LOW = '#797986';
    expect(palette.textLow).not.toBe(STALE_TEXT_LOW);
    expect(palette.textLow).toBe('#8d8e9b');
    const surface3 = resolveColorToken('dark', 'surface3').hex;
    expect(contrastRatio(STALE_TEXT_LOW, surface3)).toBeLessThan(WCAG_AA_TEXT);
    expect(contrastRatio(palette.textLow, surface3)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it('scales are the package scales', () => {
    expect(radii).toBe(rnThemes.dark.radii);
    expect(spacing).toBe(rnThemes.dark.spacing);
    expect(motion).toBe(rnThemes.dark.motion);
    expect(layout).toBe(rnThemes.dark.layout);
  });

  it('theme bundles the same objects it exports', () => {
    expect(theme.dark).toBe(palette);
    expect(theme.light).toBe(paletteLight);
    expect(theme.type).toBe(typeScale);
  });
});

describe('surface ladder', () => {
  it('mobile has the ladder web has', () => {
    for (const step of SURFACE_LADDER) {
      expect(palette[step]).toMatch(/^#[0-9a-f]{6}$/);
      expect(paletteLight[step]).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Opaque steps, not the translucent washes mobile used to fake them with.
    expect(palette.surfaceGlass).toMatch(/^rgba\(/);
    expect(palette.surface1).not.toBe(palette.surface2);
    expect(palette.surface2).not.toBe(palette.surface3);
  });

  it('dark ladder ascends in luminance, light ladder is a paper ground', () => {
    const l = (name: ColorTokenName): number =>
      relativeLuminance(resolveColorToken('dark', name).hex);
    expect(l('surface1')).toBeGreaterThan(l('surface0'));
    expect(l('surface2')).toBeGreaterThan(l('surface1'));
    expect(l('surface3')).toBeGreaterThan(l('surface2'));
    // Light inverts: the card lifts toward white, hover/active step back down.
    const lightL = (name: ColorTokenName): number =>
      relativeLuminance(resolveColorToken('light', name).hex);
    expect(lightL('surface1')).toBeGreaterThan(lightL('surface0'));
    expect(lightL('surface3')).toBeLessThan(lightL('surface2'));
  });
});

describe('contrast', () => {
  for (const name of THEMES) {
    it(`${name}: every text token meets AA on every surface it can land on`, () => {
      const p = name === 'dark' ? palette : paletteLight;
      for (const token of TEXT_TOKENS) {
        for (const surface of effectiveSurfaces(name)) {
          const ratio = contrastRatio(p[token], surface.hex);
          expect(
            ratio,
            `${name}.${token} on ${surface.label} = ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
        }
      }
    });
  }

  it('aurora accents and the focus ring meet 3:1 UI contrast on the void', () => {
    expect(contrastRatio(palette.aurora1, palette.bgVoid)).toBeGreaterThanOrEqual(
      WCAG_AA_NON_TEXT,
    );
    expect(contrastRatio(palette.aurora3, palette.bgVoid)).toBeGreaterThanOrEqual(
      WCAG_AA_NON_TEXT,
    );
    expect(contrastRatio(palette.focusRing, palette.bgVoid)).toBeGreaterThanOrEqual(
      WCAG_AA_NON_TEXT,
    );
  });

  it('gradient ink meets 3:1 (measured 3.35–3.80:1 — design follow-up)', () => {
    // Body text never sits on a gradient (DESIGN.md §2), so the bar is the
    // non-text one. Recorded rather than raised: lifting it changes the brand.
    expect(contrastRatio(palette.accentInk, palette.aurora1)).toBeGreaterThanOrEqual(
      WCAG_AA_NON_TEXT,
    );
    expect(contrastRatio(palette.accentInk, palette.aurora2)).toBeGreaterThanOrEqual(
      WCAG_AA_NON_TEXT,
    );
  });

  it('status colours are readable on the void', () => {
    expect(contrastRatio(palette.danger, palette.bgVoid)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    expect(contrastRatio(palette.warn, palette.bgVoid)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    expect(contrastRatio(palette.success, palette.bgVoid)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
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

  it('radii match DESIGN.md §4 — card 16→12 and panel 24→20 came from web', () => {
    expect(radii.sm).toBe(8);
    expect(radii.control).toBe(12);
    expect(radii.card).toBe(12);
    expect(radii.panel).toBe(20);
    expect(radii.pill).toBeGreaterThan(100);
  });

  it('type scale descends from hero to caption', () => {
    expect(typeScale.display.fontSize).toBeGreaterThan(typeScale.hero.fontSize);
    expect(typeScale.hero.fontSize).toBeGreaterThan(typeScale.title.fontSize);
    expect(typeScale.title.fontSize).toBeGreaterThan(typeScale.body.fontSize);
    expect(typeScale.body.fontSize).toBeGreaterThan(typeScale.label.fontSize);
    expect(typeScale.label.fontSize).toBeGreaterThan(typeScale.caption.fontSize);
    // Display tracking negative (§3), body 0.
    expect(typeScale.display.letterSpacing).toBeLessThan(0);
    expect(typeScale.body.letterSpacing).toBe(0);
    // §3 uppercases the caption and nothing else.
    expect(typeScale.caption.textTransform).toBe('uppercase');
    expect(typeScale.label).not.toHaveProperty('textTransform');
  });

  it('the two locally-composed steps stay pinned to the package body step', () => {
    expect(typeScale.bodyStrong.fontSize).toBe(typeScale.body.fontSize);
    expect(typeScale.bodyStrong.lineHeight).toBe(typeScale.body.lineHeight);
    expect(typeScale.bodyStrong.fontWeight).toBe('600');
    expect(typeScale.mono.fontSize).toBe(typeScale.body.fontSize);
    expect(typeScale.mono.fontFamily).toBe('JetBrains Mono');
  });

  it('hit targets are ≥44px (§9)', () => {
    expect(layout.tap).toBeGreaterThanOrEqual(44);
  });
});
