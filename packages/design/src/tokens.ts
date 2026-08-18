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
import { compositeOver, contrastRatio } from './contrast';
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
  //
  // LIGHTNESS RAISED (2026-08-18), and this is the fix for the failure the
  // guard test used to merely RECORD: the primary button's fill is the 135°
  // aurora gradient, so one ink has to clear all three stops, and on light the
  // best single ink measured 3.96:1 — under the 4.5:1 text bar. Black is the
  // ink that can win here (light `aurora3` is amber at 7.69:1 with black and
  // 2.73:1 with white, so white can never serve the gradient), and black gets
  // better as the fill gets LIGHTER. aurora1 0.55→0.59 takes black from 3.96 to
  // 4.72:1; aurora2 0.58→0.60 takes it from 4.33 to 4.74:1. Chroma comes down
  // one notch with each so the hue does not go neon as it lightens.
  //
  // The cost, stated: `accent` aliases `aurora1`, and as a standalone UI colour
  // its worst rung on the light ladder falls 4.17 → 3.49:1 (`surface3`), still
  // clear of the 3:1 non-text bar. And light `--ink-on-accent` flips white →
  // black, 5.31 → 4.72:1, still clear of the 4.5:1 text bar.
  aurora1: solid(0.59, 0.19, 295, 'electric violet'),
  aurora2: solid(0.6, 0.21, 340, 'fuchsia'),
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
 * `bgVoid` → `bg-void`, `surface0` → `surface-0`, `aurora1` → `aurora-1`.
 * The digit case is why this is not a plain camel-to-kebab: the ladder and the
 * aurora hues are numbered, and web's stylesheet already spells them that way.
 */
const kebab = (name: string): string =>
  name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();

