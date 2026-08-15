/**
 * Playin mobile theme — DESIGN.md translated from CSS/OKLCH custom properties
 * to RN style tokens. Hex values are exact OKLCH→sRGB conversions of the
 * DESIGN.md tokens (conversion math recorded in README.md); the oklch source
 * is kept in each comment as the canonical reference.
 *
 * Rules carried over from DESIGN.md:
 *  - gradients only from the three aurora hues (aurora1 → aurora2 → aurora3,
 *    135°) and only for primary actions / brand moments;
 *  - body text never sits on a gradient;
 *  - elevation is glow, not shadow (RN: shadowColor = aurora1, low opacity);
 *  - hit targets ≥ 44px (see `layout.hitSlop` / min sizes below).
 */

export const palette = {
  /** oklch(0.13 0.02 285) near-black indigo */
  bgVoid: '#07060f',
  /** oklch(0.17 0.03 290) */
  bgDeep: '#0f0d1c',
  /** color-mix(white 5%, transparent) over the void */
  surfaceGlass: 'rgba(255,255,255,0.05)',
  /** color-mix(white 8%, transparent) */
  surfaceRaised: 'rgba(255,255,255,0.08)',
  /** color-mix(white 9%, transparent) 1px hairline */
  borderGlass: 'rgba(255,255,255,0.09)',
  /** oklch(0.97 0.005 285) */
  textHi: '#f5f5f8',
  /** oklch(0.78 0.015 285) */
  textMid: '#b6b6c1',
  /** oklch(0.58 0.02 285) */
  textLow: '#797986',
  /** oklch(0.62 0.23 295) electric violet */
  aurora1: '#955bfe',
  /** oklch(0.66 0.26 340) fuchsia */
  aurora2: '#f02fc3',
  /** oklch(0.80 0.16 75) solar amber */
  aurora3: '#f9ad26',
  /** oklch(0.98 0.01 295) — ink on aurora gradients */
  accentInk: '#f9f7ff',
  /** oklch(0.75 0.17 160) */
  success: '#00ce88',
  /** oklch(0.68 0.21 25) */
  danger: '#ff5251',
  /** oklch(0.82 0.16 85) */
  warn: '#f3ba25',
  /** oklch(0.72 0.20 295) */
  focusRing: '#b085ff',
} as const;

/** DESIGN.md §2 light ("Daylight") variant — first-class, chroma −15% aurora. */
export const paletteLight = {
  bgVoid: '#f5f4f9',
  bgDeep: '#ebeaf2',
  surfaceGlass: 'rgba(255,255,255,0.65)',
  surfaceRaised: 'rgba(255,255,255,0.8)',
  borderGlass: 'rgba(20,16,40,0.08)',
  textHi: '#191924',
  textMid: '#4c4c58',
  textLow: '#6a6a76',
  aurora1: '#9266ed',
  aurora2: '#e44bbc',
  aurora3: '#f0b04d',
  accentInk: '#f9f7ff',
  success: '#00ce88',
  danger: '#ff5251',
  warn: '#f3ba25',
  focusRing: '#b085ff',
} as const;

export type Palette = typeof palette;

/** Radii — DESIGN.md §4: 12 controls, 16 cards/bubbles, 24 panels/sheets, pill. */
export const radii = {
  control: 12,
  card: 16,
  panel: 24,
  pill: 999,
} as const;

/** 4pt spacing scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/**
 * Type scale — DESIGN.md §3. Display = Space Grotesk, text = Inter, mono =
 * JetBrains Mono. RN falls back to the platform font until the fonts are
 * bundled (TODO: expo-font loading milestone); the scale/weights are binding.
 * Body 15–17 fluid on web → 16 fixed here; display tracking −1%.
 */
export const type = {
  displayL: { fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -0.34 },
  displayM: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.28 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '500', letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400', letterSpacing: 0 },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: '600', letterSpacing: 0 },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400', letterSpacing: 0 },
  mono: { fontSize: 14, lineHeight: 20, fontWeight: '400', fontFamily: 'Menlo' },
} as const;

/** Motion — DESIGN.md §6 (Reanimated is the end state; core RN Animated now). */
export const motion = {
  microMs: 200,
  panelMs: 300,
  maxMs: 400,
  spring: { stiffness: 260, damping: 30 },
  typingDotStaggerMs: 120,
  emoteBurstMs: 2500,
} as const;

export const layout = {
  /** WCAG/§9: minimum hit target. */
  minHit: 44,
  /** Mobile: stage on top, bottom sheet tabs (§7). */
  tabBarHeight: 48,
} as const;

/** Aurora gradient stops (135° equivalent: start top-left → end bottom-right). */
export const auroraGradient = {
  colors: [palette.aurora1, palette.aurora2, palette.aurora3] as const,
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
} as const;

/** Glow, not shadow — §4. Use on raised elements only. */
export const glow = {
  shadowColor: palette.aurora1,
  shadowOpacity: 0.2,
  shadowRadius: 20,
  shadowOffset: { width: 0, height: 0 },
  elevation: 6,
} as const;

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

/** Relative luminance (WCAG) of a #rrggbb hex color. Used by theme tests. */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (m === null || m[1] === undefined) {
    throw new Error(`not a #rrggbb color: ${hex}`);
  }
  const n = parseInt(m[1], 16);
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colors (order-independent). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
