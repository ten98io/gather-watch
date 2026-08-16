/**
 * OKLCH ⇄ sRGB conversion.
 *
 * Owns: the colour-space maths (OKLCH → OKLab → linear sRGB → gamma-encoded
 * sRGB and back), the sRGB gamut policy, and hex parsing/formatting.
 *
 * Deliberately NOT: token values (src/tokens.ts), contrast maths
 * (src/contrast.ts), CSS syntax (src/emit-css.ts), or any notion of a theme.
 * Everything here is a pure function over numbers.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * Colour is AUTHORED in OKLCH because DESIGN.md §2 reasons in it. Every hex
 * that ships — React Native, canvas, anything that cannot evaluate `oklch()` —
 * is GENERATED here. Hand-transcribed hex is what let the mobile palette drift
 * a whole accessibility fix behind the web one.
 *
 * ── Gamut policy (stated, not silent) ─────────────────────────────────────
 * An OKLCH triple can name a colour sRGB cannot show. When that happens we
 * reduce CHROMA toward 0 by bisection, holding L and H fixed, until the colour
 * fits — the shape CSS Color 4 specifies for gamut mapping. The alternative,
 * clamping each RGB channel into [0,1], silently moves lightness AND hue:
 * `oklch(0.72 0.20 295)` (the focus ring) channel-clamps to #b085ff, which is
 * really oklch(0.7096 0.1755 298.06) — 3 degrees of hue and a step of
 * lightness away from what was authored. Chroma reduction gives #ad8dff =
 * oklch(0.7204 0.1631 294.91), which is the same colour, only as saturated as
 * sRGB can be. `oklchToSrgb` reports `inGamut` and the chroma it actually
 * rendered, so a caller can never be lied to about it.
 */

/** A colour authored in OKLCH. `l` 0–1, `c` ≥ 0 (~0.4 max in sRGB), `h` degrees. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

/** OKLab: perceptual lightness plus two opponent axes. */
export interface Oklab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/** An sRGB triple. `linear*` variants carry 0–1 floats; `Rgb` carries 0–255 integers. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Result of rendering an OKLCH colour into sRGB, including what gamut mapping did. */
export interface OklchToSrgbResult {
  /** 0–255 integer channels, ready to hex. */
  readonly rgb: Rgb;
  /** `#rrggbb`, lower case. */
  readonly hex: string;
  /** False when the authored colour fell outside sRGB and chroma had to be reduced. */
  readonly inGamut: boolean;
  /** The chroma actually rendered. Equals the authored chroma when `inGamut`. */
  readonly chroma: number;
}

/**
 * Slack allowed before a linear-sRGB channel counts as out of gamut. Sized for
 * float noise in the matrix multiply, not for real out-of-gamut colour: at
 * 8-bit output 1e-4 is a fortieth of one channel step.
 */
export const SRGB_GAMUT_EPSILON = 1e-4;

/** Bisection steps used to find the largest in-gamut chroma. 24 resolves to ~2e-8. */
const GAMUT_BISECTION_STEPS = 24;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Polar → cartesian. Hue is degrees, measured the usual way (0 = +a axis). */
export function oklchToOklab(color: Oklch): Oklab {
  const radians = (color.h * Math.PI) / 180;
  return {
    l: color.l,
    a: color.c * Math.cos(radians),
    b: color.c * Math.sin(radians),
  };
}

/** Cartesian → polar. Hue is normalised into [0, 360). */
export function oklabToOklch(lab: Oklab): Oklch {
  const h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  return {
    l: lab.l,
    c: Math.hypot(lab.a, lab.b),
    h: h < 0 ? h + 360 : h,
  };
}

/**
 * OKLab → linear sRGB. UNCLAMPED on purpose: a channel outside [0,1] is the
 * signal that the colour is outside the sRGB gamut, and the gamut mapper needs
 * to see it. Coefficients are Ottosson's.
 */
