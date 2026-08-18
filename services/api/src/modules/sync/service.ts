/**
 * SyncService: server-side playback authority. Every playback mutation is
 * gated on the room's playbackControl policy, computed from the persisted
 * PlaybackState snapshot (positions projected with @gather/sync-core), stamped
 * with a dedicated per-room playback seq, persisted on the room doc, and
 * emitted as `sync.state` so late joiners and WS-fallback clients converge via
 * event replay. Also arbitrates master epochs, the waitForAll policy toggle,
 * and the in-memory buffering aggregation behind `sync.waiting`.
 *
 * Pure logic over Deps — the module's wsHandlers are a thin dispatch layer.
 */
import type {
  ClientSyncSetTrack,
  PlaybackState,
  QueueItem,
  RoomId,
  UserId,
} from '@gather/contracts';
import { expectedPositionMs } from '@gather/sync-core';
import { memberDocId } from '../../adapters/ports';
import type { MemberDoc, RoomDoc } from '../../adapters/ports';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/tokens';
import type { Deps } from '../types';
import { recordPlayback } from '../rooms/history';
import { getRoomsRuntime } from '../rooms/runtime';
import { policyAllows } from './policy';
import { serializeRoom } from './serialize';

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
   * The mesh elects; the server arbitrates.
   *
   * WHO MAY CLAIM: exactly the members the room's `playbackControl` policy
   * admits, and nobody else — the same gate `sync.play`/`pause`/`seek` pass.
   * The seat used to be ungated whenever it was EMPTY (which is how every room
   * starts) and the holder then drove playback unconditionally, so one
   * `sync.claimMaster` bought a plain member the control a 'host' room had
   * explicitly denied them. Tying the claim to the policy makes the seat
   * useless as a bypass while leaving it fully usable: under 'everyone' — what
   * a room wanting client-driven auto-advance sets — every member is eligible,
   * so mesh re-election works exactly as designed, and under 'host'/'mods' the
   * eligible set is precisely the people who were always allowed to drive.
   *
   * WHAT IT GRANTS: coordination, not authority. The seat names who is
   * responsible for advancing the room; it never widens what its holder may
   * do, so tightening the policy takes control back from a sitting master
   * immediately (see assertPlaybackControl).
   *
   * The claimed epoch must be newer than the stored one, but the SERVER owns
   * the stored value: the seat advances to stored+1 via compare-and-set on
   * the previous master (same CAS pattern as rooms/master.ts — adapters match
   * embedded docs structurally, key order { userId, epoch } kept exact). An
   * injected Number.MAX_SAFE_INTEGER therefore cannot lock the seat forever,
   * and a lost CAS race means exactly one winner per epoch — no split-brain.
   */
  async claimMaster(roomId: RoomId, userId: UserId, epoch: number): Promise<void> {
    const { room, member } = await this.loadContext(roomId, userId);
    // THE SEAT AND THE DRIVE SHARE ONE PREDICATE — deliberately the same call,
    // not two copies of the same idea.
    //
    // The client makes the seat holder the SOLE advancer and every other tab
    // stands down. So a seat held by someone the policy forbids to drive is
    // strictly worse than an empty seat: their setTrack is refused and NOBODY
    // else tries. That is exactly what happened when these two were allowed to
    // drift apart — the claim was ungated while the drive stayed policy-gated,
    // and in a default 'host' room the first guest to mount won the seat and
    // the queue never moved again.
    //
    // Gating on `mayDrive` keeps the seat fillable in the case that motivated
    // un-gating it (a host on a phone, or gone: privilegedHolderAbsent opens
    // it to everyone) while making "holds the seat" and "may advance" the same
    // question by construction.
    if (!(await this.mayDrive(room, member))) {
      throw new AppError('ROOM_POLICY', 'playback control not allowed');
    }
    const stored = room.master;
    const storedEpoch = stored?.epoch ?? 0;
    if (stored !== null && epoch <= storedEpoch) {
      throw new AppError('CONFLICT', 'stale master epoch');
    }
    const next = { userId, epoch: storedEpoch + 1 };
    const updated = await this.deps.store.rooms.updateOne(
      { id: roomId, master: stored ?? null },
      { master: next },
    );
    if (updated === null) {
      // Lost the CAS race — someone else claimed this epoch first.
      throw new AppError('CONFLICT', 'stale master epoch');
    }
    await this.deps.events.emit(roomId, 'sync.masterChanged', {
      masterUserId: userId,
      epoch: next.epoch,
    });
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
   * The policy is the ONLY gate. Holding the master seat deliberately grants
   * nothing extra: only policy-holders can take the seat in the first place
   * (see claimMaster), and a stored master row must not outlive the policy
   * that made it claimable — otherwise a host who tightens playbackControl
   * mid-session finds the previous master still driving, and a role demotion
   * silently keeps its old powers.
   */
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

  /** The ONE predicate for "may this member drive the room". Both the drive
   *  gate and the master claim call it, so the seat can never name a client
   *  whose setTrack would be refused. */
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

  private async mutate(
    roomId: RoomId,
    userId: UserId,
    kind: MutationKind,
    payload: MutationPayload,
  ): Promise<void> {
    const { room, member } = await this.loadContext(roomId, userId);
    await this.assertPlaybackControl(room, member);

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
    // playback snapshots on clients.
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
    await this.deps.store.rooms.updateOne({ id: roomId }, { playback: state });

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
