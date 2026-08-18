/**
 * Auto-advance — which queue item follows the one that just ended.
 *
 * Pure on purpose (the `stageGate` precedent): the interesting part is not the
 * plumbing, it is deciding what "next" means after the queue has moved under
 * the playing item, and that deserves to be readable and tested on its own.
 *
 * WHY BY ITEM, NOT BY RAW INDEX. `playback.queueIndex` is recorded when the
 * track is set and never revised. Vote-skip removes the playing item from the
 * array and leaves the index alone, so `queueIndex + 1` names the wrong item
 * from the instant anyone skips — it silently skips a second item nobody voted
 * out. So the playing item is located first, and its successor is taken from
 * where it actually sits now.
 *
 * WHO CALLS THIS. Exactly one designated client per room — {@link
 * isAdvancerClient} decides which, and the rest of this file assumes it. With
 * elastic sync viewers deliberately sit at different offsets, so "the video
 * ended" happens at N different moments; if every client advanced, the first to
 * reach the credits would yank everyone else out of the last ten seconds. The
 * resulting setTrack is a HOST INTENT event (docs/EXTENSION_FIRST.md Part 1),
 * so it applies immediately and unbanded on every follower.
 */
import type { MediaRef, QueueItem, UserId } from '@gather/contracts';
import { mediaKey } from './adapter';

/* ── who advances ────────────────────────────────────────────────────────── */

/** The room's elected playback master, as the server last announced it. */
export interface MasterSeat {
  userId: UserId;
  epoch: number;
}

export interface AdvancerInput {
  /** This client's own user id. */
  selfUserId: UserId;
  /** Does this client hold the room's host role? */
  selfIsHost: boolean;
  /** The room's master seat (sync.masterChanged), or null while it is empty. */
  master: MasterSeat | null;
  /**
   * Everyone the room currently lists as present. Server-authoritative and
   * therefore identical on every client, which is what lets each of them reach
   * the same verdict without talking to one another. Empty means "this client
   * has not been told yet", never "the room is empty" — we are in it.
   */
  presentUserIds: readonly UserId[];
}

/**
 * IS THIS CLIENT THE ONE THAT ADVANCES THE QUEUE?
 *
 * This used to be `member.role === 'host'`, full stop, which fails in two ways
 * that leave a room stuck on a finished item forever: the host watching on
 * their phone (mobile mounts no advancer at all), and the host closing their
 * tab while everyone else keeps watching. In both, every remaining client
 * politely waits for a client that will never speak.
 *
 * The seat is the answer. `room.master` is server-elected by compare-and-set
 * (services/api modules/sync/service.ts claimMaster), so it names AT MOST ONE
 * user for the whole room, and only a client that can actually advance ever
 * claims it — see {@link masterSeatVacant}. That is the property presence alone
 * can never supply: presence knows who is here, not which of them mounted a
 * player.
 *
 * A master who has LEFT is not a master. Otherwise the seat becomes the next
 * version of the same bug: one departed tab and nothing advances again. The
 * roster is what says they left, so their absence only counts once we have a
 * roster to read.
 *
 * The fallback is the old rule, and it is deliberately the old rule: it names
 * exactly one client (a room has one host), it is what every deployed client
 * already does, and it only has to hold for the round trip between mounting and
 * the seat being filled.
 */
export function isAdvancerClient(input: AdvancerInput): boolean {
  const { selfUserId, selfIsHost, master, presentUserIds } = input;
  if (master !== null) {
    const rosterKnown = presentUserIds.length > 0;
    if (!rosterKnown || presentUserIds.includes(master.userId)) {
      return master.userId === selfUserId;
    }
  }
  return selfIsHost;
}

/** Is the master seat there for the taking — empty, or held by someone the
 *  room no longer lists as present? */
export function masterSeatVacant(input: {
  master: MasterSeat | null;
  presentUserIds: readonly UserId[];
}): boolean {
  const { master, presentUserIds } = input;
  if (master === null) return true;
  return presentUserIds.length > 0 && !presentUserIds.includes(master.userId);
}

/** The epoch a claim for a vacant seat must name. The server rejects anything
 *  at or below the stored epoch, and mints `stored + 1` on success. */
export function masterClaimEpoch(master: MasterSeat | null): number {
  return (master?.epoch ?? 0) + 1;
}

