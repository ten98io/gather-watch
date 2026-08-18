/**
 * Web-push notifications for chat: mentions, room invites, and room-started
 * pings. Delivery is best-effort — push failures NEVER propagate into the
 * chat flow (dead subscriptions are pruned, transient ones logged).
 *
 * Enabled = a transport is injected (tests) OR both VAPID keys are
 * configured. An injected `sendImpl` implies enabled regardless of config —
 * tests rely on this. With no transport and no keys the factory returns a
 * no-op port.
 *
 * THE ENDPOINT IS RE-CHECKED HERE, not just at subscribe time. This is the
 * line that actually opens a socket to a client-chosen URL, and rows written
 * before push/endpoint.ts existed are already in production databases — a
 * check only at the door would leave every one of them live. Cheap enough to
 * be unconditional: no DNS, just the host list.
 */
import webPush from 'web-push';
import type { MessageId, RoomId, UserId } from '@gather/contracts';
import { memberDocId } from '../../adapters/ports';
import { isKnownPushService } from '../push/endpoint';
import type { Deps } from '../types';

export interface MentionNotification {
  roomId: RoomId;
  messageId: MessageId;
  fromUserId: UserId;
  toUserIds: readonly UserId[];
  preview: string;
}
export interface InviteNotification {
  roomId: RoomId;
  fromUserId: UserId;
  toUserId: UserId;
}
export interface RoomStartedNotification {
  roomId: RoomId;
  toUserIds: readonly UserId[];
}

export interface NotifyPort {
  mention(n: MentionNotification): Promise<void>;
  invite(n: InviteNotification): Promise<void>;
  roomStarted(n: RoomStartedNotification): Promise<void>;
}

export type WebPushSend = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
) => Promise<unknown>;

const noopPort: NotifyPort = {
  mention: async () => {},
  invite: async () => {},
  roomStarted: async () => {},
};

/** https + a known push service. Unparseable is not deliverable. */
function deliverableEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && isKnownPushService(url);
  } catch {
    return false;
  }
}

export function createNotifier(
  deps: Pick<Deps, 'config' | 'store' | 'log'>,
  sendImpl?: WebPushSend,
): NotifyPort {
  const { config, store, log } = deps;
  const { publicKey, privateKey, subject } = config.vapid;

  let send: WebPushSend;
  if (sendImpl !== undefined) {
    send = sendImpl;
  } else if (publicKey !== null && privateKey !== null) {
    webPush.setVapidDetails(subject, publicKey, privateKey);
    send = async (sub, payload) =>
      webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
  } else {
    return noopPort;
  }

  /** Fan out to each target's web subscriptions; never throws. */
  const deliver = async (
    roomId: RoomId,
    userIds: readonly UserId[],
    payload: string,
    respectMute: boolean,
  ): Promise<void> => {
    for (const userId of userIds) {
      if (respectMute) {
        const member = await store.members.findById(memberDocId(roomId, userId));
        if (member?.muted === true) {
          continue;
        }
      }
      const subs = await store.pushSubs.findMany({ userId, platform: 'web' });
      for (const sub of subs) {
        if (sub.endpoint === null || sub.keys === null) {
          continue;
        }
        if (!deliverableEndpoint(sub.endpoint)) {
          log.warn({ subId: sub.id }, 'skipping push subscription with a disallowed endpoint');
          continue;
        }
        try {
          await send({ endpoint: sub.endpoint, keys: sub.keys }, payload);
        } catch (err) {
          const statusCode = (err as { statusCode?: unknown }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            // Gone for good — prune so we don't keep paying for dead subs.
            await store.pushSubs.deleteOne({ id: sub.id });
          } else {
            log.warn({ err }, 'web push delivery failed');
          }
        }
      }
    }
  };

  const roomName = async (roomId: RoomId): Promise<string> =>
    (await store.rooms.findById(roomId))?.name ?? '';

  const displayName = async (userId: UserId): Promise<string> =>
    (await store.users.findById(userId))?.displayName ?? 'someone';

  return {
    mention: async (n) => {
      const targets = n.toUserIds.filter((userId) => userId !== n.fromUserId);
      if (targets.length === 0) {
        return;
      }
      const payload = JSON.stringify({
        kind: 'mention',
        roomId: n.roomId,
        roomName: await roomName(n.roomId),
        fromDisplayName: await displayName(n.fromUserId),
        messageId: n.messageId,
        preview: n.preview.slice(0, 140),
      });
      await deliver(n.roomId, targets, payload, true);
    },

    invite: async (n) => {
      const payload = JSON.stringify({
        kind: 'invite',
        roomId: n.roomId,
        roomName: await roomName(n.roomId),
        fromDisplayName: await displayName(n.fromUserId),
      });
      // Invite targets may not be members yet — no mute check.
      await deliver(n.roomId, [n.toUserId], payload, false);
    },

    roomStarted: async (n) => {
      if (n.toUserIds.length === 0) {
        return;
      }
      const payload = JSON.stringify({
        kind: 'room-started',
        roomId: n.roomId,
        roomName: await roomName(n.roomId),
      });
      await deliver(n.roomId, n.toUserIds, payload, true);
    },
  };
}
