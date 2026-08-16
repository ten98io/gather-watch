/**
 * Gather mobile theme — the React Native adapter over @gather/design.
 *
 * Owns: the names apps/mobile imports (`palette`, `paletteLight`, `type`,
 * `radii`, `spacing`, `motion`, `layout`, `auroraGradient`, `glow`, `theme`),
 * and the two type steps the design package deliberately does not carry
 * (`type.bodyStrong`, `type.mono`) because they are RN-shaped, not system-level.
 *
 * Deliberately NOT: any colour, radius, spacing, duration or type value. Every
 * number below is imported from @gather/design, which authors them once in
 * OKLCH and renders them per-platform. A hex literal in this file is the exact
 * bug that let mobile ship `--text-low` at oklch 0.58 long after web raised it
 * to 0.65 for contrast — there is no longer anywhere for that bug to live.
 *
 * Rules from DESIGN.md that this file cannot enforce, only supply:
 *  - gradients only from the three aurora hues (aurora1 → aurora2 → aurora3,
 *    135°) and only for primary actions / brand moments;
 *  - body text never sits on a gradient;
 *  - elevation is glow, not shadow — use `glow`, never a `shadowOffset`;
 *  - hit targets ≥ 44px: `layout.tap` (was `layout.minHit`; the design system
 *    reconciled mobile's name with web's).
 */

import type { RnTypeStep } from '@gather/design';
import { fontFamily, layout, motion, radii, rnThemes, spacing } from '@gather/design';

/**
 * WCAG maths used to live in this file. It now lives in @gather/design, where a
 * guard test walks the whole surface ladder — mobile had the maths and still
 * shipped a failing token, because nothing ran it over every pair.
 */
export { contrastRatio, relativeLuminance } from '@gather/design';

export { layout, motion, radii, spacing };

/**
 * The dark palette — primary theme. Now includes the opaque elevation ladder
 * (`surface0`…`surface3`, `hairline`) that mobile never had: it faked elevation
 * with the translucent `surfaceGlass`/`surfaceRaised` washes alone, so it could
 * not express "a solid step up" the way web's `--surface-1..3` does.
 */
export const palette = rnThemes.dark.palette;

/** DESIGN.md §2 light ("Daylight") variant — first-class, chroma −15% aurora. */
export const paletteLight = rnThemes.light.palette;

export type Palette = typeof palette;

const ramp = rnThemes.dark.type;

/**
 * An RN type step, plus the family override `type.mono` needs. The design
 * package models mono as a *family* (`fontFamily.mono`), not a ramp step, so
 * the merge happens here rather than there.
 */
export interface MobileTypeStep extends RnTypeStep {
  readonly fontFamily?: string;
}

/**
 * The type ramp (DESIGN.md §3) as RN style fragments.
 *
 * RENAMED, not restyled: mobile's old `displayL`/`displayM`/`caption` were a
 * pre-redesign ramp. `displayL` → `hero` (the auth/marketing step), `displayM`
 * → `display` (screen titles), and the old 13px `caption` → `label`. `caption`
 * still exists but now means what DESIGN.md says it means — 11px/500 uppercase
 * — so leaving the old call sites spelled `caption` would have been a trap.
 *
 * `fontFamily.*[0]` is the bundled face; until expo-font loads it RN falls back
 * to the platform default (see README's font milestone).
 */
export const type = {
  hero: ramp.hero,
  display: ramp.display,
  title: ramp.title,
  body: ramp.body,
  label: ramp.label,
  caption: ramp.caption,
  /** Emphasis body. RN has no weight modifier — an emphasised body is a step. */
  bodyStrong: { ...ramp.body, fontWeight: '600' },
  /** Codes, timecodes. Body metrics in the mono face. */
  mono: { ...ramp.body, fontFamily: fontFamily.mono[0] },
} as const satisfies Readonly<Record<string, MobileTypeStep>>;

/** Aurora gradient stops for expo-linear-gradient (135° ≙ {0,0} → {1,1}). */
export const auroraGradient = rnThemes.dark.auroraGradient;

/** Glow, not shadow — DESIGN.md §4. Use on raised elements only. */
export const glow = rnThemes.dark.glow;

export const theme = {
  dark: palette,
  light: paletteLight,
  radii,
  spacing,
  type,
  motion,
  layout,
  auroraGradient,
  glow,
} as const;

export type Theme = typeof theme;
