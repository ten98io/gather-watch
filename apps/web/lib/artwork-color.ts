/**
 * Artwork colour: the two things every content-forward surface needs.
 *
 * 1. `artworkGradient(seed)` — a deterministic gradient for items with no
 *    artwork, so <Artwork> never renders a blank grey box. Same seed always
 *    yields the same pair of colours, on every client, with no state.
 * 2. `accentFrom*` — the dominant colour of a piece of artwork, clamped into an
 *    OKLCH lightness/chroma band so it stays legible as a progress fill or an
 *    active-row edge on BOTH themes (DESIGN.md §5). Listen rooms bind the
 *    result to `--accent`.
 *
 * The extraction path is deliberately silent: remote artwork taints the canvas
 * under CORS, `getImageData` throws, and we fall straight back to the aurora
 * accent. A tainted canvas is the expected case, not an error.
 *
 * Everything above `accentFromImage` is pure and unit-tested in
 * test/artwork-color.test.ts; only the last two functions touch the DOM.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** What listen rooms use when artwork is missing, achromatic or CORS-tainted. */
export const ARTWORK_FALLBACK_ACCENT = 'var(--aurora-1)';

/** Accent legibility band: fills stay ≥3:1 against surface-0..3 in both themes. */
export const ACCENT_L_MIN = 0.55;
export const ACCENT_L_MAX = 0.72;
export const ACCENT_C_MIN = 0.06;
export const ACCENT_C_MAX = 0.18;
/** Below this chroma the source is grey — a hue would be invented, so we don't. */
export const ACCENT_C_FLOOR = 0.03;

/** FNV-1a, 32-bit. Stable across engines: integer ops only, no Math.random. */
export function seedHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    // hash * 16777619 without overflowing the float53 mantissa.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

export interface ArtworkGradient {
  /** Top-left stop. */
  from: string;
  /** Bottom-right stop. */
  to: string;
  /** Ready for `style={{ backgroundImage }}`. */
  css: string;
}

/**
 * Deterministic placeholder gradient. Two mid-dark stops so the provider glyph
 * (white at low opacity) reads on top of it in either theme.
 */
export function artworkGradient(seed: string): ArtworkGradient {
  const hash = seedHash(seed.length > 0 ? seed : 'playin');
  const hueA = hash % 360;
  // 28°–92° apart: enough separation to read as a gradient, never a clash.
  const hueB = (hueA + 28 + ((hash >>> 9) % 64)) % 360;
  const from = `oklch(0.52 0.13 ${hueA})`;
  const to = `oklch(0.34 0.10 ${hueB})`;
  return { from, to, css: `linear-gradient(135deg, ${from} 0%, ${to} 100%)` };
}

/** sRGB 0..255 → OKLCH (Björn Ottosson's matrices). Hue in degrees 0..360. */
export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lin = (v: number): number => {
    const s = Math.min(255, Math.max(0, v)) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const rl = lin(r);
  const gl = lin(g);
  const bl = lin(b);

  const l = Math.cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl);
  const m = Math.cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl);
  const s = Math.cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl);

  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const c = Math.hypot(okA, okB);
  const hue = c === 0 ? 0 : ((Math.atan2(okB, okA) * 180) / Math.PI + 360) % 360;
  return { l: okL, c, h: hue };
}

