/**
 * Per-room sequence tracker for gap detection + dedupe on the multiplexed room WS.
 * Server seqs are positive, monotonically increasing integers per room, but a client
 * may attach mid-stream (first observed seq can be anything).
 *
 * Pending gaps are stored as sorted, disjoint { from, to } ranges — never enumerated
 * per-seq — so a huge gap costs O(ranges), not O(gap size).
 */

/** A fully-inclusive range of missing seqs [missingFrom, missingTo]. */
export interface SeqGap {
  missingFrom: number;
  missingTo: number;
}

/** Outcome of reporting one observed seq. */
export type SeqAcceptResult =
  | { status: 'ok' }
  | { status: 'duplicate' }
  | { status: 'gap'; gap: SeqGap };

interface GapRange {
  from: number;
  to: number;
}

interface RoomState {
  expectedNext: number;
  gaps: GapRange[];
}

/** Insert a new missing range [from, to] keeping `gaps` sorted and disjoint. */
function insertGap(gaps: GapRange[], from: number, to: number): void {
  let i = 0;
  while (i < gaps.length && (gaps[i]?.from ?? 0) < from) i += 1;
  gaps.splice(i, 0, { from, to });
}

/** Remove `seq` from a pending range, shrinking or splitting it as needed. */
function fillGap(gaps: GapRange[], seq: number): void {
  const i = gaps.findIndex((g) => g.from <= seq && seq <= g.to);
  const g = gaps[i];
  if (!g) return;
  if (g.from === g.to) {
    gaps.splice(i, 1);
  } else if (seq === g.from) {
    g.from = seq + 1;
  } else if (seq === g.to) {
    g.to = seq - 1;
  } else {
    gaps.splice(i, 1, { from: g.from, to: seq - 1 }, { from: seq + 1, to: g.to });
  }
}

/** Tracks per-room expected-next seq plus pending gap ranges. */
export class SeqTracker {
  private readonly rooms = new Map<string, RoomState>();

  /** Report an observed seq for a room. */
  accept(roomId: string, seq: number): SeqAcceptResult {
    if (!Number.isInteger(seq) || seq < 0) {
      return { status: 'duplicate' };
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      this.rooms.set(roomId, { expectedNext: seq + 1, gaps: [] });
      return { status: 'ok' };
    }

    if (seq === room.expectedNext) {
      room.expectedNext = seq + 1;
      return { status: 'ok' };
    }

    if (seq > room.expectedNext) {
      const gap: SeqGap = { missingFrom: room.expectedNext, missingTo: seq - 1 };
      insertGap(room.gaps, gap.missingFrom, gap.missingTo);
      room.expectedNext = seq + 1;
      return { status: 'gap', gap };
    }

    // seq < expectedNext: late/replayed event or plain duplicate.
    if (room.gaps.some((g) => g.from <= seq && seq <= g.to)) {
      fillGap(room.gaps, seq);
      return { status: 'ok' };
    }
    return { status: 'duplicate' };
  }

  /** Next seq we expect for the room, or null if the room has never been seen. */
  expectedNext(roomId: string): number | null {
    return this.rooms.get(roomId)?.expectedNext ?? null;
  }

  /** Seqs previously reported as gaps and not yet filled, as sorted disjoint ranges. */
  pendingGaps(roomId: string): readonly SeqGap[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return room.gaps.map((g) => ({ missingFrom: g.from, missingTo: g.to }));
  }

  /** Drop all state for a room (e.g. on resubscribe-with-snapshot). */
  reset(roomId: string): void {
    this.rooms.delete(roomId);
  }
}
