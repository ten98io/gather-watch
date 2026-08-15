/**
 * GDPR account erasure (DELETE /me).
 *
 * DECISION RECORD — purge scheduling with the frozen StorePort:
 * The contract (DeleteMeResponse.purgeAt) promises a grace period before the
 * cascade executes, but the frozen port has NO persistent home for
 * pending-purge state: UserDoc is exactly the contracts User (no server-side
 * extension fields the way AssetDoc has), and misusing the reports or usage
 * collections as a scheduler table was explicitly rejected in the brief. A
 * grace period as a *recovery* window is impossible anyway — sessions are
 * revoked at request time and the contracts define no cancel-erasure
 * endpoint.
 *
 * Resolution: the erasure cascade executes IMMEDIATELY (no PII survives it),
 * and `purgeAt = now + 7 days` is the hard-purge deadline for the anonymized
 * residue (usage aggregates + tombstoned message rows). Pending purges live
 * in a PROCESS-LOCAL registry swept on an unref'd 5-minute interval. A
 * restart loses pending hard-purges — safe, because the immediate cascade
 * already removed all PII; making the deadline itself crash-proof requires an
 * orchestrator-level StorePort change (e.g. server-side fields on UserDoc or
 * a dedicated collection).
 */
import type { UserId } from '@playin/contracts';
import { AppError } from '../../lib/errors';
import { RoomsService } from '../rooms/service';
import type { Deps } from '../types';

/** Grace period promised in DeleteMeResponse.purgeAt. */
export const ERASURE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the pending-purge registry is swept. */
export const PURGE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** userId → hard-purge deadline (epoch ms). Process-local; see the header. */
const pendingPurges = new Map<string, number>();

/** Test/introspection hook: users awaiting their hard purge. */
export function pendingPurgeCount(): number {
  return pendingPurges.size;
}

/**
 * Execute the erasure cascade for one full account and register its hard
 * purge. Order matters: sessions are revoked FIRST so tokens die even when a
 * later step throws.
 */
export async function eraseAccount(deps: Deps, userId: UserId): Promise<{ purgeAt: number }> {
  const { store } = deps;
  const user = await store.users.findById(userId);
  if (user === null) {
    throw new AppError('NOT_FOUND', 'user not found');
  }
  const now = Date.now();
  const purgeAt = now + ERASURE_GRACE_MS;

  // 1. Sessions: revoke (tokens die immediately), rows deleted in step 4.
  await store.sessions.updateMany({ userId, revokedAt: null }, { revokedAt: now });

  // 2. Tombstone every message they authored — the exact patch shape
  //    ChatService.remove uses. Live rooms pick tombstones up on refetch; we
  //    deliberately do NOT fan out one chat.deleted event per message for a
  //    bulk erase.
  const authored = await store.messages.findMany({ authorId: userId, deletedAt: null });
  for (const message of authored) {
    await store.messages.updateOne(
      { id: message.id },
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
  }

  // 3. Memberships: banned rows are deleted outright (the account is gone —
  //    there is nothing left to enforce a ban against); live memberships go
  //    through the rooms module's OWN leave path, which disconnects sockets
  //    and runs host handoff (moderators before members, earliest joiner) or
  //    leaves the room ownerless when no successor remains.
  const rooms = new RoomsService(deps);
  const memberships = await store.members.findMany({ userId });
  for (const membership of memberships) {
    if (membership.banned) {
      await store.members.deleteOne({ id: membership.id });
    } else {
      await rooms.leaveRoom(membership.roomId, userId);
    }
  }

  // 4. Rows that are the account's alone: push subscriptions, sessions, the
  //    billing subscription row (id = userId), and playlists. Media assets
  //    are NOT touched — their object-storage lifecycle belongs to the media
  //    module (they end up orphaned-but-inert; follow-up noted in the module
  //    report).
  await store.pushSubs.deleteMany({ userId });
  await store.sessions.deleteMany({ userId });
  await store.subscriptions.deleteOne({ id: userId });
  await store.playlists.deleteMany({ ownerId: userId });

  // 5. Anonymize the user doc — never hard-delete at request time, so
  //    message authorId / queue addedBy references stay referable. email is
  //    covered by a SPARSE unique index, so null is safe.
  await store.users.updateOne(
    { id: userId },
    { email: null, displayName: 'Deleted user', avatarUrl: null },
  );

  pendingPurges.set(userId, purgeAt);
  return { purgeAt };
}

/**
 * Hard-purge every user whose grace deadline has passed: usage aggregates and
 * the tombstoned message rows are deleted outright. The anonymized user doc
 * STAYS as the referable tombstone identity — it carries no PII, and
 * removing it would break authorId/addedBy referability for zero privacy
 * gain. Returns the purged user ids. Exported for tests.
 */
export async function purgeDueUsers(deps: Deps, now: number): Promise<string[]> {
  const purged: string[] = [];
  for (const [userId, purgeAt] of pendingPurges) {
    if (purgeAt > now) {
      continue;
    }
    await deps.store.usage.deleteMany({ userId });
    await deps.store.messages.deleteMany({
      authorId: userId as UserId,
      deletedAt: { $ne: null },
    });
    pendingPurges.delete(userId);
    purged.push(userId);
  }
  return purged;
}

/**
 * Start the unref'd purge sweeper. Registered by the routes plugin; the
 * returned idempotent stop function runs on app close so tests never leak a
 * timer.
 */
export function startPurgeSweeper(deps: Deps): () => void {
  const timer = setInterval(() => {
    purgeDueUsers(deps, Date.now()).catch((err: unknown) => {
      deps.log.warn({ err }, 'purge sweep failed');
    });
  }, PURGE_SWEEP_INTERVAL_MS);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}
