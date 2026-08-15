import { describe, it, expect } from 'vitest';
import { initialQueueState, queueReducer } from '../src/queue';
import type { QueueState } from '../src/queue';
import { makeItem, qid, uid } from './fixtures';

/** initialQueueState with items a, b, c added (version 3). */
function stateWith3(): { state: QueueState; itemsBefore: readonly unknown[] } {
  let s = initialQueueState();
  s = queueReducer(s, { type: 'add', item: makeItem('a') });
  s = queueReducer(s, { type: 'add', item: makeItem('b') });
  s = queueReducer(s, { type: 'add', item: makeItem('c') });
  return { state: s, itemsBefore: s.items };
}

describe('queueReducer: add', () => {
  it('appends and bumps version 0 → 1', () => {
    const s0 = initialQueueState();
    expect(s0.version).toBe(0);
    expect(s0.items).toEqual([]);
    const item = makeItem('a');
    const s1 = queueReducer(s0, { type: 'add', item });
    expect(s1.version).toBe(1);
    expect(s1.items).toEqual([item]);
    // Input untouched.
    expect(s0.version).toBe(0);
    expect(s0.items).toHaveLength(0);
  });

  it('ignores a duplicate id (same state reference)', () => {
    const s1 = queueReducer(initialQueueState(), { type: 'add', item: makeItem('a') });
    const s2 = queueReducer(s1, { type: 'add', item: makeItem('a') });
    expect(s2).toBe(s1);
    expect(s2.version).toBe(1);
  });
});

describe('queueReducer: remove', () => {
  it('removes an existing item and bumps the version', () => {
    const { state } = stateWith3();
    const next = queueReducer(state, { type: 'remove', itemId: qid('b') });
    expect(next.version).toBe(4);
    expect(next.items.map((it) => it.id)).toEqual([qid('a'), qid('c')]);
    // Input untouched.
    expect(state.items).toHaveLength(3);
  });

  it('returns the same reference for a missing id', () => {
    const { state } = stateWith3();
    expect(queueReducer(state, { type: 'remove', itemId: qid('zzz') })).toBe(state);
  });
});

describe('queueReducer: reorder', () => {
  it('applies a valid permutation and bumps the version', () => {
    const { state } = stateWith3();
    const next = queueReducer(state, {
      type: 'reorder',
      orderedIds: [qid('c'), qid('a'), qid('b')],
    });
    expect(next.version).toBe(4);
    expect(next.items.map((it) => it.id)).toEqual([qid('c'), qid('a'), qid('b')]);
    // The reordered entries are the same item objects.
    expect(next.items[0]).toBe(state.items[2]);
    expect(next.items[1]).toBe(state.items[0]);
    expect(next.items[2]).toBe(state.items[1]);
  });

  it('rejects invalid reorders with the same reference', () => {
    const { state } = stateWith3();
    // Wrong length.
    expect(
      queueReducer(state, { type: 'reorder', orderedIds: [qid('a'), qid('b')] }),
    ).toBe(state);
    // Unknown id.
    expect(
      queueReducer(state, {
        type: 'reorder',
        orderedIds: [qid('a'), qid('b'), qid('zzz')],
      }),
    ).toBe(state);
    // Duplicate ids in orderedIds.
    expect(
      queueReducer(state, {
        type: 'reorder',
        orderedIds: [qid('a'), qid('a'), qid('b')],
      }),
    ).toBe(state);
    // Identical order is a no-op.
    expect(
      queueReducer(state, {
        type: 'reorder',
        orderedIds: [qid('a'), qid('b'), qid('c')],
      }),
    ).toBe(state);
  });
});

