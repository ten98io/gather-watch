/**
 * SyncService: server-side playback authority. Every playback mutation is
 * gated on the room's playbackControl policy, computed from the persisted
 * PlaybackState snapshot (positions projected with @gather/sync-core), stamped
 * with a dedicated per-room playback seq, persisted on the room doc, and
 * emitted as `sync.state` so late joiners and WS-fallback clients converge via
 * event replay. Also owns the waitForAll policy toggle and the in-memory
 * buffering aggregation behind `sync.waiting`.
 *
 * ONE mutation is deliberately not policy-gated: `advance`, the end-of-track
 * intent. It is a compare-and-set on the playback snapshot rather than a
 * request to drive, and it is what replaced the master seat as the way a room
 * moves on. What stands in for the policy there is the room's own clock: the
 * server checks that the item could plausibly have ENDED before it moves on
 * from it — see its doc comment.
 *
 * Pure logic over Deps — the module's wsHandlers are a thin dispatch layer.
 */
import type {
  ClientSyncSetTrack,
  PlaybackState,
  QueueItem,
  QueueItemId,
  RoomId,
  UserId,
} from '@gather/contracts';
import { expectedPositionMs } from '@gather/sync-core';
import { memberDocId } from '../../adapters/ports';
import type { MemberDoc, RoomDoc } from '../../adapters/ports';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/tokens';
import type { Deps } from '../types';
import { assertMediaRefWithinBounds } from '../queue/service';
import { recordPlayback } from '../rooms/history';
import { getRoomsRuntime } from '../rooms/runtime';
import { policyAllows } from './policy';
import { serializeRoom } from '../rooms/serialize';

/**
 * How far short of a KNOWN `durationMs` still counts as an ending — the slack
 * between the room's projected position and the item's stated runtime.
 *
 * IT ONLY HAS TO ABSORB ERROR IN ONE DIRECTION. The projection is wall-clock
 * elapsed at `rate` since the snapshot, and a real player can only fall BEHIND
 * that (buffering, a slow start, a stall), so an honest client reaching its own
 * end finds the projection at or PAST `durationMs`. What the grace is for is
 * the opposite: a `durationMs` that over-states the media — a resolved runtime
 * that counted trailing credits the file does not have, a different cut, an
 * oEmbed answer for a slightly different upload.
 *
 * Sixty seconds, and never more than a quarter of the item, so short rows do
 * not become free (a quarter of a 30-second clip is 7.5s of real waiting, not
 * a 60-second window that swallows the whole thing). Erring generous is
 * deliberate: a refusal is SILENT and the client fires once per item, so the
 * cost of refusing a genuine ending is a room sitting on a finished track,
 * while the cost of accepting an early one is a member skipping the last
 * minute of something they already sat through the rest of.
 */
export const ADVANCE_END_GRACE_MS = 60_000;
export const ADVANCE_END_GRACE_FRACTION = 0.25;

/**
 * The only thing that can be asked of an item with NO known duration: that the
 * room's own clock has actually run this far into it.
 *
 * Honest and limited, and worth saying plainly — with no duration the server
 * cannot know where the end is, so this branch does not verify an ending at
 * all. It prices one: a member walking a queue of duration-unknown rows must
 * let each row genuinely PLAY for twenty seconds first (the projection is the
 * media clock, so a paused room accumulates nothing), which turns an instant,
 * unobservable ten-row walk into a slow one that everybody in the room watches
 * happen and can act on. It does not make that walk impossible.
 *
 * Twenty seconds sits under anything a room plausibly watches to the end — the
 * short formats people actually queue run past it — because the failure it
 * would cause is the expensive one: an item shorter than the floor can never
 * be advanced past by a member the policy does not admit.
 */
export const ADVANCE_UNKNOWN_DURATION_FLOOR_MS = 20_000;

/** Mutations that drive the shared playback clock. */
type MutationKind = 'play' | 'pause' | 'seek' | 'rate' | 'setTrack';

