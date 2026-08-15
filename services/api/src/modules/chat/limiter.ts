/**
 * In-memory sliding-window rate limiter, keyed per caller-chosen string
 * (e.g. `roomId:userId`). Used for ephemeral chat signals (typing, emotes)
 * where exceeding the budget means DROP SILENTLY, not an error frame.
 */

/** Sliding-window rate limiter (in-memory, per key). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** True = allowed (consumes a slot); false = limited. `now` injectable for tests. */
  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= this.max) {
      // Pruned but still over budget; delete empty keys so the map can't
      // grow unbounded.
      if (recent.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, recent);
      }
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
