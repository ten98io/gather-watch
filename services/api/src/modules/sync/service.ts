/**
 * SyncService: server-side playback authority. Every playback mutation is
 * gated on room policy OR current-master status, computed from the persisted
 * PlaybackState snapshot (positions projected with @gather/sync-core), stamped
 * with a dedicated per-room playback seq, persisted on the room doc, and
 * emitted as `sync.state` so late joiners and WS-fallback clients converge via
 * event replay. Also arbitrates master epochs, the waitForAll policy toggle,
 * and the in-memory buffering aggregation behind `sync.waiting`.
 *
 * Pure logic over Deps — the module's wsHandlers are a thin dispatch layer.
 */
import type { ClientSyncSetTrack, PlaybackState, RoomId, UserId } from '@gather/contracts';
import { expectedPositionMs } from '@gather/sync-core';
import { memberDocId } from '../../adapters/ports';
import type { MemberDoc, RoomDoc } from '../../adapters/ports';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/tokens';
import type { Deps } from '../types';
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
   * The mesh elects; the server arbitrates. Any non-banned member may take a
   * DEAD master's seat (re-election is the whole point of the mesh protocol),
   * but displacing a still-connected master requires the room's
   * playbackControl policy — the master seat drives playback unconditionally,
   * so an ungated claim would be a trivial bypass of that policy.
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
    const stored = room.master;
    const storedEpoch = stored?.epoch ?? 0;
    if (stored !== null && epoch <= storedEpoch) {
      throw new AppError('CONFLICT', 'stale master epoch');
    }
    // Liveness approximation: this instance's sockets (same source
    // prunedBuffering trusts). A master connected elsewhere in a multi-
    // instance deploy re-wins the seat via a newer-epoch re-claim.
    const masterConnected =
      stored !== null &&
      stored.userId !== userId &&
      this.deps.hub.localUserIds(roomId).includes(stored.userId as UserId);
    if (masterConnected && !policyAllows(room.policies.playbackControl, member.role)) {
      throw new AppError('ROOM_POLICY', 'cannot displace a connected master');
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

  /** The current master always drives; everyone else needs the policy. */
  private assertPlaybackControl(room: RoomDoc, member: MemberDoc): void {
    if (room.master?.userId === member.userId) return;
    if (policyAllows(room.policies.playbackControl, member.role)) return;
    throw new AppError('ROOM_POLICY', 'playback control not allowed');
  }

  private async mutate(
    roomId: RoomId,
    userId: UserId,
    kind: MutationKind,
    payload: MutationPayload,
  ): Promise<void> {
    const { room, member } = await this.loadContext(roomId, userId);
    this.assertPlaybackControl(room, member);

    const now = Date.now();
    const prev = room.playback;
    const base = prev === null ? 0 : expectedPositionMs(prev, now);

    let mediaRef = prev?.mediaRef ?? null;
    let positionMs = base;
    let rate = prev?.rate ?? 1;
    let playing = prev?.playing ?? false;
    let queueIndex = prev?.queueIndex ?? null;

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
