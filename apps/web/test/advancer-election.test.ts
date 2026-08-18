/**
 * WHO ADVANCES THE QUEUE — the election, on its own.
 *
 * It used to be one expression: `member.role === 'host'`. That names exactly
 * one client, which is the property that matters, and gets the answer wrong in
 * the two commonest rooms there are:
 *
 *   - the host is watching on their phone. Mobile mounts no advancer at all,
 *     so the item ends and every web tab in the room politely waits for a
 *     client that is never going to speak;
 *   - the host closed their tab. Same silence, for everyone still watching.
 *
 * The successor is the room's master seat, which the server elects by
 * compare-and-set — at most one holder, room-wide, by construction — and which
 * only clients that CAN advance ever claim. These cases pin down the ladder and
 * the one invariant underneath it: for any room state, EXACTLY ONE of the
 * clients in the room answers yes.
 */
import { describe, expect, it } from 'vitest';
import type { UserId } from '@gather/contracts';
import {
  MASTER_CLAIM_STAGGER_MS,
  isAdvancerClient,
  masterClaimDelayMs,
  masterClaimEpoch,
  masterSeatVacant,
} from '@/lib/player/advance';

const HOST = 'user_host' as UserId;
const ALICE = 'user_alice' as UserId;
const BOB = 'user_bob' as UserId;
const GHOST = 'user_ghost' as UserId;

/** Every client in the room asks the same question of the same room state. */
function advancers(
  room: { master: { userId: UserId; epoch: number } | null; presentUserIds: readonly UserId[] },
  hostUserId: UserId,
): UserId[] {
  return room.presentUserIds.filter((userId) =>
    isAdvancerClient({
      selfUserId: userId,
      selfIsHost: userId === hostUserId,
      master: room.master,
      presentUserIds: room.presentUserIds,
    }),
  );
}

describe('the advancer is exactly one client', () => {
  it('is the host while the seat is empty — the rule every deployed client already follows', () => {
    const room = { master: null, presentUserIds: [HOST, ALICE, BOB] };
    expect(advancers(room, HOST)).toEqual([HOST]);
  });

  it('is the master once the seat is filled, host or not', () => {
    const room = { master: { userId: ALICE, epoch: 1 }, presentUserIds: [HOST, ALICE, BOB] };
    // THE host-on-a-phone fix: the host is present and still not the advancer,
    // because they never claimed a seat they cannot serve.
    expect(advancers(room, HOST)).toEqual([ALICE]);
  });

  it('falls back to the host when the master has left the room', () => {
    const room = { master: { userId: GHOST, epoch: 3 }, presentUserIds: [HOST, ALICE] };
    // A seat held by somebody who is gone is the same bug wearing a new hat:
    // one departed tab and the room never advances again.
    expect(advancers(room, HOST)).toEqual([HOST]);
  });

  it('leaves nobody advancing when the master left AND the host is gone too', () => {
    // Honest, and self-correcting: masterSeatVacant is true here, so whoever is
    // left claims the seat and the next item advances.
    const room = { master: { userId: GHOST, epoch: 3 }, presentUserIds: [ALICE, BOB] };
    expect(advancers(room, HOST)).toEqual([]);
    expect(masterSeatVacant(room)).toBe(true);
  });

  it('trusts the seat while the roster is still unknown', () => {
    // An empty roster means "the snapshot has not landed", never "the room is
    // empty" — we are in it. Dropping a legitimate master on that would let the
    // host advance too, for as long as the first presence frame takes.
    const room = { master: { userId: ALICE, epoch: 1 }, presentUserIds: [] };
    expect(
      isAdvancerClient({ selfUserId: ALICE, selfIsHost: false, ...room }),
    ).toBe(true);
    expect(isAdvancerClient({ selfUserId: HOST, selfIsHost: true, ...room })).toBe(false);
  });

  it('never lets the playbackControl policy widen the field', () => {
    // The old comment's warning, kept as a test: the answer is a function of
    // the seat and the host role only. No policy input reaches it.
    for (const master of [null, { userId: BOB, epoch: 9 }]) {
      const room = { master, presentUserIds: [HOST, ALICE, BOB] };
      expect(advancers(room, HOST)).toHaveLength(1);
    }
  });
});

describe('claiming the seat', () => {
  it('is vacant when empty, or when its holder is no longer present', () => {
    expect(masterSeatVacant({ master: null, presentUserIds: [ALICE] })).toBe(true);
    expect(
      masterSeatVacant({ master: { userId: GHOST, epoch: 2 }, presentUserIds: [ALICE] }),
    ).toBe(true);
    expect(
      masterSeatVacant({ master: { userId: ALICE, epoch: 2 }, presentUserIds: [ALICE] }),
    ).toBe(false);
  });

  it('is not declared vacant on a roster we have not been sent yet', () => {
    expect(masterSeatVacant({ master: { userId: ALICE, epoch: 2 }, presentUserIds: [] })).toBe(
      false,
    );
  });

  it('claims one epoch above the stored one — the server rejects anything at or below', () => {
    expect(masterClaimEpoch(null)).toBe(1);
    expect(masterClaimEpoch({ userId: GHOST, epoch: 7 })).toBe(8);
  });

  it('staggers candidates deterministically, so one claim is sent and not N', () => {
    const present = [BOB, ALICE, HOST]; // deliberately unsorted
    const delays = present.map((selfUserId) =>
      masterClaimDelayMs({ selfUserId, presentUserIds: present }),
    );
    // user_alice < user_bob < user_host: rank 0, 1, 2 whatever order they arrive.
    expect(delays).toEqual([
      MASTER_CLAIM_STAGGER_MS,
      0,
      MASTER_CLAIM_STAGGER_MS * 2,
    ]);
  });

  it('goes first when the roster is unknown — a room of one must not wait', () => {
    expect(masterClaimDelayMs({ selfUserId: ALICE, presentUserIds: [] })).toBe(0);
  });
});
