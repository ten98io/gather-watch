/**
 * React Native theme emitter.
 *
 * Owns: the shape apps/mobile consumes — a flat palette of colour strings, the
 * type ramp with RN's string font weights and px letter spacing, and the two
 * derived objects (aurora gradient stops, glow shadow) that mobile styles with.
 *
 * Deliberately NOT: any `react-native` import (this package must typecheck and
 * test in plain Node), any `StyleSheet.create`, and any hand-written hex. Every
 * value below is computed from src/tokens.ts by src/oklch.ts.
 *
 * `rgba(…)` appears here because React Native accepts the CSS colour-string
 * form; that is the same formatter the CSS emitter uses, not a coincidence to
 * be maintained twice.
 */

import type { ColorTokenName, FillTokenName, ThemeName } from './tokens';
import type { ShadowLayer } from './scales';
import type {
  ControlSize,
  ControlSizeName,
  ElevationName,
  FontFamily,
  Layout,
  Motion,
  RadiusName,
  SpacingName,
  Texture,
  TypeStepName,
} from './scales';
import {
  COLOR_TOKEN_NAMES,
  FILL_TOKENS,
  INKS,
  inkOn,
  inkOnGradient,
  resolveColorToken,
} from './tokens';
import { formatRgba } from './emit-css';
import {
  ELEVATION_NAMES,
  controlSizes,
  elevation,
  fontFamily,
  layout,
  motion,
  radii,
  spacing,
  texture,
  typeRamp,
} from './scales';

/** Every token as a colour string RN understands: `#rrggbb` or `rgba(r,g,b,a)`. */
export type RnPalette = Readonly<Record<ColorTokenName, string>>;

/**
 * The label colour for each filled control, already chosen against that fill.
 * RN has no custom properties, so the choice is resolved here rather than
 * deferred to a `var()` the way the CSS emitter can.
 */
export type RnInkOnFill = Readonly<Record<FillTokenName, string>>;

/** RN wants font weight as a string and letter spacing in px, not em. */
export interface RnTypeStep {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: '400' | '500' | '600' | '700';
  /** px, already multiplied out from the ramp's em tracking. */
  readonly letterSpacing: number;
  readonly textTransform?: 'uppercase';
}

export type RnTypeRamp = Readonly<Record<TypeStepName, RnTypeStep>>;

/**
 * Aurora gradient stops for `expo-linear-gradient`. 135° in CSS is top-left to
 * bottom-right, which is `start {0,0}` → `end {1,1}` in RN's unit square.
 */
