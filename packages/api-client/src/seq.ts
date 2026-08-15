/** Classification of an incoming sequence number relative to the tracker. */
export type SeqClass = 'ephemeral' | 'duplicate' | 'next' | 'gap';

/**
 * Tracks the highest contiguous server sequence number seen for a room
 * stream. Sequence 0 is reserved for ephemeral (unsequenced) events.
 */
export class SeqTracker {
  private last: number;

  constructor(initialSeq?: number) {
    this.last = initialSeq ?? 0;
  }

  /** Highest sequence number seen so far. */
  get lastSeq(): number {
    return this.last;
  }

  /**
   * Classifies `seq`: 0 is ephemeral, `<= lastSeq` is a duplicate,
   * `lastSeq + 1` is the expected next event, anything higher is a gap.
   */
  classify(seq: number): SeqClass {
    if (seq === 0) return 'ephemeral';
    if (seq <= this.last) return 'duplicate';
    if (seq === this.last + 1) return 'next';
    return 'gap';
  }

  /** Advances the tracker to `seq` if it is ahead of the current position. */
  advance(seq: number): void {
    this.last = Math.max(this.last, seq);
  }

  /** Resets the tracker to `seq`. */
  reset(seq: number): void {
    this.last = seq;
  }
}
