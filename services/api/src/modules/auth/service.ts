/**
 * Auth domain logic: magic links, guest joins/upgrades (with merge into an
 * existing account), session lifecycle with refresh-token rotation + reuse
 * detection, and profile updates. Pure logic over Deps.store — no Fastify
 * types in this file, so it is directly unit-testable.
 */
import type { InviteCode, Session, SessionId, UserId } from '@playin/contracts';
import { AppError } from '../../lib/errors';
import { hashToken, newId, randomToken } from '../../lib/tokens';
import { cursorDocId, memberDocId } from '../../adapters/ports';
import type {
  AuthTokenDoc,
  MemberDoc,
  RoomDoc,
  SessionDoc,
  UserDoc,
} from '../../adapters/ports';
import type { Deps } from '../types';

const DEFAULT_ACCENT = '#8b5cf6';

export class AuthService {
  constructor(private readonly deps: Deps) {}

  private now(): number {
    return Date.now();
  }

  /** Create a single-use email token and return it with its verify link. */
  private async createEmailToken(
    kind: AuthTokenDoc['kind'],
    email: string,
    upgradeFromUserId: string | null,
  ): Promise<{ token: string; link: string }> {
    const { config, store } = this.deps;
    const now = this.now();
    const token = randomToken();
    const doc: AuthTokenDoc = {
      id: newId(),
      kind,
      email,
      tokenHash: hashToken(config, token),
      upgradeFromUserId,
      createdAt: now,
      expiresAt: now + config.magicLinkTtlMin * 60_000,
      usedAt: null,
    };
    await store.authTokens.insertOne(doc);
    return { token, link: `${config.appUrl}/auth/verify?token=${token}` };
  }

  /** Issue a magic sign-in link for the (normalized) email. */
  async requestMagicLink(email: string): Promise<{ token: string; link: string }> {
    return this.createEmailToken('magic-link', email.toLowerCase(), null);
  }

  /**
   * Issue a guest-upgrade link. The email may belong to ANOTHER account (the
   * verify step then merges the guest into it); only re-linking the guest's
   * own address is a conflict.
   */
  async requestGuestUpgrade(
    guestUserId: string,
    email: string,
  ): Promise<{ token: string; link: string }> {
    const normalized = email.toLowerCase();
    const guest = await this.deps.store.users.findById(guestUserId);
    if (guest !== null && guest.email === normalized) {
      throw new AppError('CONFLICT', 'email already linked to this account');
    }
    return this.createEmailToken('guest-upgrade', normalized, guestUserId);
  }

  /**
   * Redeem a single-use email token: resolves (or creates) the account,
   * merges guests on upgrade, and opens a fresh session.
   */
  async verifyToken(
    rawToken: string,
    device: string,
  ): Promise<{ user: UserDoc; session: SessionDoc; refreshToken: string }> {
    const { config, store } = this.deps;
    const now = this.now();
    const doc = await store.authTokens.findOne({ tokenHash: hashToken(config, rawToken) });
    if (doc === null || doc.usedAt !== null || doc.expiresAt < now) {
      throw new AppError('UNAUTHORIZED', 'invalid or expired token');
    }
    await store.authTokens.updateOne({ id: doc.id }, { usedAt: now });

    let user: UserDoc;
    if (doc.kind === 'magic-link') {
      const existing = await store.users.findOne({ email: doc.email });
      if (existing !== null) {
        user = existing;
      } else {
        const local = doc.email.split('@')[0] ?? '';
        user = await store.users.insertOne({
          id: newId() as UserId,
          email: doc.email,
          displayName: local.slice(0, 80) || 'user',
          avatarUrl: null,
          accentColor: DEFAULT_ACCENT,
          createdAt: now,
        });
      }
    } else {
      if (doc.upgradeFromUserId === null) {
        throw new AppError('UNAUTHORIZED', 'invalid or expired token');
      }
      const guest = await store.users.findById(doc.upgradeFromUserId);
      if (guest === null || guest.email !== null) {
        throw new AppError('UNAUTHORIZED', 'invalid or expired token');
      }
      const existing = await store.users.findOne({ email: doc.email });
      if (existing !== null) {
        await this.mergeGuest(guest.id, existing.id);
        user = existing;
      } else {
        const updated = await store.users.updateOne({ id: guest.id }, { email: doc.email });
        if (updated === null) {
          throw new AppError('UNAUTHORIZED', 'invalid or expired token');
        }
        user = updated;
      }
    }

    const { session, refreshToken } = await this.createSession(user.id, device);
    return { user, session, refreshToken };
  }