/** `oklch(0.620 0.140 264.3)` — fixed precision keeps output deterministic. */
export function formatOklch({ l, c, h }: Oklch): string {
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`;
}

/**
 * Force a sampled colour into the legibility band. Returns null for greys —
 * clamping those would invent a hue, so the caller uses the aurora accent.
 */
export function clampAccent(color: Oklch): string | null {
  if (!Number.isFinite(color.l) || !Number.isFinite(color.c)) return null;
  if (color.c < ACCENT_C_FLOOR) return null;
  return formatOklch({
    l: Math.min(ACCENT_L_MAX, Math.max(ACCENT_L_MIN, color.l)),
    c: Math.min(ACCENT_C_MAX, Math.max(ACCENT_C_MIN, color.c)),
    h: ((color.h % 360) + 360) % 360,
  });
}

/** Sample grid — 16x16 = 256 pixels is plenty for a dominant hue, and cheap. */
export const SAMPLE_GRID = 16;

/** Below this a pixel counts as neutral — poster background, not poster colour. */
const COLOURED_SATURATION = 0.2;

/** One modal-bucket pass over RGBA bytes, ignoring pixels below `minSaturation`. */
function dominantPass(pixels: ArrayLike<number>, minSaturation: number): Rgb | null {
  const sums = new Map<number, { r: number; g: number; b: number; w: number }>();
  let best: { key: number; w: number } | null = null;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3] ?? 0;
    if (a < 128) continue;
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 24 || min > 240) continue; // letterboxing and blown-out white

    const saturation = max === 0 ? 0 : (max - min) / max;
    if (saturation < minSaturation) continue;

    // Within a pass the more saturated pixels still pull the average.
    const weight = 1 + saturation * 3;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bucket = sums.get(key) ?? { r: 0, g: 0, b: 0, w: 0 };
    bucket.r += r * weight;
    bucket.g += g * weight;
    bucket.b += b * weight;
    bucket.w += weight;
    sums.set(key, bucket);
    if (best === null || bucket.w > best.w) best = { key, w: bucket.w };
  }

  if (best === null) return null;
  const winner = sums.get(best.key);
  if (winner === undefined || winner.w === 0) return null;
  return {
    r: Math.round(winner.r / winner.w),
    g: Math.round(winner.g / winner.w),
    b: Math.round(winner.b / winner.w),
  };
}

/**
 * Modal-bucket dominant colour from RGBA bytes (buckets at 3 bits per channel).
 * Coloured pixels are considered first, so one vivid area beats a larger neutral
 * mass — the difference between "this album is teal" and "this album is grey".
 * Only if the artwork has no coloured pixels at all does the neutral pass run,
 * and its grey then fails `clampAccent`, which is the honest answer.
 * Transparent, near-black and near-white pixels never count: otherwise every
 * letterboxed thumbnail resolves to "black".
 */
export function dominantFromPixels(pixels: ArrayLike<number>): Rgb | null {
  return dominantPass(pixels, COLOURED_SATURATION) ?? dominantPass(pixels, 0);
}

/** RGBA bytes → a CSS colour safe to bind to `--accent`. Never throws. */
export function accentFromPixels(pixels: ArrayLike<number>): string {
  const rgb = dominantFromPixels(pixels);
  if (rgb === null) return ARTWORK_FALLBACK_ACCENT;
  return clampAccent(rgbToOklch(rgb)) ?? ARTWORK_FALLBACK_ACCENT;
}

/**
 * Downscale a loaded image to 16x16 and read its dominant colour. Any failure —
 * tainted canvas (the common case for remote artwork), no 2D context, zero-size
 * image — resolves to the aurora accent, silently and synchronously.
 */
export function accentFromImage(image: HTMLImageElement): string {
  try {
    if (image.naturalWidth === 0 || image.naturalHeight === 0) return ARTWORK_FALLBACK_ACCENT;
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_GRID;
    canvas.height = SAMPLE_GRID;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return ARTWORK_FALLBACK_ACCENT;
    ctx.drawImage(image, 0, 0, SAMPLE_GRID, SAMPLE_GRID);
    // Throws SecurityError on a CORS-tainted canvas — expected, not exceptional.
    const { data } = ctx.getImageData(0, 0, SAMPLE_GRID, SAMPLE_GRID);
    return accentFromPixels(data);
  } catch {
    return ARTWORK_FALLBACK_ACCENT;
  }
}

/**
 * Load artwork and resolve its accent. Never rejects: a missing src, a network
 * failure, an SSR call or a tainted canvas all resolve to the aurora accent.
 * `crossOrigin='anonymous'` gives hosts that send CORS headers (most CDNs) a
 * chance to produce a real colour; the rest fall back without a console error.
 */
export function loadArtworkAccent(src: string | null | undefined): Promise<string> {
  if (typeof document === 'undefined' || src === null || src === undefined || src === '') {
    return Promise.resolve(ARTWORK_FALLBACK_ACCENT);
  }
  return new Promise<string>((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(accentFromImage(image));
    image.onerror = () => resolve(ARTWORK_FALLBACK_ACCENT);
    try {
      image.src = src;
    } catch {
      resolve(ARTWORK_FALLBACK_ACCENT);
    }
  });
}
