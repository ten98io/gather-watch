/**
 * QueueService: shared-queue authority. add/remove/reorder run through the
 * pure @gather/sync-core queueReducer (version bumps by exactly 1 per
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
 *
 * The queue is BOUNDED, and the bound is physics rather than policy: see
 * QUEUE_MAX_ITEMS below.
 */
import type {
  MediaRef,
  PlaybackState,
  QueueItem,
  QueueItemId,
  QueueItemInput,
  ResolvedMedia,
  RoomId,
  UserId,
} from '@gather/contracts';
import { expectedPositionMs, queueReducer } from '@gather/sync-core';
import type { QueueState } from '@gather/sync-core';
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

/**
 * The largest a `mediaRef` may serialize to. Bounding the item COUNT alone
 * bounds nothing: `z.string().url()` has no length ceiling, so one add could
 * otherwise carry a megabyte of URL (or, via the `embed` kind's `title`, a
 * megabyte of anything). 2048 is the same ceiling artwork URLs already live
 * under in metadata/resolver.ts, and it is well past the longest real
 * watch/listen link.
 */
export const QUEUE_MEDIA_REF_MAX_CHARS = 2048;

/**
 * The largest an item's `artworkUrl` may be. `QueueItem.artworkUrl` is
 * `WebUrl` — `z.string().url()`, no length ceiling — and the queue's item
 * COUNT bounds the number of rows, not their bytes, so this is the second
 * half of the same bound rather than a separate rule.
 *
 * QueueService.add never needed it (sanitizeArtworkUrl already drops anything
 * past 2048), but the playlist→queue copy in ./routes.ts writes the room
 * document DIRECTLY and copied artwork through untouched: 500 rows × a
 * megabyte of artwork is Mongo's 16 MB wall by a road the mediaRef check does
 * not cover. Same 2048 as sanitizeArtworkUrl's URL_MAX, deliberately — one
 * ceiling for artwork, whichever door it arrives at.
 */
export const QUEUE_ARTWORK_URL_MAX_CHARS = 2048;

/**
 * The largest a room's shared queue may grow. A PHYSICS limit — identical for
 * every room, every member and every account, because what it protects is the
 * storage engine, not a price:
 *
 *   • the queue is EMBEDDED on the room document, and a Mongo document may not
 *     exceed 16 MB. Nothing degrades gracefully at that line: the next write
 *     fails outright and the room becomes unusable for everyone in it.
 *   • every mutation rewrites the WHOLE array and emits it again as a
 *     `queue.state` event, so both the document and each event carry the full
 *     queue, and the cost of one person reordering one row is paid by every
 *     member of the room.
 *
 * The arithmetic: a worst-case item is a 2048-char mediaRef
 * (QUEUE_MEDIA_REF_MAX_CHARS) + a 2048-char artwork URL + a 300-char title
 * (both capped in metadata/resolver.ts) + ids and JSON punctuation, so ~5 KB.
 * 500 × 5 KB ≈ 2.5 MB — about a sixth of the document ceiling, which leaves
 * the rest of the room doc, the accumulating skip votes, and the mirrored
 * event document comfortable room. Real queues are nowhere near it: 500 tracks
 * is over 30 hours of music.
 */
export const QUEUE_MAX_ITEMS = 500;

export class QueueService {
  /** In-flight background enrichments; awaited by tests via settleEnrichment. */
  private readonly enriching = new Set<Promise<void>>();

  constructor(private readonly deps: Deps) {}