// `| undefined` on optionals: contracts payloads come from zod `.optional()`,
// which under exactOptionalPropertyTypes includes undefined explicitly.
interface MutationPayload {
  positionMs?: number | undefined;
  rate?: number | undefined;
  track?: ClientSyncSetTrack['payload'] | undefined;
}

export class SyncService {
  /** roomId → userIds currently reporting buffering. In-memory only: the
   *  set is pruned against locally-connected sockets before every read, so
   *  disconnected users can never block playback. */
  private readonly buffering = new Map<string, Set<string>>();

  constructor(private readonly deps: Deps) {}

  async play(
    roomId: RoomId,
    userId: UserId,
    payload: { positionMs?: number | undefined },
  ): Promise<void> {
    await this.mutate(roomId, userId, 'play', payload);
  }

  async pause(
    roomId: RoomId,
    userId: UserId,
    payload: { positionMs?: number | undefined },
  ): Promise<void> {
    await this.mutate(roomId, userId, 'pause', payload);
  }

  async seek(roomId: RoomId, userId: UserId, payload: { positionMs: number }): Promise<void> {
    await this.mutate(roomId, userId, 'seek', payload);
  }

  async setRate(roomId: RoomId, userId: UserId, payload: { rate: number }): Promise<void> {
    await this.mutate(roomId, userId, 'rate', payload);
  }

  async setTrack(
    roomId: RoomId,
    userId: UserId,
    payload: ClientSyncSetTrack['payload'],
  ): Promise<void> {
    await this.mutate(roomId, userId, 'setTrack', { track: payload });
  }

