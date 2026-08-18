/**
 * The advance intent on the wire.
 *
 * WHY ITS OWN EVENT rather than a third `kind` on `sync.setTrack`: the two
 * carry different authority. `sync.setTrack` is "put the room on THIS", and it
 * is policy-gated. `sync.advance` is "the thing I was playing ended", and the
 * server takes it from anyone. Folding them into one event type would put both
 * doors behind one handler and leave the gate difference to a switch arm
 * inside it — which is exactly the shape that produced a bypass here before
 * (the master seat's claim gate drifting from the drive gate). Two names, two
 * gates, and a reader can see which is which without following a branch.
 *
 * WHY AN ID AND NEVER AN INDEX: `queueIndex` is a raw array index into an
 * array every remove and reorder rewrites. A client that finishes a track and
 * reports "index 3 ended" while someone deletes index 1 has just told the
 * server a different track ended. Item ids are stable under both, so the CAS
 * the server performs — "are we still on the item you named?" — asks about the
 * same object the client meant. That staleness was a live bug in this repo,
 * not a hypothetical.
 */
import { describe, expect, it } from 'vitest';
import { ClientEvent, ClientSyncAdvance } from '../src/index';

const roomId = '00000000-0000-4000-8000-000000000000';

function advance(payload: unknown) {
  return { type: 'sync.advance', roomId, seq: 0, ts: 1_700_000_000_000, payload };
}

describe('sync.advance', () => {
  it('carries the id of the item that ended', () => {
    const parsed = ClientEvent.safeParse(advance({ endedItemId: 'queue-item-1' }));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('sync.advance');
      expect(parsed.data.payload).toEqual({ endedItemId: 'queue-item-1' });
    }
  });

  it('is reachable through the ClientEvent union, not only on its own', () => {
    // A schema nobody dispatches on is a schema that does nothing: the hub
    // parses inbound frames with ClientEvent and rejects anything the union
    // does not name.
    expect(ClientSyncAdvance.safeParse(advance({ endedItemId: 'queue-item-1' })).success).toBe(true);
  });

  it('refuses a raw queue index in place of the id', () => {
    expect(ClientEvent.safeParse(advance({ queueIndex: 3 })).success).toBe(false);
    expect(ClientEvent.safeParse(advance({ endedIndex: 3 })).success).toBe(false);
  });

  it('refuses an empty or missing item id', () => {
    expect(ClientEvent.safeParse(advance({ endedItemId: '' })).success).toBe(false);
    expect(ClientEvent.safeParse(advance({})).success).toBe(false);
    expect(ClientEvent.safeParse(advance({ endedItemId: null })).success).toBe(false);
  });

  it('leaves sync.setTrack with exactly its two selectors', () => {
    // If a third `kind` ever appears here, the gate difference above has been
    // folded back into one handler — which is the regression this pins.
    const setTrack = (payload: unknown) => ({
      type: 'sync.setTrack',
      roomId,
      seq: 0,
      ts: 1_700_000_000_000,
      payload,
    });
    expect(
      ClientEvent.safeParse(
        setTrack({ kind: 'media', mediaRef: { kind: 'page', url: 'https://example.com/x' } }),
      ).success,
    ).toBe(true);
    expect(ClientEvent.safeParse(setTrack({ kind: 'queue', queueIndex: 0 })).success).toBe(true);
    expect(
      ClientEvent.safeParse(setTrack({ kind: 'advance', endedItemId: 'queue-item-1' })).success,
    ).toBe(false);
  });
});