export function oklabToLinearSrgb(lab: Oklab): Rgb {
  const lRoot = lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const mRoot = lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const sRoot = lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b;
  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/** Linear sRGB → OKLab. Inverse of `oklabToLinearSrgb`. */
export function linearSrgbToOklab(rgb: Rgb): Oklab {
  const l = Math.cbrt(0.4122214708 * rgb.r + 0.5363325363 * rgb.g + 0.0514459929 * rgb.b);
  const m = Math.cbrt(0.2119034982 * rgb.r + 0.6806995451 * rgb.g + 0.1073969566 * rgb.b);
  const s = Math.cbrt(0.0883024619 * rgb.r + 0.2817188376 * rgb.g + 0.6299787005 * rgb.b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** OKLCH → linear sRGB, unclamped. See `oklabToLinearSrgb` for why. */
export function oklchToLinearSrgb(color: Oklch): Rgb {
  return oklabToLinearSrgb(oklchToOklab(color));
}

/** sRGB transfer function, one channel, linear 0–1 → encoded 0–1. */
export function linearSrgbToSrgb(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** Inverse sRGB transfer function, one channel, encoded 0–1 → linear 0–1. */
export function srgbToLinearSrgb(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function isInGamut(rgb: Rgb): boolean {
  const lo = -SRGB_GAMUT_EPSILON;
  const hi = 1 + SRGB_GAMUT_EPSILON;
  return rgb.r >= lo && rgb.r <= hi && rgb.g >= lo && rgb.g <= hi && rgb.b >= lo && rgb.b <= hi;
}

/**
 * Render an OKLCH colour into sRGB, reducing chroma if that is what it takes.
 *
 * Lightness outside [0,1] is clamped first — it does not name a colour, so
 * there is nothing to preserve. Chroma 0 at any clamped lightness is always
 * in gamut (it is a grey), which is what makes the bisection terminate.
 */
export function oklchToSrgb(color: Oklch): OklchToSrgbResult {
  const l = clamp01(color.l);
  let chroma = color.c;
  let linear = oklchToLinearSrgb({ l, c: chroma, h: color.h });
  const inGamut = isInGamut(linear);

  if (!inGamut) {
    let lo = 0;
    let hi = chroma;
    for (let i = 0; i < GAMUT_BISECTION_STEPS; i += 1) {
      const mid = (lo + hi) / 2;
      if (isInGamut(oklchToLinearSrgb({ l, c: mid, h: color.h }))) lo = mid;
      else hi = mid;
    }
    chroma = lo;
    linear = oklchToLinearSrgb({ l, c: chroma, h: color.h });
  }

  // The residual clamps here are the ±SRGB_GAMUT_EPSILON of float noise the
  // bisection was allowed to leave behind — never real out-of-gamut colour.
  const rgb: Rgb = {
    r: Math.round(clamp01(linearSrgbToSrgb(clamp01(linear.r))) * 255),
    g: Math.round(clamp01(linearSrgbToSrgb(clamp01(linear.g))) * 255),
    b: Math.round(clamp01(linearSrgbToSrgb(clamp01(linear.b))) * 255),
  };

  return { rgb, hex: rgbToHex(rgb), inGamut, chroma };
}

/** OKLCH → `#rrggbb`. The only sanctioned way to produce a hex in this system. */
export function oklchToHex(color: Oklch): string {
  return oklchToSrgb(color).hex;
}

/** `#rrggbb` → OKLCH. Hue of a neutral grey is meaningless but is still reported. */
export function hexToOklch(hex: string): Oklch {
  const { r, g, b } = hexToRgb(hex);
  return oklabToOklch(
    linearSrgbToOklab({
      r: srgbToLinearSrgb(r / 255),
      g: srgbToLinearSrgb(g / 255),
      b: srgbToLinearSrgb(b / 255),
    }),
  );
}

const HEX_PATTERN = /^#([0-9a-fA-F]{6})$/;

/** Parse `#rrggbb` into 0–255 channels. Throws rather than guessing. */
export function hexToRgb(hex: string): Rgb {
  const match = HEX_PATTERN.exec(hex);
  if (match === null || match[1] === undefined) {
    throw new Error(`not a #rrggbb color: ${hex}`);
  }
  const n = parseInt(match[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Format 0–255 channels as `#rrggbb`. Values are rounded and clamped. */
export function rgbToHex(rgb: Rgb): string {
  const channel = (v: number): string => {
    const n = Math.max(0, Math.min(255, Math.round(v)));
    return n.toString(16).padStart(2, '0');
  };
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}
