/**
 * Chat domain service: message lifecycle (send/edit/delete/react/pin),
 * ephemeral signals (typing, emote bursts), and read/delivered cursors.
 *
 * Every public method re-reads membership from the store (roles can change
 * mid-connection) and emits through Deps.events — persisted events get their
 * EVENT seq from the hub (scope `room:<id>`); MESSAGE seq is a separate
 * counter this service owns (scope `chat:<roomId>`).
 */
import type {
  ClientChatSend,
  ClientEmoteBurst,
  ListMessagesQuery,
  ListMessagesResponse,
  MemberRole,
  Message,
  MessageId,
  ReadCursor,
  RoomId,
  RoomPolicyLevel,
  UserId,
} from '@playin/contracts';
import { AppError, isAppError } from '../../lib/errors';
import { newId } from '../../lib/tokens';
import { cursorDocId, memberDocId } from '../../adapters/ports';
import type { CursorDoc, Filter, MemberDoc, RoomDoc } from '../../adapters/ports';
import type { AuthContext, Deps } from '../types';
import { extractMentions } from './mentions';
import type { MentionCandidate } from './mentions';
import { SlidingWindowLimiter } from './limiter';
import { createNotifier } from './notify';
import type { NotifyPort } from './notify';

export class ChatService {
  private readonly notifier: NotifyPort;
  private readonly typingLimiter = new SlidingWindowLimiter(1, 2000);
  private readonly emoteLimiter = new SlidingWindowLimiter(5, 1000);