  /** Append a track to the shared queue (policy-gated). Returns as soon as
   *  the item is stored and broadcast; metadata lands later. */
  async add(roomId: RoomId, userId: UserId, input: QueueItemInput): Promise<void> {
    const { room, member } = await this.loadContext(roomId, userId);
    this.assertQueueControl(room, member);
    if (room.queue.items.length >= QUEUE_MAX_ITEMS) {
      throw new AppError(
        'QUOTA_EXCEEDED',
        `the queue is full (${QUEUE_MAX_ITEMS} items) — remove something to add more`,
      );
    }
    assertQueueItemWithinBounds(input);
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
    await this.persist(room, next);
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
    // source 'link' means nothing was fetched (a stream manifest, an offline
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
    await this.persist(room, { items, version: room.queue.version + 1 });
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
    await this.persist(room, next);
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
    await this.persist(room, next);
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
    //
    // NOT the same question SyncService.advance asks, and do not unify them:
    // a vote is about a ROW ("skip this one"), so a queue nobody has started
    // still has a row to skip. An advance is about a row that was PLAYING, so
    // a room that has never played anything has nothing that can have ENDED —
    // and treating the head as current there would let a member walk an
    // unstarted queue forward. Same words, different questions.
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
    await this.persist(room, { items, version: room.queue.version + 1 });
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
  private async persist(room: RoomDoc, next: QueueState): Promise<void> {
    const queue = { items: [...next.items], version: next.version };
    const prevPlayback = room.playback ?? null;
    const target = realignedQueueIndex(prevPlayback, room.queue.items, queue.items);
    if (target === undefined || prevPlayback === null) {
      await this.deps.store.rooms.updateOne({ id: room.id }, { queue });
      await this.deps.events.emit(room.id, 'queue.state', queue);
      return;
    }
    // A playback snapshot only reaches clients when its seq ADVANCES —
    // applyServerState keeps `prev` unless `next.seq > prev.seq` — so the
    // realignment has to mint a new one from the playback counter, the same
    // one SyncService uses.
    //
    // positionMs and serverTs MOVE TOGETHER OR NOT AT ALL. The pair is an
    // anchor, not two fields: clients project `positionMs + (now - serverTs)`.
    // Re-stamping serverTs while carrying the old positionMs forward silently
    // REWINDS the room by however long the item had been playing — a queue
    // edit would drag every viewer back to where the track was when that
    // snapshot was minted. Projecting the position to the same instant keeps
    // the anchor honest, so this stays what it claims to be: bookkeeping.
    // Nobody seeks, nothing pauses.
    const seq = await this.deps.store.nextSeq(`playback:${room.id}`);
    const now = Date.now();
    const playback: PlaybackState = {
      ...prevPlayback,
      queueIndex: target,
      positionMs: expectedPositionMs(prevPlayback, now),
      seq,
      serverTs: now,
    };
    await this.deps.store.rooms.updateOne({ id: room.id }, { queue, playback });
    await this.deps.events.emit(room.id, 'queue.state', queue);
    await this.deps.events.emit(room.id, 'sync.state', playback);
  }
}

/**
 * Refuse a mediaRef too large to belong on a room document. Measured on the
 * SERIALIZED form rather than field by field, so a new MediaRef kind is
 * covered the day it is added — the one union-widening failure mode an
 * exhaustive switch cannot catch here, because the cost being bounded is
 * bytes, not cases.
 */
export function assertMediaRefWithinBounds(mediaRef: MediaRef): void {
  if (JSON.stringify(mediaRef).length > QUEUE_MEDIA_REF_MAX_CHARS) {
    throw new AppError('VALIDATION', 'media reference is too long to queue');
  }
}

/**
 * Refuse a whole queue item too large to belong on a room document — the ONE
 * door for "may these bytes join a queue", so a caller that writes the room
 * doc without going through QueueService (the playlist copy) cannot enforce a
 * different subset by accident. That is exactly how artwork slipped past: the
 * copy path repeated the count check and the mediaRef check, and simply did
 * not know there was a third.
 *
 * Every unbounded-from-the-client field on a QueueItem is named here. `title`
 * is capped by the contract (max 300) and `durationMs` is a number, so the
 * two that need a ceiling are the ref and the artwork.
 */
export function assertQueueItemWithinBounds(item: {
  mediaRef: MediaRef;
  artworkUrl: string | null;
}): void {
  assertMediaRefWithinBounds(item.mediaRef);
  if (item.artworkUrl !== null && item.artworkUrl.length > QUEUE_ARTWORK_URL_MAX_CHARS) {
    throw new AppError('VALIDATION', 'artwork URL is too long to queue');
  }
}

/**
 * Keeps `playback.queueIndex` pointing at the track that is actually playing.
 *
 * queueIndex is a raw ARRAY INDEX, so every mutation that shifts the array
 * silently repoints it at a different track: delete an item ABOVE the playing
 * one and the index now names the item AFTER it, which is what makes the
 * now-playing highlight jump to the wrong row and the stage title go stale.
 * Reorder scrambles it outright. Nothing in the queue path maintained it.
 *
 * Identity travels by item id, not position: resolve which item the index
 * named BEFORE the mutation, then find where that same item landed after.
 *
 * Returns the corrected index, or `undefined` when there is nothing to do —
 * no playback, no index, an index that already points at the right item, or a
 * previous index that named nothing.
 *
 * When the playing item is REMOVED (a vote-skip of the current track), the
 * honest answer is `null`: playback continues on its own mediaRef and no row
 * claims to be it. Advancing to a successor is a playback decision that
 * belongs to auto-advance, not to queue bookkeeping.
 */
export function realignedQueueIndex(
  playback: PlaybackState | null,
  prevItems: readonly QueueItem[],
  nextItems: readonly QueueItem[],
): number | null | undefined {
  const at = playback?.queueIndex;
  if (playback === null || at === null || at === undefined) return undefined;
  const playingId = prevItems[at]?.id;
  if (playingId === undefined) return undefined;
  const found = nextItems.findIndex((it) => it.id === playingId);
  if (found === at) return undefined;
  return found === -1 ? null : found;
}