/** `bgVoid` → `--bg-void`. */
export function cssVarName(token: ColorTokenName): string {
  return `--${kebab(token)}`;
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

/**
 * Tokens that are the BACKGROUND of a filled control — a primary button, a
 * destructive button, a status pill — and therefore have a label drawn on top
 * of them. Every one is held to WCAG_AA_TEXT against the ink `inkOn` picks.
 *
 * `aurora2` and `aurora3` are here even though `STANDALONE_UI_TOKENS` excludes
 * them: they never appear as a fill on their own, but they are two of the three
 * stops of the 135° gradient (DESIGN.md §2) that IS the primary button's fill,
 * so a label crosses them.
 */
export type FillTokenName =
  | 'aurora1'
  | 'aurora2'
  | 'aurora3'
  | 'accent'
  | 'success'
  | 'danger'
  | 'warn';

/** Emission order, mirroring `COLOR_TOKEN_NAMES`. */
export const FILL_TOKENS: readonly FillTokenName[] = [
  'aurora1',
  'aurora2',
  'aurora3',
  'accent',
  'success',
  'danger',
  'warn',
];

/**
 * ── Ink on a fill ─────────────────────────────────────────────────────────
 *
 * A fill and the ink on it are a PAIR, and the ink has to be chosen against
 * the fill it lands on — never against the theme. `accentInk` was the theme's
 * answer to the question, and being theme-relative is exactly what broke it:
 * it is a near-white in BOTH themes, so it sat on dark's vivid, light fills and
 * measured 3.80:1 on `accent`, 2.99:1 on `danger`, 1.67:1 on `warn`. Every
 * filled label in the dark theme shipped under AA.
 *
 * These two inks are absolute — the sRGB endpoints — and neither is a token,
 * so no palette tuning can flip one out from under a fill.
 *
 * They are NOT derived from the near-black/near-white already in the palette,
 * because those do not reach: on light `success` (#008758), dark `bgVoid`
 * measures 4.42:1 and `accentInk` 4.29:1, so max(near-black, near-white) is
 * still an AA failure. Pure black clears it at 4.61:1. The endpoints are also
 * the only pair of values in the system that nothing else can move.
 */
const INK_BLACK: Oklch = { l: 0, c: 0, h: 0 };
const INK_WHITE: Oklch = { l: 1, c: 0, h: 0 };

export type InkName = 'inkBlack' | 'inkWhite';

/** A chosen ink: which of the two, in the authored form and as sRGB. */
export interface Ink {
  readonly name: InkName;
  readonly oklch: Oklch;
  readonly hex: string;
}

/** The two inks, and the only two. Theme-independent by construction. */
export const INKS: Readonly<Record<InkName, Ink>> = {
  inkBlack: { name: 'inkBlack', oklch: INK_BLACK, hex: oklchToHex(INK_BLACK) },
  inkWhite: { name: 'inkWhite', oklch: INK_WHITE, hex: oklchToHex(INK_WHITE) },
};

/** `inkBlack` → `--ink-black`. */
export function inkCssVarName(ink: InkName): string {
  return `--${kebab(ink)}`;
}

/** `accent` → `--ink-on-accent`, `aurora1` → `--ink-on-aurora-1`. */
export function inkOnCssVarName(fill: FillTokenName): string {
  return `--ink-on-${kebab(fill)}`;
}

/**
 * The ink for an arbitrary fill colour, by measurement: whichever of the two
 * has the higher contrast against it.
 *
 * Exported alongside `inkOn` because `--accent` is not a constant — a listen
 * room rebinds it to the track's artwork colour at runtime, and the ink on it
 * has to be recomputed from the colour that actually landed. A consumer doing
 * that sets `--ink-on-accent` to the returned `hex` at the same time.
 *
 * An exact tie (a fill at the luminance midpoint, ≈#777) goes to `inkBlack`.
 * Arbitrary, but fixed, so the function stays deterministic.
 */
export function inkForFill(fillHex: string): Ink {
  const onBlack = contrastRatio(INKS.inkBlack.hex, fillHex);
  const onWhite = contrastRatio(INKS.inkWhite.hex, fillHex);
  return onBlack >= onWhite ? INKS.inkBlack : INKS.inkWhite;
}

/**
 * The ink to put on one fill token in one theme.
 *
 * Per FILL, and deliberately NOT the answer for the gradient — a gradient is
 * three fills under one label, so it gets `inkOnGradient` below.
 */
export function inkOn(theme: ThemeName, fill: FillTokenName): Ink {
  return inkForFill(resolveColorToken(theme, fill).hex);
}

/**
 * The three stops of the 135° aurora gradient (DESIGN.md §2), in gradient
 * order. The primary button, the brand mark and the playing indicator are all
 * painted with exactly this and nothing else.
 */
export const AURORA_GRADIENT_STOPS: readonly FillTokenName[] = ['aurora1', 'aurora2', 'aurora3'];

/**
 * The ink for a label drawn ACROSS the aurora gradient.
 *
 * `inkOn` cannot answer this. A label on the primary button crosses all three
 * stops, so the ink that matters is the one whose WORST stop is best — a
 * maximin, not a per-colour choice. Picking per stop is exactly how the
 * shipped button ended up with `--accent-ink` (a near-white in both themes) on
 * dark's vivid fills at a floor of 1.79:1 against `aurora3`.
 *
 * Ties go to `inkBlack`, matching `inkForFill`, so the two stay consistent.
 */
export function inkOnGradient(theme: ThemeName): Ink {
  const floor = (ink: Ink): number =>
    Math.min(
      ...AURORA_GRADIENT_STOPS.map((stop) =>
        contrastRatio(ink.hex, resolveColorToken(theme, stop).hex),
      ),
    );
  return floor(INKS.inkBlack) >= floor(INKS.inkWhite) ? INKS.inkBlack : INKS.inkWhite;
}

/** `--ink-on-aurora-gradient`. Named apart from `inkOnCssVarName`'s per-fill set. */
export const INK_ON_GRADIENT_CSS_VAR = '--ink-on-aurora-gradient';

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
