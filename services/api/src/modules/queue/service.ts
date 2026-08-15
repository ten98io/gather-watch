/**
 * QueueService: shared-queue authority. add/remove/reorder run through the
 * pure @playin/sync-core queueReducer (version bumps by exactly 1 per
 * effective change); voteSkip implements the server's own math — a fraction
 * threshold over presence-alive members with stale-vote pruning — which the
 * core reducer deliberately does not model. Every effective mutation is
 * persisted on the room doc and emitted as `queue.state` so late joiners and
 * WS-fallback clients converge via event replay.
 *
 * Pure logic over Deps — the module's wsHandlers are a thin dispatch layer.
 */
import type {
  QueueItem,
  QueueItemId,
  QueueItemInput,
  RoomId,
  UserId,
} from '@playin/contracts';
import { queueReducer } from '@playin/sync-core';
import type { QueueState } from '@playin/sync-core';
import { memberDocId } from '../../adapters/ports';
import type { MemberDoc, RoomDoc } from '../../adapters/ports';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/tokens';
import type { Deps } from '../types';
import { policyAllows } from '../sync/policy';

export class QueueService {
  constructor(private readonly deps: Deps) {}

  /** Append a track to the shared queue (policy-gated). */
  async add(roomId: RoomId, userId: UserId, input: QueueItemInput): Promise<void> {
    const { room, member } = await this.loadContext(roomId, userId);
    this.assertQueueControl(room, member);
    const item: QueueItem = {
      id: newId() as QueueItemId,
      mediaRef: input.mediaRef,
      title: input.title,
      durationMs: input.durationMs,
      artworkUrl: input.artworkUrl,
      addedBy: userId,
      votesToSkip: [],
    };
    const next = queueReducer(this.stateOf(room), { type: 'add', item });
    await this.persist(roomId, next);
  }

  /** Remove by id: policy holders may remove anything; anyone may retract
   *  their own submission. */
  async remove(roomId: RoomId, userId: UserId, itemId: QueueItemId): Promise<void> {
    const { room, member } = await this.loadContext(roomId, userId);
    const item = room.queue.items.find((it) => it.id === itemId);
    if (item === undefined) {
      throw new AppError('NOT_FOUND', 'queue item not found');
    }
    if (!policyAllows(room.policies.queueControl, member.role) && item.addedBy !== userId) {
      throw new AppError('ROOM_POLICY', 'queue control not allowed');
    }
    const next = queueReducer(this.stateOf(room), { type: 'remove', itemId });
    await this.persist(roomId, next);
  }

  /** Replace the order wholesale (policy-gated). orderedIds must be an exact
   *  permutation of the queue; re-ordering to the current order is a silent
   *  no-op (no bump, no emit). */
  async reorder(
    roomId: RoomId,
    userId: UserId,
    orderedIds: readonly QueueItemId[],
  ): Promise<void> {
    const { room, member } = await this.loadContext(roomId, userId);
    this.assertQueueControl(room, member);
    const state = this.stateOf(room);
    const next = queueReducer(state, { type: 'reorder', orderedIds });
    if (next === state) {
      // The reducer returns the SAME reference for an identical order and for
      // a non-permutation alike — disambiguate here.
      const identical =
        orderedIds.length === room.queue.items.length &&
        orderedIds.every((id, i) => room.queue.items[i]?.id === id);
      if (identical) return;
      throw new AppError('VALIDATION', 'orderedIds must be a permutation of the queue');
    }
    await this.persist(roomId, next);
  }

  /** Democratic skip: any non-banned member may vote (no policy gate). Votes
   *  from members without a live socket are pruned before counting; reaching
   *  the configured fraction of presence-alive members removes the CURRENT
   *  item (AT the threshold, not beyond). Threshold 0 disables removal
   *  entirely — votes are still recorded. */
  async voteSkip(roomId: RoomId, userId: UserId, itemId: QueueItemId): Promise<void> {
    const { room } = await this.loadContext(roomId, userId);
    const item = room.queue.items.find((it) => it.id === itemId);
    if (item === undefined) {
      throw new AppError('NOT_FOUND', 'queue item not found');
    }

    const fraction = room.policies.skipVoteThreshold;
    const active = new Set<string>(this.deps.hub.localUserIds(roomId));
    active.add(userId); // the voter is connected by construction — defensive

    const hadVoted = item.votesToSkip.includes(userId);
    const votes = item.votesToSkip.filter((v) => active.has(v));
    if (!votes.includes(userId)) {
      votes.push(userId);
    }
    // Repeat vote with nothing pruned away: silent no-op (no bump, no emit).
    if (
      hadVoted &&
      votes.length === item.votesToSkip.length &&
      votes.every((v, i) => item.votesToSkip[i] === v)
    ) {
      return;
    }

    // With no playback snapshot the head of the queue counts as current.
    const qi = room.playback?.queueIndex;
    const currentItemId =
      (qi !== null && qi !== undefined
        ? room.queue.items[qi]?.id
        : room.queue.items[0]?.id) ?? null;

    const required = Math.max(1, Math.ceil(fraction * active.size));
    const skips = fraction > 0 && item.id === currentItemId && votes.length >= required;
    const items = skips
      ? room.queue.items.filter((it) => it.id !== itemId)
      : room.queue.items.map((it) => (it.id === itemId ? { ...it, votesToSkip: votes } : it));
    await this.persist(roomId, { items, version: room.queue.version + 1 });
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

  private assertQueueControl(room: RoomDoc, member: MemberDoc): void {
    if (!policyAllows(room.policies.queueControl, member.role)) {
      throw new AppError('ROOM_POLICY', 'queue control not allowed');
    }
  }

  private stateOf(room: RoomDoc): QueueState {
    return { items: room.queue.items, version: room.queue.version };
  }

  /** Persist the next queue snapshot on the room doc, then broadcast it. */
  private async persist(roomId: RoomId, next: QueueState): Promise<void> {
    const queue = { items: [...next.items], version: next.version };
    await this.deps.store.rooms.updateOne({ id: roomId }, { queue });
    await this.deps.events.emit(roomId, 'queue.state', queue);
  }
}
