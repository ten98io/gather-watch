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
import type { FontFamily, Layout, Motion, RadiusName, SpacingName, TypeStepName } from './scales';
import { COLOR_TOKEN_NAMES, FILL_TOKENS, inkOn, resolveColorToken } from './tokens';
import { formatRgba } from './emit-css';
import { fontFamily, layout, motion, radii, spacing, typeRamp } from './scales';

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

export interface RnTheme {
  readonly name: ThemeName;
  readonly palette: RnPalette;
  readonly inkOn: RnInkOnFill;
  readonly auroraGradient: RnAuroraGradient;
  readonly glow: RnGlow;
  readonly type: RnTypeRamp;
  readonly radii: Readonly<Record<RadiusName, number>>;
  readonly spacing: Readonly<Record<SpacingName, number>>;
  readonly motion: Motion;
  readonly layout: Layout;
  readonly fontFamily: FontFamily;
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
 * The type ramp in RN units. `maxFontSize` and `lineHeightRatio` are dropped:
 * RN has no viewport unit, so a fluid step renders at its floor. Anything that
 * wants the hero to grow on a tablet reads `typeRamp.hero.maxFontSize` from
 * src/scales.ts directly.
 */
export function emitRnTypeRamp(): RnTypeRamp {
  const out = {} as Record<TypeStepName, RnTypeStep>;
  for (const [name, step] of Object.entries(typeRamp) as [TypeStepName, (typeof typeRamp)[TypeStepName]][]) {
    const base = {
      fontSize: step.fontSize,
      lineHeight:
        step.lineHeightRatio === undefined
          ? step.lineHeight
          : Math.round(step.fontSize * step.lineHeightRatio),
      fontWeight: String(step.fontWeight) as RnTypeStep['fontWeight'],
      letterSpacing: Number((step.fontSize * step.letterSpacing).toFixed(3)),
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

/** One fully resolved theme, ready to hand to a React context. */
export function emitRnTheme(theme: ThemeName): RnTheme {
  return {
    name: theme,
    palette: emitRnPalette(theme),
    inkOn: emitRnInkOnFill(theme),
    auroraGradient: emitRnAuroraGradient(theme),
    glow: emitRnGlow(theme),
    type: emitRnTypeRamp(),
    radii,
    spacing,
    motion,
    layout,
    fontFamily,
  };
}

/** Both themes, precomputed. `rnThemes[scheme]` is the whole mobile API. */
export const rnThemes: Readonly<Record<ThemeName, RnTheme>> = {
  dark: emitRnTheme('dark'),
  light: emitRnTheme('light'),
};
