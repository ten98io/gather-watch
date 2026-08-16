/**
 * Frame election — with `all_frames: true` the content script runs in every
 * frame of a tab, and on a real site several of them hold a media element
 * (the player iframe, an autoplaying trailer, an ad slot, a sticky preview).
 * Exactly ONE frame may be driven, or the room's seeks fight each other.
 *
 * Each frame reports a claim (its best element's metrics); the background
 * elects a single winner per tab. Pure and unit-tested — the background does
 * bookkeeping only.
 */
import { scoreMedia } from './mediaDriver';
import type { MediaMetrics } from './mediaDriver';

export interface FrameClaim {
  /** chrome's per-tab frame id; 0 is the top frame. */
  frameId: number;
  url: string;
  /** null = this frame has no plausible player right now. */
  metrics: MediaMetrics | null;
  /** epoch ms the claim was received. */
  at: number;
}

/** Claims older than this are treated as gone (frame unloaded silently). */
export const CLAIM_TTL_MS = 20_000;
/**
 * A challenger must beat the incumbent by this factor to take over. Without
 * it, an ad slot that briefly outscores the player steals the drive and the
 * room seeks the wrong element for a few seconds.
 */
export const INCUMBENT_MARGIN = 1.4;

export function claimScore(claim: FrameClaim): number {
  return claim.metrics === null ? 0 : scoreMedia(claim.metrics);
}

/** Claims still worth considering, best first; ties go to the outer frame. */
export function rankClaims(
  claims: readonly FrameClaim[],
  now: number,
): Array<{ claim: FrameClaim; score: number }> {
  return claims
    .filter((c) => now - c.at <= CLAIM_TTL_MS)
    .map((claim) => ({ claim, score: claimScore(claim) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.claim.frameId - b.claim.frameId);
}

/**
 * Pick the one frame to drive. `incumbent` is the currently driven frame (or
 * null) and is defended by INCUMBENT_MARGIN so the choice does not flap.
 */
export function electFrame(
  claims: readonly FrameClaim[],
  opts: { now: number; incumbent: number | null },
): number | null {
  const ranked = rankClaims(claims, opts.now);
  const top = ranked[0];
  if (top === undefined) return null;
  const held = ranked.find((r) => r.claim.frameId === opts.incumbent);
  if (held !== undefined && top.score < held.score * INCUMBENT_MARGIN) {
    return held.claim.frameId;
  }
  return top.claim.frameId;
}

/** Drop expired claims in place; returns true when anything was removed. */
export function pruneClaims(claims: Map<number, FrameClaim>, now: number): boolean {
  let removed = false;
  for (const [frameId, claim] of claims) {
    if (now - claim.at > CLAIM_TTL_MS) {
      claims.delete(frameId);
      removed = true;
    }
  }
  return removed;
}
