import type { QueueItem, QueueItemId, UserId } from '@playin/contracts';

/** Immutable snapshot of the shared queue. `version` bumps by exactly 1 per
 *  effective change. */
export interface QueueState {
  items: readonly QueueItem[];
  version: number;
}

/** { items: [], version: 0 } */
export function initialQueueState(): QueueState {
  return { items: [], version: 0 };
}

/** Every mutation the queue supports. */
export type QueueAction =
  | { type: 'add'; item: QueueItem }
  | { type: 'remove'; itemId: QueueItemId }
  | { type: 'reorder'; orderedIds: readonly QueueItemId[] }
  | {
      type: 'voteSkip';
      itemId: QueueItemId;
      userId: UserId;
      /** Injected majority threshold, i.e. floor(activeMembers / 2). The item is
       *  removed when votes STRICTLY exceed this. */
      skipThreshold: number;
      /** Id of the item currently playing, or null. Vote-skip removal only fires on
       *  the current item. */
      currentItemId: QueueItemId | null;
    };

/** True when `ids` is an exact permutation of `items`' ids (same length, same set,
 *  no duplicates). */
function isExactPermutation(
  items: readonly QueueItem[],
  ids: readonly QueueItemId[],
): boolean {
  if (ids.length !== items.length) return false;
  const current = new Set(items.map((it) => it.id));
  const seen = new Set<QueueItemId>();
  for (const id of ids) {
    if (!current.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** Pure reducer for the shared queue. Ineffective/invalid actions return the input
 *  state object unchanged (same reference, version untouched); effective actions
 *  return a new state with version + 1. Inputs are never mutated. */
export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'add': {
      if (state.items.some((it) => it.id === action.item.id)) return state;
      return { items: [...state.items, action.item], version: state.version + 1 };
    }
    case 'remove': {
      if (!state.items.some((it) => it.id === action.itemId)) return state;
      return {
        items: state.items.filter((it) => it.id !== action.itemId),
        version: state.version + 1,
      };
    }
    case 'reorder': {
      if (!isExactPermutation(state.items, action.orderedIds)) return state;
      const identical = action.orderedIds.every((id, i) => state.items[i]?.id === id);
      if (identical) return state;
      const byId = new Map(state.items.map((it) => [it.id, it]));
      const items: QueueItem[] = [];
      for (const id of action.orderedIds) {
        const item = byId.get(id);
        if (item) items.push(item);
      }
      return { items, version: state.version + 1 };
    }
    case 'voteSkip': {
      const item = state.items.find((it) => it.id === action.itemId);
      if (!item || item.votesToSkip.includes(action.userId)) return state;
      const newVotes = [...item.votesToSkip, action.userId];
      const remove = action.itemId === action.currentItemId && newVotes.length > action.skipThreshold;
      const items = remove
        ? state.items.filter((it) => it.id !== action.itemId)
        : state.items.map((it) =>
            it.id === action.itemId ? { ...it, votesToSkip: newVotes } : it,
          );
      return { items, version: state.version + 1 };
    }
  }
}
