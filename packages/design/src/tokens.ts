/**
 * The colour tokens — DESIGN.md §2, authored once, in OKLCH.
 *
 * Owns: every colour value in the product, for both themes; the alias graph
 * (`--accent` is `--aurora-1`, `--surface-0` is `--bg-void`); the CSS custom
 * property name of each token; and the surface ladder the contrast guard walks.
 *
 * Deliberately NOT: output syntax (src/emit-css.ts, src/emit-rn.ts), colour
 * maths (src/oklch.ts), or non-colour scales (src/scales.ts). Nothing here
 * knows what a stylesheet or a StyleSheet is.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 * This file is the ONLY place a colour value may be written down. Web reads it
 * through the CSS emitter, mobile through the React Native emitter, the
 * extension's shadow root through the shadow-root emitter. A hex literal
 * anywhere else is a bug — that is precisely how apps/mobile ended up a whole
 * accessibility fix behind apps/web.
 */

import type { Oklch } from './oklch';
import { compositeOver } from './contrast';
import { oklchToHex } from './oklch';

/** Dark is the primary theme; light ("Daylight") is a first-class variant. */
export type ThemeName = 'dark' | 'light';

export const THEME_NAMES: readonly ThemeName[] = ['dark', 'light'];

/**
 * Every colour token, in the order they are emitted. Names are camelCase here
 * and become `--kebab-case` custom properties via `cssVarName`.
 */
export type ColorTokenName =
  | 'bgVoid'
  | 'bgDeep'
  | 'surfaceGlass'
  | 'surfaceRaised'
  | 'borderGlass'
  | 'surface0'
  | 'surface1'
  | 'surface2'
  | 'surface3'
  | 'hairline'
  | 'textHi'
  | 'textMid'
  | 'textLow'
  | 'aurora1'
  | 'aurora2'
  | 'aurora3'
  | 'accent'
  | 'accentInk'
  | 'success'
  | 'danger'
  | 'warn'
  | 'focusRing';

/** An opaque colour. */
export interface SolidToken {
  readonly kind: 'solid';
  readonly value: Oklch;
  /** Emitted as a comment beside the declaration. Rationale a reader would trip on. */
  readonly note?: string;
}

/**
 * A translucent wash of `over` at `alpha`, to be composited onto whatever is
 * behind it. Equivalent to the `color-mix(in oklch, <over> <alpha>%,
 * transparent)` the hand-written CSS used: mixing with `transparent` premultiplies,
 * so the colour comes entirely from `over` and only the alpha is scaled.
 */
export interface OverlayToken {
  readonly kind: 'overlay';
  readonly over: Oklch;
  readonly alpha: number;
  readonly note?: string;
}

/** A second name for another token. Emitted as `var(--other)`; resolved for RN. */
export interface AliasToken {
  readonly kind: 'alias';
  readonly of: ColorTokenName;
  readonly note?: string;
}

export type ColorToken = SolidToken | OverlayToken | AliasToken;

/** A token with its aliases followed and its sRGB rendering computed. */
export type ResolvedColor =
  | { readonly kind: 'solid'; readonly oklch: Oklch; readonly hex: string }
  | {
      readonly kind: 'overlay';
      readonly oklch: Oklch;
      readonly alpha: number;
      readonly hex: string;
    };

const solid = (l: number, c: number, h: number, note?: string): SolidToken =>
  note === undefined
    ? { kind: 'solid', value: { l, c, h } }
    : { kind: 'solid', value: { l, c, h }, note };

const overlay = (over: Oklch, alpha: number, note?: string): OverlayToken =>
  note === undefined ? { kind: 'overlay', over, alpha } : { kind: 'overlay', over, alpha, note };

const alias = (of: ColorTokenName, note?: string): AliasToken =>
  note === undefined ? { kind: 'alias', of } : { kind: 'alias', of, note };

/** Pure white in OKLCH — the base of every light wash. */
const WHITE: Oklch = { l: 1, c: 0, h: 0 };
/** The ink the light theme's hairlines are a wash of. */
const LIGHT_HAIRLINE_INK: Oklch = { l: 0.3, c: 0.03, h: 285 };

