import { describe, it, expect } from 'vitest';
import { SeqTracker } from '../src/replay';

describe('SeqTracker', () => {
  it('accepts the first seq for a room and initializes expectedNext', () => {
    const t = new SeqTracker();
    expect(t.expectedNext('r')).toBeNull();
    expect(t.accept('r', 5)).toEqual({ status: 'ok' });
    expect(t.expectedNext('r')).toBe(6);
    expect(t.pendingGaps('r')).toEqual([]);
  });

  it('accepts an in-order sequence and advances expectedNext', () => {
    const t = new SeqTracker();
    t.accept('r', 5);
    expect(t.accept('r', 6)).toEqual({ status: 'ok' });
    expect(t.accept('r', 7)).toEqual({ status: 'ok' });
    expect(t.accept('r', 8)).toEqual({ status: 'ok' });
    expect(t.expectedNext('r')).toBe(9);
  });

  it('reports a gap when a seq skips ahead', () => {
    const t = new SeqTracker();
    for (const seq of [5, 6, 7, 8]) t.accept('r', seq);
    expect(t.accept('r', 12)).toEqual({
      status: 'gap',
      gap: { missingFrom: 9, missingTo: 11 },
    });
    expect(t.expectedNext('r')).toBe(13);
    expect(t.pendingGaps('r')).toEqual([{ missingFrom: 9, missingTo: 11 }]);
  });

  it('tracks late fills: splits, shrinks, and clears pending gap ranges', () => {
    const t = new SeqTracker();
    for (const seq of [5, 6, 7, 8, 12]) t.accept('r', seq);

    // Filling the middle splits [9,11] into [9,9] and [11,11].
    expect(t.accept('r', 10)).toEqual({ status: 'ok' });
    expect(t.pendingGaps('r')).toEqual([
      { missingFrom: 9, missingTo: 9 },
      { missingFrom: 11, missingTo: 11 },
    ]);

    expect(t.accept('r', 9)).toEqual({ status: 'ok' });
    expect(t.accept('r', 11)).toEqual({ status: 'ok' });
    expect(t.pendingGaps('r')).toEqual([]);

    // Once consumed, seq 9 is a plain duplicate.
    expect(t.accept('r', 9)).toEqual({ status: 'duplicate' });
  });

  it('rejects re-accepting an already-consumed seq as duplicate', () => {
    const t = new SeqTracker();
    for (const seq of [5, 6, 7, 8]) t.accept('r', seq);
    expect(t.accept('r', 7)).toEqual({ status: 'duplicate' });
    expect(t.accept('r', 5)).toEqual({ status: 'duplicate' });
    expect(t.expectedNext('r')).toBe(9);
  });

  it('tracks rooms independently', () => {
    const t = new SeqTracker();
    expect(t.accept('a', 5)).toEqual({ status: 'ok' });
    expect(t.accept('b', 100)).toEqual({ status: 'ok' });
    expect(t.accept('a', 6)).toEqual({ status: 'ok' });
    expect(t.expectedNext('a')).toBe(7);
    expect(t.expectedNext('b')).toBe(101);
    expect(t.accept('b', 105)).toEqual({
      status: 'gap',
      gap: { missingFrom: 101, missingTo: 104 },
    });
    expect(t.expectedNext('b')).toBe(106);
    expect(t.expectedNext('a')).toBe(7);
    expect(t.pendingGaps('a')).toEqual([]);
    expect(t.pendingGaps('b')).toEqual([{ missingFrom: 101, missingTo: 104 }]);
  });

  it('reset(room) drops state; the next accept re-initializes', () => {
    const t = new SeqTracker();
    t.accept('r', 5);
    t.accept('r', 6);
    t.reset('r');
    expect(t.expectedNext('r')).toBeNull();
    expect(t.pendingGaps('r')).toEqual([]);
    expect(t.accept('r', 42)).toEqual({ status: 'ok' });
    expect(t.expectedNext('r')).toBe(43);
  });

  it('treats invalid seqs (negative, non-integer, NaN) as duplicates with no state change', () => {
    const t = new SeqTracker();
    expect(t.accept('r', -1)).toEqual({ status: 'duplicate' });
    expect(t.accept('r', 1.5)).toEqual({ status: 'duplicate' });
    expect(t.accept('r', NaN)).toEqual({ status: 'duplicate' });
    // No room was ever initialized.
    expect(t.expectedNext('r')).toBeNull();

    // Same for an existing room: state is untouched.
    expect(t.accept('r', 5)).toEqual({ status: 'ok' });
    expect(t.accept('r', -3)).toEqual({ status: 'duplicate' });
    expect(t.accept('r', 2.5)).toEqual({ status: 'duplicate' });
    expect(t.expectedNext('r')).toBe(6);
    expect(t.pendingGaps('r')).toEqual([]);
  });
});
