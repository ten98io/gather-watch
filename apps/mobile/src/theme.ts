/**
 * Gather mobile theme — the React Native adapter over @gather/design.
 *
 * Owns: the names apps/mobile imports (`palette`, `paletteLight`, `type`,
 * `radii`, `spacing`, `motion`, `layout`, `auroraGradient`, `glow`,
 * `elevation`, `texture`, `theme`), and the two type steps the design package
 * deliberately does not carry (`type.bodyStrong`, `type.mono`) because they are
 * RN-shaped, not system-level.
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
 *  - glow is a SIGNATURE moment (DESIGN.md §5) and nothing else. Chrome that
 *    merely floats takes `elevation.e1/e2/e3`, which is a 1px hairline BORDER
 *    plus one soft shadow — spend the view's `borderWidth`/`borderColor` on it
 *    or the surface ships with a shadow and no edge;
 *  - hit targets ≥ 44px: `layout.tap` (was `layout.minHit`; the design system
 *    reconciled mobile's name with web's).
 */

import type { RnTypeStep } from '@gather/design';
import { layout, motion, radii, rnThemes, spacing, texture } from '@gather/design';

/**
 * WCAG maths used to live in this file. It now lives in @gather/design, where a
 * guard test walks the whole surface ladder — mobile had the maths and still
 * shipped a failing token, because nothing ran it over every pair.
 */
export { contrastRatio, relativeLuminance } from '@gather/design';

export { layout, motion, radii, spacing, texture };

/**
 * The dark palette — primary theme. Now includes the opaque elevation ladder
 * (`surface0`…`surface3`, `hairline`) that mobile never had: it faked elevation
 * with the translucent `surfaceGlass`/`surfaceRaised` washes alone, so it could
 * not express "a solid step up" the way web's `--surface-1..3` does.
 */
export const palette = rnThemes.dark.palette;

/** DESIGN.md §2 light ("Daylight") variant — first-class: cooler neutrals, the
 *  aurora one step darker and ~20% less chroma so it survives on paper. */
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
 * `headline` (28) is new: the ramp's display end grew (DESIGN.md §3) and the
 * jump from `title` 20 to `display` was too wide to bridge without inventing a
 * size. On RN `display` is 32 and `hero` 36 — the package resizes both, because
 * the 44/88px web settings are display type for a desktop, not for a phone.
 *
 * `fontFamily.*[0]` is the bundled face; until expo-font loads it RN falls back
 * to the platform default (see README's font milestone).
 */
export const type = {
  hero: ramp.hero,
  display: ramp.display,
  headline: ramp.headline,
  title: ramp.title,
  body: ramp.body,
  label: ramp.label,
  caption: ramp.caption,
  /** Emphasis body. RN has no weight modifier — an emphasised body is a step. */
  bodyStrong: { ...ramp.body, fontWeight: '600' },
  /** Codes, timecodes. Body metrics, and DELIBERATELY no fontFamily: JetBrains
   *  Mono is not bundled (no expo-font dependency), 'ui-monospace' is a CSS
   *  generic RN does not know, and naming Menlo/monospace needs Platform,
   *  which this module cannot import — it is loaded by the node-env tests.
   *  An unnamed face falls back to the system font with no jitter lie; the
   *  bundled mono face is the README font milestone. */
  mono: { ...ramp.body },
} as const satisfies Readonly<Record<string, MobileTypeStep>>;

/** Aurora gradient stops for expo-linear-gradient (135° ≙ {0,0} → {1,1}). */
export const auroraGradient = rnThemes.dark.auroraGradient;

/** Glow is a signature moment (DESIGN.md §5) — never a way to say "raised". */
export const glow = rnThemes.dark.glow;

/**
 * "This floats": a 1px hairline plus one soft shadow, per level (DESIGN.md §4).
 *
 * Theme-relative, unlike `glow`, because the hairline is: the edge that reads on
 * a near-black ground is a light one. Spread it across `borderWidth` /
 * `borderColor` / `shadow*` — dropping the border keeps the shadow and loses the
 * edge, which is the half that makes a surface look drawn rather than blurred.
 */
export const elevation = rnThemes.dark.elevation;
export const elevationLight = rnThemes.light.elevation;

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
  elevation,
  texture,
} as const;

export type Theme = typeof theme;
