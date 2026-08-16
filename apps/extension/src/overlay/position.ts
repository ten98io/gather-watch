/**
 * Where the overlay sits, and how that is remembered per site.
 *
 * Owns: the default corner, the clamp that keeps the panel reachable, the
 * storage key for one site, and the decoder for whatever comes back out of
 * storage.
 *
 * Deliberately NOT: any DOM, and any chrome.storage call. The overlay reaches
 * storage through an injected accessor (see mount.ts), so all of this runs in
 * node with no browser at all.
 *
 * Storage is treated as untrusted input. It is written by an older build, by a
 * different screen size, or by a hand edit of the extension's storage — every
 * one of which can produce a position that would put the panel out of reach.
 */

export interface OverlayPoint {
  x: number;
  y: number;
}

export interface OverlayMemory {
  x: number;
  y: number;
  collapsed: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Kept in step with `.panel { width }` in styles.ts. */
export const PANEL_WIDTH = 320;
export const EDGE_MARGIN = 16;
/**
 * How much of the panel must stay on screen. The header is the drag surface and
 * carries the Hide button, so as long as it is visible the overlay can always be
 * moved or put away — even after the window was resized much smaller.
 */
export const MIN_VISIBLE_HEIGHT = 56;
/** Larger than any real screen; anything beyond it is corrupt, not a position. */
const MAX_COORDINATE = 100_000;
const KEY_PREFIX = 'playin.overlay.v1:';
/** A hostname is page-controlled, so the key it produces is bounded. */
const MAX_SITE_KEY = 100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The top-right corner.
 *
 * Player controls live along the bottom edge (and the fullscreen button in the
 * bottom-right corner specifically), the site's own header is usually on the
 * left, and the centre is the picture. Top-right is the one corner that is
 * normally free on YouTube, Netflix and a plain `<video>` alike.
 */
export function defaultPoint(viewport: Viewport): OverlayPoint {
  return {
    x: Math.max(EDGE_MARGIN, viewport.width - PANEL_WIDTH - EDGE_MARGIN),
    y: EDGE_MARGIN,
  };
}

/** Keep the header on screen whatever the window has done since. */
export function clampPoint(point: OverlayPoint, viewport: Viewport): OverlayPoint {
  const maxX = Math.max(EDGE_MARGIN, viewport.width - PANEL_WIDTH - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, viewport.height - MIN_VISIBLE_HEIGHT);
  return {
    x: Math.round(clamp(point.x, EDGE_MARGIN, maxX)),
    y: Math.round(clamp(point.y, EDGE_MARGIN, maxY)),
  };
}

/**
 * One key per site, so the overlay comes back where it was left on THIS site.
 * A position that suits a Netflix player is in the way on a music site.
 */
export function memoryKey(site: string): string {
  const cleaned = site
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9.:_-]/g, '')
    .slice(0, MAX_SITE_KEY);
  return `${KEY_PREFIX}${cleaned.length > 0 ? cleaned : 'unknown'}`;
}

function coordinate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Math.abs(value) > MAX_COORDINATE) return null;
  return value;
}

/** Decode what storage returned, or null when it is not something we wrote. */
export function readMemory(raw: unknown): OverlayMemory | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const bag = raw as Record<string, unknown>;
  const x = coordinate(bag['x']);
  const y = coordinate(bag['y']);
  if (x === null || y === null) return null;
  return { x, y, collapsed: bag['collapsed'] === true };
}