  /**
   * "The item I was playing has ENDED — move the room on from it."
   *
   * NOT a request to drive, and deliberately not gated like one. Advancing at
   * the end of a track is the queue doing the one thing a queue is for, so
   * this takes the intent from ANY non-banned member: no policy check, no
   * master seat, no presence inference about who "should" be advancing. That
   * inference is what this replaces — it was wrong in every ordinary topology
   * (a host watching on a phone, a host who transferred the role, a room where
   * nobody present holds the policy), and each room it was wrong about stopped
   * dead on a finished track with no way back.
   *
   * COMPARE-AND-SET, in two halves:
   *
   *   COMPARE — the room must still be on `endedItemId`. A mismatch returns
   *   SILENTLY. That is not leniency: every client that was playing fires this
   *   on 'ended', so all but the first necessarily arrive after the room has
   *   moved, and answering each straggler with an error frame would put an
   *   error on every socket in the room on every single track change.
   *
   *   SET — the write is conditional on the exact playback snapshot that was
   *   read (see applyMutation's `expect`), so simultaneous advances produce
   *   ONE move: the first lands, the rest write nothing at all. No election is
   *   needed to pick a winner because losing is free.
   *
   * WHERE IT CANNOT GO. The client's id is used ONLY as the compare operand —
   * never to choose a destination. The destination is `queue.items[at + 1]`
   * where `at` is the server's own `playback.queueIndex`, so the reachable set
   * for one accepted advance is exactly {successor of the item the room is
   * currently on}, and for a REJECTED one it is empty. Naming any other item —
   * the one after next, the last row, something not in the queue — moves
   * nothing. No jump, no going back, no seek, no pause mid-track, no naming a
   * mediaRef; manual play/pause/seek/rate/setTrack stay exactly as
   * policy-gated as they were.
   *
   * THAT BOUND IS REAL AND IT IS NOT ENOUGH. This comment used to finish the
   * paragraph above by calling the result "the same ground a member can
   * already cover with `queue.voteSkip`". That was FALSE, and the difference
   * is the whole reason the check below exists: voteSkip drops a row only once
   * a fraction of the presence-alive members have agreed on it, and advance
   * asks nobody. One plain member in a `playbackControl: 'host'` room, naming
   * each row as it became current, walked a ten-item queue from the first row
   * to the last and stopped the room — ten calls, no votes, no policy. Walking
   * one row at a time is not a limit when the rows can be walked as fast as
   * frames arrive.
   *
   * SO THE ROOM'S CLOCK PAYS FOR IT. "It ended" is a claim about the world,
   * and the server holds enough of the world to test it: `playback` projects
   * where the media actually is (`endingIsPlausible`), and an advance from
   * someone the policy does NOT admit is taken only while that projection
   * agrees an ending was possible. What a member can reach is unchanged — the
   * successor, and nothing else — but reaching it now costs the item's own
   * remaining runtime rather than one frame, which is the difference between
   * a queue moving on and a queue being skipped.
   *
   * Members the policy DOES admit are not checked at all: they can setTrack
   * anywhere already, so constraining their advance would protect nothing and
   * would slow down the clients most likely to be driving the room.
   *
   * A refusal is SILENT, for the same reason a stale id is (above): the client
   * it lands on is usually honest — its copy of the item ran ahead of the
   * room's clock — and it fires once per item, so an error frame would scold
   * a client that did nothing wrong while telling a griefer exactly what to
   * wait for.
   *
   * WHAT A WRONG REFUSAL COSTS, stated without flattery. The web client reports
   * an ending ONCE per item (StagePane's `advancedKeyRef`), so a refused room
   * is not retried into motion by the client that was refused; it waits for
   * another client's copy to end, or for a hand. Usually there is one in the
   * room — `mayDrive` only leaves a member constrained while someone the policy
   * admits is present — but not always: `privilegedHolderAbsent` deliberately
   * reads an EMPTY presence map as an outage rather than an empty room, so
   * during a presence outage every member is constrained at once. That is why
   * both branches below are tuned to accept, not to catch.
   */
  async advance(roomId: RoomId, userId: UserId, endedItemId: QueueItemId): Promise<void> {
    // Membership and the ban check; the policy is deliberately not consulted
    // here (see below — it is consulted only to WAIVE the clock check).
    const { room, member } = await this.loadContext(roomId, userId);
    const playback = room.playback;
    // Nothing is playing FROM THE QUEUE, so nothing that has a successor can
    // have ended. Narrower than queue voteSkip's notion of "current", which
    // also counts the head of a queue nobody has started: a vote is about a
    // row, this is about a row that was playing.
    if (playback === null || playback.queueIndex === null) return;
    const at = playback.queueIndex;
    const current = room.queue.items[at];
    if (current === undefined || current.id !== endedItemId) return;

    // The clock check, and the one thing that waives it. Ordered so the cheap
    // local arithmetic runs first: `mayDrive` costs a presence read plus the
    // member list, and the overwhelmingly common advance is a genuine ending
    // that never needs to ask. This covers BOTH outcomes below — the stop at
    // the end of the queue is a pause, and pause is policy-gated for exactly
    // the member this is protecting the room from.
    if (!this.endingIsPlausible(playback, current) && !(await this.mayDrive(room, member))) {
      return;
    }

    const next = room.queue.items[at + 1];
    if (next === undefined) {
      // END OF THE QUEUE: stop where we are, never wrap to the top. Stopping
      // means telling everyone so — leaving `playing: true` on a finished
      // track leaves every player showing a stuck playhead and every late
      // joiner being told to play something that is over. Already stopped is
      // already correct, so the straggler who arrives second writes nothing.
      if (!playback.playing) return;
      await this.applyMutation(room, userId, 'pause', {}, playback);
      return;
    }
    await this.applyMutation(
      room,
      userId,
      'setTrack',
      { track: { kind: 'queue', queueIndex: at + 1 } },
      playback,
    );
  }

  /** Host/mods toggle the wait-for-all policy; the room broadcast carries the
   *  serialized contracts Room (never the RoomDoc snapshots). */
  async setWaitForAll(roomId: RoomId, userId: UserId, enabled: boolean): Promise<void> {
    const { room, member } = await this.loadContext(roomId, userId);
    if (!policyAllows('mods', member.role)) {
      throw new AppError('ROOM_POLICY', 'waitForAll control not allowed');
    }
    const updated = await this.deps.store.rooms.updateOne(
      { id: roomId },
      { policies: { ...room.policies, waitForAll: enabled } },
    );
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    await this.deps.events.emit(roomId, 'room.updated', serializeRoom(updated));
    // Enabling while members are already buffering must immediately hold
    // playback for the room.
    if (enabled) {
      const waitingOn = this.prunedBuffering(roomId);
      if (waitingOn.length > 0) {
        this.deps.events.emitEphemeral(roomId, 'sync.waiting', { waitingOn });
      }
    }
  }

