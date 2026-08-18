/**
 * THE MASTER SEAT IS GONE FROM THE WIRE.
 *
 * `sync.claimMaster` was an ungated-by-design write path — a member could take
 * a persisted, room-wide seat, and for a while holding it was what let you
 * drive playback at all. Auto-advance moved to `sync.advance` (a compare-and-set
 * that reads no destination from the client and needs no seat), which left the
 * claim with ZERO producers anywhere in the monorepo: no app sends it, and
 * MasterElection — the only thing that ever would have — was constructed
 * nowhere outside its own test.
 *
 * A dead mechanism that still accepts writes is worse than dead: the next
 * reader assumes it is load-bearing and builds on it. So the contract is the
 * place to pin the removal — if the event type is not in the union, no client
 * can send it and no server can grow a handler for it by accident.
 *
 * These tests are deliberately negative. They are the guard that keeps the
 * seat from being reintroduced quietly; the positive coverage they replaced
 * lived in schemas.test.ts and was deleted with the events themselves.
 */
import { describe, it, expect } from 'vitest';
import { ClientEvent, ServerEvent } from '../src/ws';

// A client frame carries a LITERAL seq of 0; getting this wrong makes every
// assertion below pass for the wrong reason, so the control test pins it.
const clientEnv = { roomId: 'room_1', seq: 0, ts: 1_700_000_000_000 };
const serverEnv = { roomId: 'room_1', seq: 42, ts: 1_700_000_000_000 };

describe('the master seat is not on the wire', () => {
  it('control: this envelope parses for an event that DOES exist', () => {
    // Without this, a typo in the envelope would make "rejects claimMaster"
    // green while the seat was still fully alive.
    const live = { type: 'sync.buffering', ...clientEnv, payload: { buffering: true } };
    expect(ClientEvent.safeParse(live).success).toBe(true);
  });

  it('ClientEvent rejects sync.claimMaster', () => {
    const evt = { type: 'sync.claimMaster', ...clientEnv, payload: { epoch: 7 } };
    expect(ClientEvent.safeParse(evt).success).toBe(false);
  });

  it('ClientEvent rejects sync.claimMaster with any payload shape', () => {
    // Not merely "the payload is wrong" — the TYPE has no member in the union,
    // so an empty payload, a well-formed one and a garbage one all fail alike.
    for (const payload of [{}, { epoch: 0 }, { epoch: 'x' }, null]) {
      const evt = { type: 'sync.claimMaster', ...clientEnv, payload };
      expect(ClientEvent.safeParse(evt).success).toBe(false);
    }
  });

  it('ServerEvent rejects sync.masterChanged', () => {
    const evt = {
      type: 'sync.masterChanged',
      ...serverEnv,
      payload: { masterUserId: 'user_1', epoch: 7 },
    };
    expect(ServerEvent.safeParse(evt).success).toBe(false);
  });

  it('no exported contract name mentions the master seat', async () => {
    // The schema constants were exported by name; a partial removal that left
    // `ClientSyncClaimMaster` importable would let a caller rebuild the frame
    // by hand and hand it to a socket.
    const mod = (await import('../src/index')) as Record<string, unknown>;
    const leaked = Object.keys(mod).filter((k) => /master/i.test(k));
    expect(leaked).toEqual([]);
  });
});
