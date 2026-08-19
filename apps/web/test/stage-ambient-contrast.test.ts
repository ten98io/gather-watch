/**
 * The empty stage's two ambient washes are a CONTRAST BUDGET, not a styling
 * choice, and this is the file StagePane's comment points at.
 *
 * The stage paints a slow conic aurora over the void (DESIGN.md §5.5) and, when
 * nothing at all is on the stage, a second radial bloom of `--aurora-2` under
 * it (§5.1's fallback — an empty room has no artwork to sample). Both sit
 * BEHIND `--text-low`, the measured floor of the whole palette, on the one
 * screen every room shows first. So the pair has to be measured together:
 * either one alone clears AA at values that fail when they are stacked.
 *
 * The model mirrors what the browser composites, in DOM order: the worst aurora
 * stop of the drift onto the void, then the bloom onto that, then `--text-low`
 * on the result. Grain is deliberately not modelled — §4 requires it to carry
 * nothing, so a surface has to be legible without it.
 *
 * Deliberately NOT here: whether the washes look right. That is taste. This
 * only holds them to the bar the rest of the palette is held to, which nothing
 * else can — packages/design/test/palette.test.ts walks token PAIRS and has no
 * way to know two of them are being stacked on one screen.
 */
import { describe, expect, it } from 'vitest';
import type { ThemeName } from '@gather/design';
import {
  THEME_NAMES,
  WCAG_AA_TEXT,
  compositeOver,
  contrastRatio,
  resolveColorToken,
} from '@gather/design';
import { AMBIENT_AURORA_OPACITY, IDLE_BLOOM_OPACITY } from '@/components/stage/StagePane';

/** The conic drift cycles all three stops, so the worst of them is the one
 *  that decides the floor — a wash that only fails a third of the time is a
 *  wash that fails. */
const DRIFT_STOPS = ['aurora1', 'aurora2', 'aurora3'] as const;

/** The bloom is one colour: `--aurora-2`, per StagePane's radial gradient. */
const BLOOM_STOP = 'aurora2' as const;

/** `--text-low` over both washes on the void, at its worst drift stop. */
function ambientFloor(theme: ThemeName, drift: number, bloom: number): number {
  const ground = resolveColorToken(theme, 'bgVoid').hex;
  const low = resolveColorToken(theme, 'textLow').hex;
  return Math.min(
    ...DRIFT_STOPS.map((stop) => {
      const drifted = compositeOver(resolveColorToken(theme, stop).hex, drift, ground);
      const bloomed = compositeOver(resolveColorToken(theme, BLOOM_STOP).hex, bloom, drifted);
      return contrastRatio(low, bloomed);
    }),
  );
}

describe('the empty stage stays readable under its own ambient light', () => {
  it.each(THEME_NAMES)('holds --text-low over both washes on %s', (theme) => {
    expect(ambientFloor(theme, AMBIENT_AURORA_OPACITY, IDLE_BLOOM_OPACITY)).toBeGreaterThanOrEqual(
      WCAG_AA_TEXT,
    );
  });

  /**
   * The values are AT a limit rather than merely under one, and that is the
   * claim worth pinning: without this, a later "make the bloom a bit richer"
   * would look like free headroom. Light is the theme that binds — the washes
   * darken a paper ground toward `--text-low` — and one notch up on each puts
   * it under AA.
   */
  it('is measured, not chosen: one notch richer on each wash fails on light', () => {
    expect(ambientFloor('light', 0.08, 0.16)).toBeLessThan(WCAG_AA_TEXT);
  });

  /** §5.5 pins `.void-aurora` at 5% and the stage's drift is the same wash.
   *  One value written twice is one of them being wrong. */
  it('spends the drift at the opacity DESIGN.md §5.5 names', () => {
    expect(AMBIENT_AURORA_OPACITY).toBe(0.05);
  });
});