  /** Track buffering reporters per room; with waitForAll on, every report
   *  re-broadcasts the (pruned) waiting list — empty means everyone ready. */
  async setBuffering(roomId: RoomId, userId: UserId, buffering: boolean): Promise<void> {
    const { room } = await this.loadContext(roomId, userId);
    let set = this.buffering.get(roomId);
    if (set === undefined) {
      set = new Set<string>();
      this.buffering.set(roomId, set);
    }
    if (buffering) {
      set.add(userId);
    } else {
      set.delete(userId);
    }
    if (!room.policies.waitForAll) return;
    this.deps.events.emitEphemeral(roomId, 'sync.waiting', {
      waitingOn: this.prunedBuffering(roomId),
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Common preamble: room must exist; membership is re-read from the store
   *  (roles/bans can change mid-connection — never trust ctx.member). */
  private async loadContext(
    roomId: RoomId,
    userId: UserId,
  ): Promise<{ room: RoomDoc; member: MemberDoc }> {
    const room = await this.deps.store.rooms.findById(roomId);
    if (room === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    const member = await this.deps.store.members.findById(memberDocId(roomId, userId));
    if (member === null) {
      throw new AppError('FORBIDDEN', 'not a member');
    }
    if (member.banned) {
      throw new AppError('FORBIDDEN', 'banned');
    }
    return { room, member };
  }

  /**
   * Who may drive playback. The policy decides — except that a policy naming
   * people who are NOT HERE would freeze the room forever: a 'host' room whose
   * host is on a phone or has closed their tab can never advance, seek or
   * pause again, and the queue sits on a finished item for everyone.
   *
   * So the privileged set falls back while it is absent, exactly as an absent
   * host's screen share becomes takeable (see restream's releaseIfHostGone —
   * same reasoning, same presence source). Nothing is granted permanently: the
   * moment a privileged member is present again the fallback stops applying,
   * which is why this is re-evaluated per mutation rather than cached.
   */
  private async assertPlaybackControl(room: RoomDoc, member: MemberDoc): Promise<void> {
    if (await this.mayDrive(room, member)) return;
    throw new AppError('ROOM_POLICY', 'playback control not allowed');
  }

  /** The ONE predicate for "may this member drive the room". The hand-driven
   *  gate asserts it; `advance` reads it to decide whether the clock check
   *  applies, so "need not prove the item ended" and "may set the track by
   *  hand" are the same set of people by construction. */
  private async mayDrive(room: RoomDoc, member: MemberDoc): Promise<boolean> {
    if (policyAllows(room.policies.playbackControl, member.role)) return true;
    return this.privilegedHolderAbsent(room);
  }

  /**
   * True when NOBODY the policy names is present. Deliberately false when the
   * room looks empty (no presence entries at all): that is a presence outage
   * or a cold read, not evidence the host left, and opening control on it
   * would hand the room away every time presence hiccuped.
   */
  private async privilegedHolderAbsent(room: RoomDoc): Promise<boolean> {
    const present = new Set(
      getRoomsRuntime(this.deps)
        .presence.entries(room.id)
        .filter((entry) => entry.state !== 'offline')
        .map((entry) => entry.userId),
    );
    if (present.size === 0) return false;
    const members = await this.deps.store.members.findMany({ roomId: room.id });
    return !members.some(
      (m) =>
        present.has(m.userId) &&
        !m.banned &&
        policyAllows(room.policies.playbackControl, m.role),
    );
  }

  /**
   * "Could the item the room is on plausibly have ENDED just now?"
   *
   * The evidence is the room's own playback snapshot projected to now — the
   * media clock, not wall clock, so a paused room accumulates nothing and a
   * room at 2x accumulates twice as fast. Two branches, and they are honestly
   * different in strength:
   *
   *   DURATION KNOWN — the projection has to have reached the end, minus a
   *   grace (see ADVANCE_END_GRACE_MS for which direction of error that grace
   *   is for). This genuinely verifies the claim: the cost of a skip is the
   *   item's whole remaining runtime, and it scales with the item, so a queue
   *   of ten films cannot be walked in under ten films.
   *
   *   DURATION UNKNOWN — nullable on QueueItem and null for most YouTube rows,
   *   so this branch carries the common case and CANNOT be a policy fallback:
   *   refusing every unresolved row would put back the exact freeze this
   *   mechanism exists to remove (a host present but watching on a phone
   *   leaves every other client unable to move the room on). With no end to
   *   aim at there is nothing to verify, so this prices the claim instead —
   *   see ADVANCE_UNKNOWN_DURATION_FLOOR_MS, which states plainly what remains
   *   possible here.
   *
   * FAIL-OPEN IS THE SAFE DIRECTION and this is written to lean that way. A
   * false accept is one row skipped by a member who sat through the rest of
   * it; a false refuse strands the room on a finished item, silently, until a
   * human intervenes.
   */
  private endingIsPlausible(playback: PlaybackState, current: QueueItem): boolean {
    const projected = expectedPositionMs(playback, Date.now());
    const durationMs = current.durationMs;
    // Zero is not a duration, it is a resolver that found nothing; treating it
    // as known would make every such row advanceable from position 0.
    if (durationMs === null || durationMs <= 0) {
      return projected >= ADVANCE_UNKNOWN_DURATION_FLOOR_MS;
    }
    const grace = Math.min(ADVANCE_END_GRACE_MS, durationMs * ADVANCE_END_GRACE_FRACTION);
    return projected >= durationMs - grace;
  }

  /** A playback mutation someone asked for by hand: policy-gated, then
   *  applied unconditionally. */
  private async mutate(
    roomId: RoomId,
    userId: UserId,
    kind: MutationKind,
    payload: MutationPayload,
  ): Promise<void> {
    const { room, member } = await this.loadContext(roomId, userId);
    await this.assertPlaybackControl(room, member);
    await this.applyMutation(room, userId, kind, payload);
  }

  /**
   * Mint the next playback snapshot, persist it, broadcast it, and log it.
   *
   * THE GATE IS NOT HERE. Each caller answers "who may do this" for itself —
   * `mutate` with the playbackControl policy, `advance` with the CAS below —
   * so this function is only ever the mechanism, never the authority.
   *
   * `expect` turns the write into a COMPARE-AND-SET on the previous playback
   * snapshot: it lands only while the room is still in exactly that state, and
   * a loser returns false having written NOTHING — no event, no usage row, no
   * room history. Omit it and the write is unconditional, which is what a
   * hand-driven mutation wants (a host pressing pause must not lose to
   * somebody else's concurrent seek).
   *
   * The match is structural on the whole embedded snapshot — the same CAS
   * shape claimMaster uses on `master`, and it carries the same constraint:
   * Mongo compares embedded documents including KEY ORDER, so this is only
   * sound because the value passed back is the one `findById` returned,
   * untouched. Never rebuild it.
   */
  private async applyMutation(
    room: RoomDoc,
    userId: UserId,
    kind: MutationKind,
    payload: MutationPayload,
    expect?: PlaybackState,
  ): Promise<boolean> {
    const roomId = room.id;
    const now = Date.now();
    const prev = room.playback;
    const base = prev === null ? 0 : expectedPositionMs(prev, now);

    let mediaRef = prev?.mediaRef ?? null;
    let positionMs = base;
    let rate = prev?.rate ?? 1;
    let playing = prev?.playing ?? false;
    let queueIndex = prev?.queueIndex ?? null;
    // The queue row this setTrack named, when it named one — the only place
    // the server ever learns a track's title and who queued it.
    let started: QueueItem | null = null;

    switch (kind) {
      case 'play':
        positionMs = payload.positionMs ?? base;
        playing = true;
        break;
      case 'pause':
        positionMs = payload.positionMs ?? base;
        playing = false;
        break;
      case 'seek':
        positionMs = payload.positionMs ?? base;
        break;
      case 'rate':
        rate = payload.rate ?? rate;
        break;
      case 'setTrack': {
        if (payload.track === undefined) break;
        if (payload.track.kind === 'media') {
          // A room document is not a place to put arbitrary client bytes.
          // This ref is persisted on the room, mirrored into a REPLAYABLE
          // event, a usage row and the room's playback history, and `WebUrl`
          // is `z.string().url()` with no length ceiling — so one frame could
          // otherwise carry a megabyte and be replayed to every member of the
          // room forever after. Same ceiling the queue enforces: one answer to
          // "may these bytes land on a room", whichever event carries them.
          // (The 'queue' branch below takes its ref from a stored item, which
          // passed the identical check on the way in.)
          assertMediaRefWithinBounds(payload.track.mediaRef);
          mediaRef = payload.track.mediaRef;
          queueIndex = null;
        } else {
          const item = room.queue.items[payload.track.queueIndex];
          if (item === undefined) {
            throw new AppError('VALIDATION', 'queueIndex out of range');
          }
          mediaRef = item.mediaRef;
          queueIndex = payload.track.queueIndex;
          started = item;
        }
        positionMs = 0;
        break;
      }
    }

    // Separate counter from the room event seq: PlaybackState.seq orders
    // playback snapshots on clients. A CAS loser burns one — harmless, because
    // clients only ever ask whether a snapshot is NEWER than the one they
    // hold (applyServerState keeps `prev` unless `next.seq > prev.seq`), so
    // the sequence must be monotonic, not gapless.
    const seq = await this.deps.store.nextSeq(`playback:${roomId}`);
    const state: PlaybackState = {
      mediaRef,
      positionMs,
      rate,
      playing,
      serverTs: now,
      seq,
      queueIndex,
    };
    const written = await this.deps.store.rooms.updateOne(
      expect === undefined ? { id: roomId } : { id: roomId, playback: expect },
      { playback: state },
    );
    // Lost the compare-and-set: somebody else already moved the room on from
    // the state this was computed against. Everything below is a side effect
    // of a move that did not happen, so there is nothing left to do — and
    // nothing to report, because losing this race is the ordinary case.
    if (expect !== undefined && written === null) {
      return false;
    }

    // Playback history for GDPR export — rate changes are not transitions.
    // Separate row, separate question: this one is per-USER and per-account
    // lifetime, and is read only by compliance/export.ts.
    if (kind !== 'rate') {
      await this.deps.store.usage.insertOne({
        id: newId(),
        userId,
        roomId,
        kind: 'playback.history',
        amount: state.positionMs,
        unit: 'ms',
        at: now,
        meta: { mediaRef: state.mediaRef, startedAt: now, positionMs: state.positionMs },
      });
    }

    await this.deps.events.emit(roomId, 'sync.state', state);

    // The room's own playback history (rooms/history.ts owns retention and
    // the read). Only a TRACK CHANGE goes in: play/pause/seek move the
    // playhead, they do not answer "what did we watch".
    //
    // AFTER the broadcast on purpose: the emit is what actually switches
    // everyone's player, and no viewer should wait on a log entry to see the
    // next track start. recordPlayback swallows its own failures and drops a
    // repeat of the same media, so this can neither fail a play nor spam the
    // panel.
    if (kind === 'setTrack' && mediaRef !== null) {
      await recordPlayback(this.deps, {
        roomId,
        mediaRef,
        title: started?.title ?? 'Untitled',
        artworkUrl: started?.artworkUrl ?? null,
        durationMs: started?.durationMs ?? null,
        // No queue row means nobody queued it — the person who set it is the
        // honest answer, not a blank.
        queuedBy: started?.addedBy ?? userId,
        startedBy: userId,
      });
    }
    return true;
  }

  /** The room's buffering reporters, minus anyone without a live local socket. */
  private prunedBuffering(roomId: RoomId): UserId[] {
    const set = this.buffering.get(roomId);
    if (set === undefined) return [];
    const connected = new Set<string>(this.deps.hub.localUserIds(roomId));
    for (const userId of set) {
      if (!connected.has(userId)) {
        set.delete(userId);
      }
    }
    return [...set] as UserId[];
  }
}