describe('queueReducer: voteSkip', () => {
  it('records a vote below the threshold immutably and bumps the version', () => {
    const item = makeItem('a');
    const votesRef = item.votesToSkip;
    const s1 = queueReducer(initialQueueState(), { type: 'add', item });
    const itemsRef = s1.items;

    const s2 = queueReducer(s1, {
      type: 'voteSkip',
      itemId: qid('a'),
      userId: uid('u1'),
      skipThreshold: 2,
      currentItemId: qid('a'),
    });
    expect(s2.version).toBe(2);
    const updated = s2.items.find((it) => it.id === qid('a'));
    expect(updated?.votesToSkip).toEqual([uid('u1')]);
    expect(updated).not.toBe(item);

    // Original item object and its votes array are untouched.
    expect(item.votesToSkip).toBe(votesRef);
    expect(item.votesToSkip).toHaveLength(0);
    expect(s1.items).toBe(itemsRef);
    expect(s1.items[0]).toBe(item);
  });

  it('ignores a second vote from the same user (same reference)', () => {
    let s = queueReducer(initialQueueState(), { type: 'add', item: makeItem('a') });
    s = queueReducer(s, {
      type: 'voteSkip',
      itemId: qid('a'),
      userId: uid('u1'),
      skipThreshold: 2,
      currentItemId: qid('a'),
    });
    const again = queueReducer(s, {
      type: 'voteSkip',
      itemId: qid('a'),
      userId: uid('u1'),
      skipThreshold: 2,
      currentItemId: qid('a'),
    });
    expect(again).toBe(s);
  });

  it('removes the CURRENT item once votes strictly exceed the threshold', () => {
    // skipThreshold = floor(5 / 2) = 2 → the third distinct vote (3 > 2) removes it.
    let s = queueReducer(initialQueueState(), { type: 'add', item: makeItem('a') });
    s = queueReducer(s, { type: 'add', item: makeItem('b') });
    expect(s.version).toBe(2);

    const vote = (userId: string) =>
      queueReducer(s, {
        type: 'voteSkip',
        itemId: qid('a'),
        userId: uid(userId),
        skipThreshold: 2,
        currentItemId: qid('a'),
      });

    s = vote('u1'); // 1 vote: 1 > 2 false → stays
    expect(s.version).toBe(3);
    expect(s.items.some((it) => it.id === qid('a'))).toBe(true);

    s = vote('u2'); // 2 votes: 2 > 2 false → stays
    expect(s.version).toBe(4);
    expect(s.items.some((it) => it.id === qid('a'))).toBe(true);
    expect(s.items.find((it) => it.id === qid('a'))?.votesToSkip).toHaveLength(2);

    s = vote('u3'); // 3 votes: 3 > 2 → removed
    expect(s.version).toBe(5);
    expect(s.items.some((it) => it.id === qid('a'))).toBe(false);
    expect(s.items.map((it) => it.id)).toEqual([qid('b')]);
  });

  it('records votes on a NON-current item without removing it, even past the threshold', () => {
    let s = queueReducer(initialQueueState(), { type: 'add', item: makeItem('a') });
    s = queueReducer(s, { type: 'add', item: makeItem('b') });

    for (const u of ['u1', 'u2', 'u3']) {
      s = queueReducer(s, {
        type: 'voteSkip',
        itemId: qid('a'),
        userId: uid(u),
        skipThreshold: 2,
        currentItemId: qid('b'),
      });
    }
    expect(s.version).toBe(5); // each vote recorded: +1 per effective action
    const item = s.items.find((it) => it.id === qid('a'));
    expect(item).toBeDefined();
    expect(item?.votesToSkip).toHaveLength(3);
  });

  it('never mutates input state across effective actions', () => {
    const item = makeItem('a');
    let s = queueReducer(initialQueueState(), { type: 'add', item });
    s = queueReducer(s, { type: 'add', item: makeItem('b') });
    const itemsRef = s.items;
    const itemA = s.items[0];
    const itemB = s.items[1];

    const afterVote = queueReducer(s, {
      type: 'voteSkip',
      itemId: qid('a'),
      userId: uid('u1'),
      skipThreshold: 5,
      currentItemId: null,
    });
    expect(s.items).toBe(itemsRef);
    expect(s.items[0]).toBe(itemA);
    expect(s.items[1]).toBe(itemB);
    expect(itemA?.votesToSkip).toHaveLength(0);
    expect(afterVote.items).not.toBe(itemsRef);

    const afterRemove = queueReducer(s, { type: 'remove', itemId: qid('b') });
    expect(s.items).toBe(itemsRef);
    expect(s.items).toHaveLength(2);
    expect(afterRemove.items).toHaveLength(1);
  });
});