export interface RnAuroraGradient {
  readonly colors: readonly [string, string, string];
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

/** Elevation is glow, not shadow (DESIGN.md §4): a faint aurora underglow. */
export interface RnGlow {
  readonly shadowColor: string;
  readonly shadowOpacity: number;
  readonly shadowRadius: number;
  readonly shadowOffset: { readonly width: number; readonly height: number };
  /** Android has no shadow colour control; `elevation` is the closest it gets. */
  readonly elevation: number;
}

/**
 * One elevation level in RN's shape: a border and a shadow, because that is
 * what the two authored layers ARE on this platform.
 *
 * The hairline ring is a `0 0 0 1px` box-shadow on web and RN has no such
 * thing — but it has `borderWidth`/`borderColor`, which draws exactly the same
 * 1px ring. So the ring becomes a border rather than being dropped, which is
 * what "hairline-first" costs on RN: a view taking an elevation has to spend
 * its border on it.
 *
 * RN also has no spread, so the negative spread of the soft layer is folded
 * into a smaller radius.
 */
export interface RnElevation {
  /** Apply as `borderWidth` + `borderColor`. Always 1 — a ring is 1px or absent. */
  readonly hairlineWidth: number;
  readonly hairlineColor: string;
  readonly shadowColor: string;
  readonly shadowOpacity: number;
  readonly shadowRadius: number;
  readonly shadowOffset: { readonly width: number; readonly height: number };
  /** Android has no shadow colour control; `elevation` is the closest it gets. */
  readonly elevation: number;
}

export interface RnTheme {
  readonly name: ThemeName;
  readonly palette: RnPalette;
  readonly inkOn: RnInkOnFill;
  /** One ink for a label crossing all three aurora stops. */
  readonly inkOnGradient: string;
  readonly auroraGradient: RnAuroraGradient;
  readonly glow: RnGlow;
  /** Neutral elevation. Use this for menus and sheets; `glow` is for signature moments. */
  readonly elevation: Readonly<Record<ElevationName, RnElevation>>;
  readonly type: RnTypeRamp;
  readonly radii: Readonly<Record<RadiusName, number>>;
  readonly controlSizes: Readonly<Record<ControlSizeName, ControlSize>>;
  readonly spacing: Readonly<Record<SpacingName, number>>;
  readonly motion: Motion;
  readonly layout: Layout;
  readonly fontFamily: FontFamily;
  /**
   * Grain (DESIGN.md §4). Carried rather than rendered: `<Image>` will not
   * decode an SVG data URI without react-native-svg, which mobile does not
   * bundle. It is here so that when the dependency lands the value is already
   * the one web and the overlay use, rather than a second noise authored to
   * match by eye.
   */
  readonly texture: Texture;
}

/** Resolve every token for one theme into an RN colour string. */
export function emitRnPalette(theme: ThemeName): RnPalette {
  const out = {} as Record<ColorTokenName, string>;
  for (const name of COLOR_TOKEN_NAMES) {
    const resolved = resolveColorToken(theme, name);
    out[name] = resolved.kind === 'overlay' ? formatRgba(resolved.hex, resolved.alpha) : resolved.hex;
  }
  return out;
}

/**
 * The ink each filled control's label takes in one theme.
 *
 * A separate map rather than a `palette` entry because it is not a token: it
 * is a per-fill ANSWER, and the fill is the key. `--accent-ink` being a single
 * palette entry is how mobile ended up drawing a near-white label on every
 * vivid dark-theme fill.
 */
export function emitRnInkOnFill(theme: ThemeName): RnInkOnFill {
  const out = {} as Record<FillTokenName, string>;
  for (const fill of FILL_TOKENS) out[fill] = inkOn(theme, fill).hex;
  return out;
}

/**
 * The type ramp in RN units.
 *
 * `maxFontSize` is the WEB fluid ceiling and NEVER applies here — body stays 16
 * on RN even though the web widens it to 18 on a wide viewport. A step whose
 * designed RN size differs from the web one says so with `rnFontSize`, either
 * because the step is fluid and RN has no viewport (hero) or because the web
 * size is an oversized display setting a phone cannot hold (display 44 → 32).
 *
 * Leading is taken as the step's RATIO rather than its px value, so a step that
 * resizes for RN keeps its proportions. For a step that does not resize this is
 * exactly the authored `lineHeight` — `round(size × line / size)` — so the
 * ratio is not a second opinion, only the one that survives a resize.
 */
export function emitRnTypeRamp(): RnTypeRamp {
  const out = {} as Record<TypeStepName, RnTypeStep>;
  for (const [name, step] of Object.entries(typeRamp) as [TypeStepName, (typeof typeRamp)[TypeStepName]][]) {
    const fontSize = step.rnFontSize ?? step.fontSize;
    const ratio = step.lineHeightRatio ?? step.lineHeight / step.fontSize;
    const base = {
      fontSize,
      lineHeight: Math.round(fontSize * ratio),
      fontWeight: String(step.fontWeight) as RnTypeStep['fontWeight'],
      letterSpacing: Number((fontSize * step.letterSpacing).toFixed(3)),
    };
    out[name] = step.uppercase === true ? { ...base, textTransform: 'uppercase' } : base;
  }
  return out;
}

/** The three aurora stops for one theme, in gradient order. */
export function emitRnAuroraGradient(theme: ThemeName): RnAuroraGradient {
  const palette = emitRnPalette(theme);
  return {
    colors: [palette.aurora1, palette.aurora2, palette.aurora3],
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  };
}

/**
 * The glow. Matches web's `box-shadow: 0 0 40px -12px <aurora-1 at 22%>`:
 * RN has no spread, so the -12px inset is folded into a smaller radius and the
 * 22% mix becomes `shadowOpacity`.
 */
export function emitRnGlow(theme: ThemeName): RnGlow {
  return {
    shadowColor: emitRnPalette(theme).aurora1,
    shadowOpacity: 0.22,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  };
}

/**
 * The elevation ladder in RN units.
 *
 * Takes a theme, which the previous version did not, and the reason is the
 * hairline: the shadow is a wash of the ABSOLUTE black in both themes (a
 * shadow does not invert), but the ring is `--hairline`, which does. RN cannot
 * defer that the way CSS defers it to `var()`, so it is resolved here.
 *
 * Android's `elevation` is stepped 2/6/12 to match the three levels' apparent
 * distance from the page.
 */
export function emitRnElevation(theme: ThemeName): Readonly<Record<ElevationName, RnElevation>> {
  const androidElevation: Readonly<Record<ElevationName, number>> = { e1: 2, e2: 6, e3: 12 };
  const palette = emitRnPalette(theme);
  const out = {} as Record<ElevationName, RnElevation>;
  for (const name of ELEVATION_NAMES) {
    // Exactly two layers, in this order, by the shape of `elevation`: the ring
    // then the soft shadow. The ring is a border on RN; only the shadow is a
    // shadow.
    const [ring, soft] = elevation[name] as readonly [ShadowLayer, ShadowLayer];
    out[name] = {
      hairlineWidth: ring.spread,
      hairlineColor: palette.hairline,
      shadowColor: INKS.inkBlack.hex,
      shadowOpacity: soft.alpha,
      // RN's radius is roughly half the CSS blur, and the negative spread is
      // folded in by shrinking it further.
      shadowRadius: Math.round((soft.blur + soft.spread) / 2),
      shadowOffset: { width: 0, height: soft.y },
      elevation: androidElevation[name],
    };
  }
  return out;
}

/** One fully resolved theme, ready to hand to a React context. */
export function emitRnTheme(theme: ThemeName): RnTheme {
  return {
    name: theme,
    palette: emitRnPalette(theme),
    inkOn: emitRnInkOnFill(theme),
    inkOnGradient: inkOnGradient(theme).hex,
    auroraGradient: emitRnAuroraGradient(theme),
    glow: emitRnGlow(theme),
    elevation: emitRnElevation(theme),
    type: emitRnTypeRamp(),
    radii,
    controlSizes,
    spacing,
    motion,
    layout,
    fontFamily,
    texture,
  };
}

/** Both themes, precomputed. `rnThemes[scheme]` is the whole mobile API. */
export const rnThemes: Readonly<Record<ThemeName, RnTheme>> = {
  dark: emitRnTheme('dark'),
  light: emitRnTheme('light'),
};