  /**
   * Merge a guest identity into a full account: memberships, messages,
   * playlists, assets, and read cursors move over; the guest's sessions are
   * revoked and the guest user row is deleted. Delete-then-insert on unique
   * keys avoids index conflicts with rows the target already has.
   */
  private async mergeGuest(guestId: string, targetId: string): Promise<void> {
    const { store } = this.deps;
    const guest = guestId as UserId;
    const target = targetId as UserId;
    const now = this.now();

    const memberships = await store.members.findMany({ userId: guest });
    for (const membership of memberships) {
      const existing = await store.members.findOne({
        roomId: membership.roomId,
        userId: target,
      });
      await store.members.deleteOne({ id: membership.id });
      if (existing === null) {
        await store.members.insertOne({
          ...membership,
          id: memberDocId(membership.roomId, targetId),
          userId: target,
        });
      }
    }

    await store.messages.updateMany({ authorId: guest }, { authorId: target });
    await store.playlists.updateMany({ ownerId: guest }, { ownerId: target });
    await store.assets.updateMany({ ownerId: guest }, { ownerId: target });

    const cursors = await store.cursors.findMany({ userId: guestId });
    for (const cursor of cursors) {
      await store.cursors.deleteOne({ id: cursor.id });
      const existing = await store.cursors.findOne({
        roomId: cursor.roomId,
        userId: targetId,
        kind: cursor.kind,
      });
      if (existing === null) {
        await store.cursors.insertOne({
          ...cursor,
          id: cursorDocId(cursor.roomId, targetId, cursor.kind),
          userId: targetId,
        });
      } else if (cursor.lastSeq > existing.lastSeq) {
        await store.cursors.updateOne(
          { id: existing.id },
          { lastSeq: cursor.lastSeq, at: cursor.at },
        );
      }
    }

    await store.sessions.updateMany({ userId: guestId }, { revokedAt: now });
    await store.users.deleteOne({ id: guest });
  }

  /** Open a session for a device; the refresh token is stored hashed only. */
  async createSession(
    userId: string,
    device: string,
  ): Promise<{ session: SessionDoc; refreshToken: string }> {
    const { config, store } = this.deps;
    const now = this.now();
    const refreshToken = randomToken();
    const session = await store.sessions.insertOne({
      id: newId(),
      userId,
      device: device.slice(0, 200) || 'unknown',
      createdAt: now,
      lastSeenAt: now,
      refreshHash: hashToken(config, refreshToken),
      rotatedHashes: [],
      revokedAt: null,
    });
    return { session, refreshToken };
  }

  /**
   * Rotate a refresh token. A presented token matching a ROTATED-OUT hash of
   * a live session means replay/theft: the session is revoked and the call
   * rejected.
   */
  async refresh(
    presentedToken: string,
  ): Promise<{ user: UserDoc; session: SessionDoc; refreshToken: string }> {
    const { config, store } = this.deps;
    const now = this.now();
    const hash = hashToken(config, presentedToken);

    const session = await store.sessions.findOne({ refreshHash: hash });
    if (session !== null) {
      const ttlMs = config.refreshTtlDays * 86_400_000;
      if (session.revokedAt !== null || session.lastSeenAt + ttlMs < now) {
        throw new AppError('UNAUTHORIZED', 'invalid refresh token');
      }
      const refreshToken = randomToken();
      const updated = await store.sessions.updateOne(
        { id: session.id },
        {
          refreshHash: hashToken(config, refreshToken),
          lastSeenAt: now,
          rotatedHashes: [...session.rotatedHashes, hash].slice(-10),
        },
      );
      if (updated === null) {
        throw new AppError('UNAUTHORIZED', 'invalid refresh token');
      }
      const user = await store.users.findById(updated.userId);
      if (user === null) {
        throw new AppError('UNAUTHORIZED', 'invalid refresh token');
      }
      return { user, session: updated, refreshToken };
    }

    const reused = (await store.sessions.findMany({ revokedAt: null })).find((s) =>
      s.rotatedHashes.includes(hash),
    );
    if (reused !== undefined) {
      await store.sessions.updateOne({ id: reused.id }, { revokedAt: now });
      throw new AppError('UNAUTHORIZED', 'refresh token reuse detected - session revoked');
    }
    throw new AppError('UNAUTHORIZED', 'invalid refresh token');
  }