const dark: Readonly<Record<ColorTokenName, ColorToken>> = {
  bgVoid: solid(0.13, 0.02, 285, 'near-black indigo'),
  bgDeep: solid(0.17, 0.03, 290),
  surfaceGlass: overlay(WHITE, 0.05, 'glass panels also carry blur(20px) saturate(1.3)'),
  surfaceRaised: overlay(WHITE, 0.08),
  borderGlass: overlay(WHITE, 0.09),
  // Elevation ladder (DESIGN.md §4): solid steps, NOT glass. Surfaces are
  // separated by background step; a hairline is allowed only where two
  // same-step surfaces meet.
  surface0: alias('bgVoid', 'page ground'),
  surface1: solid(0.19, 0.025, 290, 'rail, cards'),
  surface2: solid(0.23, 0.028, 290, 'hover, raised card'),
  surface3: solid(0.27, 0.03, 290, 'active / selected row'),
  hairline: overlay(WHITE, 0.06),
  textHi: solid(0.97, 0.005, 285),
  textMid: solid(0.78, 0.015, 285),
  textLow: solid(
    0.65,
    0.02,
    285,
    'measured floor: 0.58 fell to 3.53:1 on --surface-3; 0.65 holds >=4.68:1 across the ladder',
  ),
  aurora1: solid(0.62, 0.23, 295, 'electric violet'),
  aurora2: solid(0.66, 0.26, 340, 'fuchsia'),
  aurora3: solid(0.8, 0.16, 75, 'solar amber'),
  accent: alias('aurora1', 'listen rooms rebind this to the artwork colour at runtime'),
  accentInk: solid(0.98, 0.01, 295, 'ink on aurora gradients'),
  success: solid(0.75, 0.17, 160),
  danger: solid(0.68, 0.21, 25),
  warn: solid(0.82, 0.16, 85),
  focusRing: solid(0.72, 0.2, 295),
};

const light: Readonly<Record<ColorTokenName, ColorToken>> = {
  bgVoid: solid(0.97, 0.006, 290),
  bgDeep: solid(0.94, 0.01, 290),
  surfaceGlass: overlay(WHITE, 0.65),
  surfaceRaised: overlay(WHITE, 0.8),
  borderGlass: overlay(LIGHT_HAIRLINE_INK, 0.14),
  // Ladder mirrored: the ground is tinted paper, elevation moves toward white
  // for cards and back down for hover/active — the inverse of the dark steps.
  surface0: alias('bgVoid', 'page ground'),
  surface1: solid(0.995, 0.003, 290, 'rail, cards'),
  surface2: solid(0.955, 0.008, 290, 'hover, raised card'),
  surface3: solid(0.92, 0.012, 290, 'active / selected row'),
  hairline: overlay(LIGHT_HAIRLINE_INK, 0.12),
  textHi: solid(0.22, 0.02, 285),
  textMid: solid(0.42, 0.02, 285),
  textLow: solid(
    0.5,
    0.02,
    285,
    'measured floor: 0.55 fell to 3.83:1 on --surface-3; 0.50 holds >=4.72:1 across the ladder',
  ),
  // Aurora hues persist — chroma dialed down ~15% for WCAG AA on light.
  aurora1: solid(0.55, 0.2, 295, 'electric violet'),
  aurora2: solid(0.58, 0.22, 340, 'fuchsia'),
  aurora3: solid(0.7, 0.14, 75, 'solar amber'),
  accent: alias('aurora1', 'listen rooms rebind this to the artwork colour at runtime'),
  accentInk: solid(0.98, 0.01, 295, 'ink on aurora gradients'),
  success: solid(0.55, 0.15, 160),
  danger: solid(0.55, 0.19, 25),
  warn: solid(
    0.58,
    0.14,
    85,
    'measured floor: 0.62 fell to 2.88:1 on --surface-3, under the 3:1 non-text bar; 0.58 holds >=3.42:1',
  ),
  focusRing: solid(0.58, 0.18, 295),
};

/** The palette. Both themes carry the same key set — the type enforces it. */
export const colorTokens: Readonly<Record<ThemeName, Readonly<Record<ColorTokenName, ColorToken>>>> =
  { dark, light };

/**
 * Emission order. Fixed rather than derived from `Object.keys` so the emitted
 * stylesheet diffs cleanly when a token's value changes.
 */
export const COLOR_TOKEN_NAMES: readonly ColorTokenName[] = [
  'bgVoid',
  'bgDeep',
  'surfaceGlass',
  'surfaceRaised',
  'borderGlass',
  'surface0',
  'surface1',
  'surface2',
  'surface3',
  'hairline',
  'textHi',
  'textMid',
  'textLow',
  'aurora1',
  'aurora2',
  'aurora3',
  'accent',
  'accentInk',
  'success',
  'danger',
  'warn',
  'focusRing',
];

