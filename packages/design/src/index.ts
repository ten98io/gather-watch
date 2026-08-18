/**
 * @gather/design — the single source of truth for the Gather design system.
 *
 * Owns: every colour, scale and emitter the product renders from. DESIGN.md
 * stays the prose statement of intent; this package is the executable one.
 *
 * Deliberately NOT: components, Tailwind config, or anything that imports a
 * framework. Consumers translate — apps/web through `emitCssThemes`, the
 * extension overlay through `emitShadowRootCss`, apps/mobile through
 * `rnThemes` — but nobody redefines.
 */

export type { Oklab, Oklch, OklchToSrgbResult, Rgb } from './oklch';
export {
  SRGB_GAMUT_EPSILON,
  hexToOklch,
  hexToRgb,
  linearSrgbToOklab,
  linearSrgbToSrgb,
  oklabToLinearSrgb,
  oklabToOklch,
  oklchToHex,
  oklchToLinearSrgb,
  oklchToOklab,
  oklchToSrgb,
  rgbToHex,
  srgbToLinearSrgb,
} from './oklch';

export {
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NON_TEXT,
  WCAG_AA_TEXT,
  compositeOver,
  contrastRatio,
  relativeLuminance,
} from './contrast';

export type {
  AliasToken,
  ColorToken,
  ColorTokenName,
  EffectiveSurface,
  FillTokenName,
  Ink,
  InkName,
  OverlayToken,
  ResolvedColor,
  SolidToken,
  ThemeName,
} from './tokens';
export {
  AURORA_GRADIENT_STOPS,
  COLOR_TOKEN_NAMES,
  FILL_TOKENS,
  INK_ON_GRADIENT_CSS_VAR,
  INKS,
  OVERLAY_SURFACES,
  STANDALONE_UI_TOKENS,
  SURFACE_LADDER,
  TEXT_TOKENS,
  THEME_NAMES,
  colorTokens,
  cssVarName,
  effectiveSurfaces,
  inkCssVarName,
  inkForFill,
  inkOn,
  inkOnCssVarName,
  inkOnGradient,
  resolveAlias,
  resolveColorToken,
} from './tokens';

export type {
  ControlSize,
  ControlSizeName,
  ElevationName,
  FontFamily,
  FontWeight,
  Layout,
  Motion,
  RadiusName,
  ShadowLayer,
  SpacingName,
  Spring,
  TypeStep,
  TypeStepName,
} from './scales';
export {
  CONTROL_SIZE_NAMES,
  ELEVATION_NAMES,
  SPACING_RAMP,
  controlSizes,
  elevation,
  fontFamily,
  layout,
  motion,
  radii,
  spacing,
  typeRamp,
} from './scales';

export type {
  CssColorFormat,
  CssEmitOptions,
  CssThemeBlockOptions,
  ShadowRootCssOptions,
} from './emit-css';
export {
  emitCssBlock,
  emitCssControlMetrics,
  emitCssScaleVariables,
  emitCssThemes,
  emitCssVariables,
  emitShadowRootCss,
  formatColorToken,
  formatElevation,
  formatOklch,
  formatRgba,
} from './emit-css';

export type {
  RnAuroraGradient,
  RnElevation,
  RnGlow,
  RnInkOnFill,
  RnPalette,
  RnTheme,
  RnTypeRamp,
  RnTypeStep,
} from './emit-rn';
export {
  emitRnAuroraGradient,
  emitRnElevation,
  emitRnGlow,
  emitRnInkOnFill,
  emitRnPalette,
  emitRnTheme,
  emitRnTypeRamp,
  rnThemes,
} from './emit-rn';
