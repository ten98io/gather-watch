/**
 * QueueService: shared-queue authority. add/remove/reorder run through the
 * pure @playin/sync-core queueReducer (version bumps by exactly 1 per
 * effective change); voteSkip implements the server's own math — a fraction
 * threshold over presence-alive members with stale-vote pruning — which the
 * core reducer deliberately does not model. Every effective mutation is
 * persisted on the room doc and emitted as `queue.state` so late joiners and
 * WS-fallback clients converge via event replay.
 *
 * Metadata: what the client sends with an add is a HINT (a URL-derived title,
 * usually no artwork and no duration). It is sanitized, stored immediately so
 * the WS round-trip is never blocked on a third party, and then the real
 * title/artwork/duration are resolved in the BACKGROUND and patched in with a
 * second `queue.state` broadcast. Resolution failures are silent by design.
 *
 * Pure logic over Deps — the module's wsHandlers are a thin dispatch layer.
 */
import type {
  QueueItem,
  QueueItemId,
  QueueItemInput,
  ResolvedMedia,
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
import {
  getMetadataResolver,
  sanitizeArtworkUrl,
  sanitizeDurationMs,
  sanitizeTitle,
} from '../metadata/resolver';
import { policyAllows } from '../sync/policy';

export class QueueService {
  /** In-flight background enrichments; awaited by tests via settleEnrichment. */
  private readonly enriching = new Set<Promise<void>>();

  constructor(private readonly deps: Deps) {}

  /** Append a track to the shared queue (policy-gated). Returns as soon as
   *  the item is stored and broadcast; metadata lands later. */
  async add(roomId: RoomId, userId: UserId, input: QueueItemInput): Promise<void> {
    const { room, member } = await this.loadContext(roomId, userId);
    this.assertQueueControl(room, member);
    const item: QueueItem = {
      id: newId() as QueueItemId,
      mediaRef: input.mediaRef,
      // Client-supplied display data is never trusted verbatim: a title that
      // is only whitespace/control characters, an http (mixed-content) or
      // unparseable artwork URL, or an absurd duration is dropped here.
      title: sanitizeTitle(input.title) ?? 'Untitled',
      durationMs: sanitizeDurationMs(input.durationMs),
      artworkUrl: sanitizeArtworkUrl(input.artworkUrl),
      addedBy: userId,
      votesToSkip: [],
    };
    const next = queueReducer(this.stateOf(room), { type: 'add', item });
    await this.persist(roomId, next);
    this.enrichInBackground(roomId, item);
  }

  /** Resolve the item's real metadata off the critical path and patch it in.
   *  Fire-and-forget: the WS handler never waits on a third-party service. */
  private enrichInBackground(roomId: RoomId, item: QueueItem): void {
    const task = this.enrich(roomId, item)
      .catch((err: unknown) => {
        this.deps.log.debug({ err, roomId, itemId: item.id }, 'queue metadata enrich failed');
      })
      .finally(() => {
        this.enriching.delete(task);
      });
    this.enriching.add(task);
  }

  /** Await every background enrichment started so far (tests only). */
  async settleEnrichment(): Promise<void> {
    while (this.enriching.size > 0) {
      await Promise.all([...this.enriching]);
    }
  }

  private async enrich(roomId: RoomId, item: QueueItem): Promise<void> {
    const resolved: ResolvedMedia | null = await getMetadataResolver(this.deps).resolve({
      mediaRef: item.mediaRef,
    });
    // source 'link' means nothing was fetched (library assets, an offline
    // resolver, a provider we cannot read) — the client's own data stands.
    if (resolved === null || resolved.source === 'link') {
      return;
    }
    // Re-read: the item may have been skipped, removed or reordered while the
    // lookup was in flight, and the queue version has moved on either way.
    const room = await this.deps.store.rooms.findById(roomId);
    if (room === null) {
      return;
    }
    const current = room.queue.items.find((it) => it.id === item.id);
    if (current === undefined) {
      return;
    }
    // Resolved values win over the client's hint; anything the lookup could
    // not determine leaves the stored value alone.
    const title = resolved.title ?? current.title;
    const artworkUrl = resolved.artworkUrl ?? current.artworkUrl;
    const durationMs = resolved.durationMs ?? current.durationMs;
    if (
      current.title === title &&
      current.artworkUrl === artworkUrl &&
      current.durationMs === durationMs
    ) {
      return; // nothing better to say — no bump, no broadcast
    }
    const items = room.queue.items.map((it) =>
      it.id === item.id ? { ...it, title, artworkUrl, durationMs } : it,
    );
    await this.persist(roomId, { items, version: room.queue.version + 1 });
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

    // With no playback snapshot the head of the queue counts as current.
    const qi = room.playback?.queueIndex;
    const currentItemId =
      (qi !== null && qi !== undefined
        ? room.queue.items[qi]?.id
        : room.queue.items[0]?.id) ?? null;

    const required = Math.max(1, Math.ceil(fraction * active.size));
    const skips = fraction > 0 && item.id === currentItemId && votes.length >= required;

    // Repeat vote with nothing pruned away and no skip due: silent no-op (no
    // bump, no emit). The skip check runs FIRST so a vote-set that meets the
    // threshold only after voters disconnected (shrinking `active`) still
    // fires on the next (even repeat) vote instead of sticking forever.
    if (
      !skips &&
      hadVoted &&
      votes.length === item.votesToSkip.length &&
      votes.every((v, i) => item.votesToSkip[i] === v)
    ) {
      return;
    }
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