/** Gap between one candidate's claim and the next's. Long enough for the
 *  winner's sync.masterChanged to come back and stand everyone else down. */
export const MASTER_CLAIM_STAGGER_MS = 750;

/**
 * How long this client waits before claiming a vacant seat.
 *
 * Every capable client is willing to claim, because the one thing that must not
 * happen is a room where nobody is — but they must not all claim at once. The
 * server arbitrates by compare-and-set, so a pile-up is safe; it is merely
 * rude, since every loser is answered with an error frame the room has no use
 * for (and `lastError` is watched elsewhere — a starting screen share reads a
 * stray error as its own failure).
 *
 * So candidates go in a deterministic order — the same sort on every client —
 * and each re-checks that the seat is still empty when its turn comes. In the
 * ordinary case exactly one claim is ever sent. The rest of the queue exists
 * for the case the first candidate cannot claim at all, which is precisely the
 * host-on-a-phone case: they never claim, and 750 ms later the next candidate,
 * who can, does.
 */
export function masterClaimDelayMs(input: {
  selfUserId: UserId;
  presentUserIds: readonly UserId[];
  staggerMs?: number;
}): number {
  const rank = [...input.presentUserIds].sort().indexOf(input.selfUserId);
  return Math.max(0, rank) * (input.staggerMs ?? MASTER_CLAIM_STAGGER_MS);
}

/* ── what plays next ─────────────────────────────────────────────────────── */

export interface AdvanceInput {
  /** Room-authoritative index of the playing item. Null after a setTrack of
   *  kind 'media', which records no index at all. */
  queueIndex: number | null;
  /** The room's queue as it stands NOW — not as it stood when the track was set. */
  items: readonly QueueItem[];
  /** What is playing. Null → nothing to advance from. */
  mediaRef: MediaRef | null;
  /** Is this client the room's single designated advancer? */
  isAdvancer: boolean;
}

/** The item to hand the room, and where it sits in the queue today —
 *  `sync.setTrack { kind: 'queue' }` names the index, so both are needed. */
export interface NextTrack {
  index: number;
  item: QueueItem;
}

/** Media identity ignoring the playback epoch: "is this the same content?". */
function sameMedia(a: MediaRef, b: MediaRef): boolean {
  return mediaKey(a, undefined) === mediaKey(b, undefined);
}

/**
 * The next item to play, or null to let the room simply stop. Null is a real
 * answer, not a failure: the end of the queue must pause, never loop.
 */
export function nextTrackOnEnd(input: AdvanceInput): NextTrack | null {
  const { queueIndex, items, mediaRef, isAdvancer } = input;
  if (!isAdvancer || mediaRef === null) return null;

  const at = (index: number): NextTrack | null => {
    const item = items[index];
    return item === undefined ? null : { index, item };
  };

  // The recorded index still names what is playing → its successor is next.
  // Checked before the search below so a queue holding the same media twice
  // advances from the copy that is actually playing, not from the first one.
  if (queueIndex !== null) {
    const playing = items[queueIndex];
    if (playing !== undefined && sameMedia(playing.mediaRef, mediaRef)) {
      return at(queueIndex + 1);
    }
  }

  // The index is stale (something ahead of us was removed) or was never
  // recorded (a 'media' setTrack). Find the playing item where it sits now.
  const found = items.findIndex((it) => sameMedia(it.mediaRef, mediaRef));
  if (found !== -1) return at(found + 1);

  // The playing item is gone from the queue — vote-skip carried it off while it
  // was still on the stage. Everything after it shifted down by one, so the item
  // now occupying the recorded index IS its successor; `queueIndex + 1` here
  // would skip a second item nobody voted out.
  //
  // Reachable whenever this client still holds the index the item was set at:
  // the server realigns queueIndex in a SEPARATE sync.state after the
  // queue.state that removed it (services/api realignedQueueIndex), so between
  // the two a client legitimately holds the old index against the new queue.
  if (queueIndex !== null) return at(queueIndex);

  // Playing something the queue does not have, with no index to fall back on —
  // a one-off 'media' setTrack, or the realignment above having since nulled
  // the index of a removed item. Nothing here says where the successor is, and
  // guessing (index 0) would restart the queue from the top. Let the room stop.
  return null;
}