/**
 * `bgVoid` → `--bg-void`, `surface0` → `--surface-0`, `aurora1` → `--aurora-1`.
 * The digit case is why this is not a plain camel-to-kebab: the ladder and the
 * aurora hues are numbered, and web's stylesheet already spells them that way.
 */
export function cssVarName(token: ColorTokenName): string {
  return `--${token.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()}`;
}

/** Follow aliases to the token that actually carries a value. */
export function resolveAlias(theme: ThemeName, name: ColorTokenName): ColorTokenName {
  const seen = new Set<ColorTokenName>();
  let current = name;
  for (;;) {
    const token = colorTokens[theme][current];
    if (token.kind !== 'alias') return current;
    if (seen.has(current)) throw new Error(`alias cycle at ${theme}.${current}`);
    seen.add(current);
    current = token.of;
  }
}

/** Resolve a token to its OKLCH value, alpha (if any) and rendered sRGB hex. */
export function resolveColorToken(theme: ThemeName, name: ColorTokenName): ResolvedColor {
  const token = colorTokens[theme][resolveAlias(theme, name)];
  if (token.kind === 'overlay') {
    return {
      kind: 'overlay',
      oklch: token.over,
      alpha: token.alpha,
      hex: oklchToHex(token.over),
    };
  }
  // `resolveAlias` guarantees this is not an alias; overlay is handled above.
  const value = (token as SolidToken).value;
  return { kind: 'solid', oklch: value, hex: oklchToHex(value) };
}

/** The opaque elevation ladder, ground first (DESIGN.md §4). */
export const SURFACE_LADDER: readonly ColorTokenName[] = [
  'bgVoid',
  'bgDeep',
  'surface0',
  'surface1',
  'surface2',
  'surface3',
];

/** Translucent surfaces. Text on these sits on the composite, not on the wash. */
export const OVERLAY_SURFACES: readonly ColorTokenName[] = ['surfaceGlass', 'surfaceRaised'];

/** The three text tokens. Every one is held to WCAG_AA_TEXT on every surface. */
export const TEXT_TOKENS: readonly ColorTokenName[] = ['textHi', 'textMid', 'textLow'];

/**
 * Tokens that can be the whole of a UI affordance on their own — a status dot,
 * the focus ring, the accent edge — and so are held to WCAG_AA_NON_TEXT.
 *
 * `aurora2` and `aurora3` are absent by rule, not by convenience: DESIGN.md §2
 * reserves them for the 135° gradient (primary button, brand mark, playing
 * indicator) and they never appear as a standalone fill. `aurora1` IS here,
 * because `--accent` aliases it and the accent is used alone.
 */
export const STANDALONE_UI_TOKENS: readonly ColorTokenName[] = [
  'accent',
  'focusRing',
  'success',
  'danger',
  'warn',
];

/** A surface as text actually meets it: opaque, with any wash already composited. */
export interface EffectiveSurface {
  readonly token: ColorTokenName;
  /** The ladder step an overlay was composited onto. Absent for opaque surfaces. */
  readonly over?: ColorTokenName;
  /** Human label for test output, e.g. `surfaceGlass over bgVoid`. */
  readonly label: string;
  readonly hex: string;
}

/**
 * Every surface a text token can land on, with translucent ones composited
 * onto the two grounds they are allowed over (DESIGN.md §4 puts glass over the
 * void or over `--bg-deep`; the reduced-transparency fallback is `--bg-deep`).
 */
export function effectiveSurfaces(theme: ThemeName): readonly EffectiveSurface[] {
  const opaque: EffectiveSurface[] = SURFACE_LADDER.map((token) => ({
    token,
    label: token,
    hex: resolveColorToken(theme, token).hex,
  }));

  const grounds: readonly ColorTokenName[] = ['bgVoid', 'bgDeep'];
  const washed: EffectiveSurface[] = [];
  for (const token of OVERLAY_SURFACES) {
    const wash = resolveColorToken(theme, token);
    if (wash.kind !== 'overlay') continue;
    for (const ground of grounds) {
      washed.push({
        token,
        over: ground,
        label: `${token} over ${ground}`,
        hex: compositeOver(wash.hex, wash.alpha, resolveColorToken(theme, ground).hex),
      });
    }
  }

  return [...opaque, ...washed];
}