  constructor(
    private readonly deps: Deps,
    notifier?: NotifyPort,
  ) {
    this.notifier = notifier ?? createNotifier(deps);
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────

  /** Fresh membership row — roles change mid-connection, never trust ctx. */
  private async freshMember(roomId: RoomId, userId: UserId): Promise<MemberDoc> {
    const member = await this.deps.store.members.findById(memberDocId(roomId, userId));
    if (member === null) {
      throw new AppError('FORBIDDEN', 'not a member');
    }
    if (member.banned) {
      throw new AppError('FORBIDDEN', 'banned');
    }
    return member;
  }

  private async getRoom(roomId: RoomId): Promise<RoomDoc> {
    const room = await this.deps.store.rooms.findById(roomId);
    if (room === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    return room;
  }

  private roleSatisfies(level: RoomPolicyLevel, role: MemberRole): boolean {
    if (level === 'everyone') {
      return true;
    }
    if (level === 'mods') {
      return role === 'host' || role === 'moderator';
    }
    return role === 'host';
  }

  private requireChatPolicy(room: RoomDoc, role: MemberRole): void {
    if (!this.roleSatisfies(room.policies.chat, role)) {
      throw new AppError('ROOM_POLICY', 'room policy does not allow you to chat');
    }
  }

  private isMod(role: MemberRole): boolean {
    return role === 'host' || role === 'moderator';
  }

  private async getMessage(roomId: RoomId, messageId: MessageId): Promise<Message> {
    const message = await this.deps.store.messages.findById(messageId);
    if (message === null || message.roomId !== roomId) {
      throw new AppError('NOT_FOUND', 'message not found');
    }
    return message;
  }

  /** Mention candidates = the room's members with their display names. */
  private async mentionCandidates(roomId: RoomId): Promise<MentionCandidate[]> {
    const members = await this.deps.store.members.findMany({ roomId });
    const candidates: MentionCandidate[] = [];
    for (const member of members) {
      const user = await this.deps.store.users.findById(member.userId);
      if (user !== null) {
        candidates.push({ userId: member.userId, displayName: user.displayName });
      }
    }
    return candidates;
  }

  /** Latest Message.seq in the room (0 when empty) — the cursor clamp tip. */
  private async tipSeq(roomId: RoomId): Promise<number> {
    const latest = await this.deps.store.messages.findMany(
      { roomId },
      { sort: [['seq', -1]], limit: 1 },
    );
    return latest[0]?.seq ?? 0;
  }

  /**
   * Forward-only cursor upsert. Returns advanced=false (and emits nothing)
   * when the stored cursor is already at or beyond `lastSeq`.
   */
  private async advanceCursor(
    roomId: RoomId,
    userId: UserId,
    kind: CursorDoc['kind'],
    lastSeq: number,
  ): Promise<{ at: number; advanced: boolean }> {
    const id = cursorDocId(roomId, userId, kind);
    const existing = await this.deps.store.cursors.findById(id);
    if (existing !== null && existing.lastSeq >= lastSeq) {
      return { at: existing.at, advanced: false };
    }
    const at = Date.now();
    if (existing !== null) {
      await this.deps.store.cursors.updateOne({ id }, { lastSeq, at });
      return { at, advanced: true };
    }
    try {
      await this.deps.store.cursors.insertOne({ id, roomId, userId, kind, lastSeq, at });
    } catch (err) {
      // Insert race with a concurrent advance — fall back to update.
      if (!isAppError(err) || err.code !== 'CONFLICT') {
        throw err;
      }
      const raced = await this.deps.store.cursors.findById(id);
      if (raced !== null && raced.lastSeq >= lastSeq) {
        return { at: raced.at, advanced: false };
      }
      await this.deps.store.cursors.updateOne({ id }, { lastSeq, at });
    }
    return { at, advanced: true };
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async send(
    roomId: RoomId,
    auth: AuthContext,
    payload: ClientChatSend['payload'],
  ): Promise<Message> {
    const member = await this.freshMember(roomId, auth.userId);
    const room = await this.getRoom(roomId);
    this.requireChatPolicy(room, member.role);

    if (
      payload.kind === 'voice' &&
      (payload.attachment === null || payload.attachment.durationMs === null)
    ) {
      throw new AppError('VALIDATION', 'voice notes require attachment.durationMs');
    }

    if (payload.replyTo !== null) {
      try {
        await this.getMessage(roomId, payload.replyTo);
      } catch (err) {
        if (isAppError(err) && err.code === 'NOT_FOUND') {
          throw new AppError('VALIDATION', 'replyTo message not found');
        }
        throw err;
      }
    }

    const candidates = await this.mentionCandidates(roomId);
    const mentions = extractMentions(payload.body, payload.mentions, candidates);

    const seq = await this.deps.store.nextSeq(`chat:${roomId}`);
    const message: Message = {
      id: newId() as MessageId,
      roomId,
      authorId: auth.userId,
      kind: payload.kind,
      body: payload.body, // markdown-lite stored RAW — sanitizing is a client concern
      gifUrl: payload.gifUrl,
      attachment: payload.attachment,
      replyTo: payload.replyTo,
      mentions,
      reactions: {},
      pinned: false,
      editedAt: null,
      deletedAt: null,
      seq,
      createdAt: Date.now(),
    };
    await this.deps.store.messages.insertOne(message);
    await this.deps.events.emit(roomId, 'chat.message', message);

    // Mention push is fire-and-forget — it must never block or fail a send.
    const targets = mentions.filter((userId) => userId !== auth.userId);
    if (targets.length > 0) {
      void this.notifier
        .mention({
          roomId,
          messageId: message.id,
          fromUserId: auth.userId,
          toUserIds: targets,
          preview: payload.body,
        })
        .catch((err: unknown) => {
          this.deps.log.warn({ err }, 'mention push failed');
        });
    }

    return message;
  }

  async edit(
    roomId: RoomId,
    auth: AuthContext,
    messageId: MessageId,
    body: string,
  ): Promise<Message> {
    await this.freshMember(roomId, auth.userId);
    const message = await this.getMessage(roomId, messageId);
    if (message.deletedAt !== null) {
      throw new AppError('CONFLICT', 'message was deleted');
    }
    if (message.authorId !== auth.userId) {
      // Even host/moderators cannot edit someone else's words.
      throw new AppError('FORBIDDEN', 'only the author can edit a message');
    }
    const candidates = await this.mentionCandidates(roomId);
    const mentions = extractMentions(body, message.mentions, candidates);
    const updated = await this.deps.store.messages.updateOne(
      { id: messageId },
      { body, mentions, editedAt: Date.now() },
    );
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'message not found');
    }
    await this.deps.events.emit(roomId, 'chat.updated', updated);
    return updated;
  }

  async remove(
    roomId: RoomId,
    auth: AuthContext,
    messageId: MessageId,
  ): Promise<{ messageId: MessageId; deletedAt: number }> {
    const member = await this.freshMember(roomId, auth.userId);
    const message = await this.getMessage(roomId, messageId);
    if (message.deletedAt !== null) {
      // Idempotent: no re-emit for an already-tombstoned message.
      return { messageId, deletedAt: message.deletedAt };
    }
    if (message.authorId !== auth.userId && !this.isMod(member.role)) {
      throw new AppError('FORBIDDEN', 'only the author or a moderator can delete a message');
    }
    const now = Date.now();
    await this.deps.store.messages.updateOne(
      { id: messageId },
      {
        body: '',
        gifUrl: null,
        attachment: null,
        mentions: [],
        reactions: {},
        pinned: false,
        deletedAt: now,
      },
    );
    await this.deps.events.emit(roomId, 'chat.deleted', { messageId, deletedAt: now });
    return { messageId, deletedAt: now };
  }

  async react(
    roomId: RoomId,
    auth: AuthContext,
    messageId: MessageId,
    emoji: string,
    op: 'add' | 'remove',
  ): Promise<void> {
    const member = await this.freshMember(roomId, auth.userId);
    // Chat policy gates ALL persisted chat writes: in a 'mods'-chat room a
    // plain member must not broadcast via reactions either. Typing signals
    // and read/delivered cursors stay ungated on purpose — they are
    // ephemeral/private-ish state, not content (documented decision).
    const room = await this.getRoom(roomId);
    this.requireChatPolicy(room, member.role);
    const message = await this.getMessage(roomId, messageId);
    if (message.deletedAt !== null) {
      throw new AppError('CONFLICT', 'message was deleted');
    }
    const reactions: Record<string, UserId[]> = { ...message.reactions };
    const current = reactions[emoji] ?? [];
    const has = current.includes(auth.userId);
    if ((op === 'add' && has) || (op === 'remove' && !has)) {
      return; // nothing changed — no write, no event
    }
    const next =
      op === 'add'
        ? [...current, auth.userId]
        : current.filter((userId) => userId !== auth.userId);
    if (next.length === 0) {
      delete reactions[emoji];
    } else {
      reactions[emoji] = next;
    }
    await this.deps.store.messages.updateOne({ id: messageId }, { reactions });
    await this.deps.events.emit(roomId, 'chat.reaction', {
      messageId,
      emoji,
      userId: auth.userId,
      op,
    });
  }

  async pin(
    roomId: RoomId,
    auth: AuthContext,
    messageId: MessageId,
    pinned: boolean,
  ): Promise<Message> {
    const member = await this.freshMember(roomId, auth.userId);
    if (!this.isMod(member.role)) {
      throw new AppError('FORBIDDEN', 'pinning requires moderator');
    }
    const message = await this.getMessage(roomId, messageId);
    if (message.deletedAt !== null) {
      throw new AppError('CONFLICT', 'message was deleted');
    }
    if (message.pinned === pinned) {
      return message; // no-op pin state — no write, no event
    }
    const updated = await this.deps.store.messages.updateOne({ id: messageId }, { pinned });
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'message not found');
    }
    await this.deps.events.emit(roomId, 'chat.updated', updated);
    return updated;
  }

  // ── Ephemeral signals (no persistence, drops are silent) ──────────────────

  typing(roomId: RoomId, auth: AuthContext, typing: boolean): void {
    // typing:false always passes — stop signals must not be lost.
    if (typing && !this.typingLimiter.allow(`${roomId}:${auth.userId}`)) {
      return;
    }
    this.deps.events.emitEphemeral(roomId, 'chat.typing', { userId: auth.userId, typing });
  }

  emote(roomId: RoomId, auth: AuthContext, payload: ClientEmoteBurst['payload']): void {
    if (!this.emoteLimiter.allow(`${roomId}:${auth.userId}`)) {
      return;
    }
    this.deps.events.emitEphemeral(roomId, 'emote.burst', {
      userId: auth.userId,
      emoji: payload.emoji,
      xPct: payload.xPct,
      yPct: payload.yPct,
    });
  }

  // ── Read / delivered cursors ───────────────────────────────────────────────

  async read(roomId: RoomId, auth: AuthContext, lastReadSeq: number): Promise<void> {
    const seq = Math.min(lastReadSeq, await this.tipSeq(roomId));
    const read = await this.advanceCursor(roomId, auth.userId, 'read', seq);
    if (!read.advanced) {
      return;
    }
    const cursor: ReadCursor = { roomId, userId: auth.userId, lastReadSeq: seq, at: read.at };
    await this.deps.events.emit(roomId, 'chat.read', cursor);
    // Invariant: delivered >= read — pull the delivered cursor up if behind.
    const deliveredDoc = await this.deps.store.cursors.findById(
      cursorDocId(roomId, auth.userId, 'delivered'),
    );
    if (deliveredDoc === null || deliveredDoc.lastSeq < seq) {
      const delivered = await this.advanceCursor(roomId, auth.userId, 'delivered', seq);
      if (delivered.advanced) {
        await this.deps.events.emit(roomId, 'chat.delivered', {
          userId: auth.userId,
          lastDeliveredSeq: seq,
          at: delivered.at,
        });
      }
    }
  }

  async delivered(roomId: RoomId, auth: AuthContext, lastDeliveredSeq: number): Promise<void> {
    const seq = Math.min(lastDeliveredSeq, await this.tipSeq(roomId));
    const delivered = await this.advanceCursor(roomId, auth.userId, 'delivered', seq);
    if (!delivered.advanced) {
      return;
    }
    await this.deps.events.emit(roomId, 'chat.delivered', {
      userId: auth.userId,
      lastDeliveredSeq: seq,
      at: delivered.at,
    });
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async listMessages(
    roomId: RoomId,
    query: ListMessagesQuery,
  ): Promise<ListMessagesResponse> {
    const filter: Filter<Message> =
      query.beforeSeq === undefined
        ? { roomId }
        : { roomId, seq: { $lt: query.beforeSeq } };
    // Fetch one extra row to learn whether a next page exists. Tombstones
    // (deletedAt set) ARE included — clients render the placeholder.
    const rows = await this.deps.store.messages.findMany(filter, {
      sort: [['seq', -1]],
      limit: query.limit + 1,
    });
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > query.limit && last !== undefined ? String(last.seq) : null;
    return { items, nextCursor };
  }

  async search(roomId: RoomId, q: string, limit: number): Promise<Message[]> {
    return this.deps.store.searchMessages(roomId, q, limit);
  }

  async listPinned(roomId: RoomId): Promise<Message[]> {
    return this.deps.store.messages.findMany(
      { roomId, pinned: true, deletedAt: null },
      { sort: [['seq', -1]] },
    );
  }
}