  /** Join a room as a guest via its built-in invite code or an extra invite. */
  async guestJoin(
    inviteCode: string,
    displayName: string,
    device: string,
  ): Promise<{
    user: UserDoc;
    room: RoomDoc;
    member: MemberDoc;
    session: SessionDoc;
    refreshToken: string;
    lastEventSeq: number;
  }> {
    const { store } = this.deps;
    const now = this.now();

    let room = await store.rooms.findOne({ inviteCode: inviteCode as InviteCode });
    if (room === null) {
      const invite = await store.invites.findById(inviteCode);
      if (invite === null || (invite.expiresAt !== null && invite.expiresAt < now)) {
        throw new AppError('NOT_FOUND', 'invite not found');
      }
      room = await store.rooms.findById(invite.roomId);
      if (room === null) {
        throw new AppError('NOT_FOUND', 'invite not found');
      }
    }

    const user = await store.users.insertOne({
      id: newId() as UserId,
      email: null,
      displayName,
      avatarUrl: null,
      accentColor: DEFAULT_ACCENT,
      createdAt: now,
    });
    const member = await store.members.insertOne({
      id: memberDocId(room.id, user.id),
      roomId: room.id,
      userId: user.id,
      role: 'guest',
      joinedAt: now,
      banned: false,
      muted: false,
    });
    const { session, refreshToken } = await this.createSession(user.id, device);
    const last = await store.events.findMany(
      { roomId: room.id },
      { sort: [['seq', -1]], limit: 1 },
    );

    return { user, room, member, session, refreshToken, lastEventSeq: last[0]?.seq ?? 0 };
  }

  /** The user's live sessions, newest activity first, `current` flagged. */
  async listSessions(userId: string, currentSessionId: string): Promise<Session[]> {
    const sessions = await this.deps.store.sessions.findMany({ userId, revokedAt: null });
    return sessions
      .map((s) => ({
        id: s.id as SessionId,
        device: s.device,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        current: s.id === currentSessionId,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** Revoke one of the user's sessions; false when not found/already revoked. */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const updated = await this.deps.store.sessions.updateOne(
      { id: sessionId, userId, revokedAt: null },
      { revokedAt: this.now() },
    );
    return updated !== null;
  }

  /** Revoke every OTHER live session of the user; returns how many. */
  async revokeAllSessions(userId: string, exceptSessionId: string): Promise<number> {
    return this.deps.store.sessions.updateMany(
      { userId, revokedAt: null, id: { $ne: exceptSessionId } },
      { revokedAt: this.now() },
    );
  }

  /** Apply a profile patch; NOT_FOUND when the user is gone. */
  async updateProfile(
    userId: string,
    patch: {
      displayName?: string | undefined;
      avatarUrl?: string | null | undefined;
      accentColor?: string | undefined;
    },
  ): Promise<UserDoc> {
    const updated = await this.deps.store.users.updateOne(
      { id: userId as UserId },
      {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.avatarUrl !== undefined ? { avatarUrl: patch.avatarUrl } : {}),
        ...(patch.accentColor !== undefined ? { accentColor: patch.accentColor } : {}),
      },
    );
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'user not found');
    }
    return updated;
  }
}
