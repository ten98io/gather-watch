/**
 * Server-side mention extraction for chat messages. The client-sent mention
 * list is a HINT, never the truth: every mention stored on a message is
 * re-derived here from the body plus the room's actual membership, so a
 * client cannot mint mentions of non-members or forge `<@userId>` tokens.
 */
import type { UserId } from '@gather/contracts';

export interface MentionCandidate {
  userId: UserId;
  displayName: string;
}

/** Escape every regex metachar so display names are matched literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The mention set for a message, in first-seen order:
 * 1. client-sent mentions filtered to actual members,
 * 2. every `<@userId>` token in the body that names a member,
 * 3. every member whose displayName (length >= 2) appears as `@Name`.
 */
export function extractMentions(
  body: string,
  clientMentions: readonly UserId[],
  members: readonly MentionCandidate[],
): UserId[] {
  const memberIds = new Set<UserId>(members.map((m) => m.userId));
  const seen = new Set<UserId>();
  const out: UserId[] = [];
  const push = (userId: UserId): void => {
    if (!seen.has(userId)) {
      seen.add(userId);
      out.push(userId);
    }
  };

  for (const userId of clientMentions) {
    if (memberIds.has(userId)) {
      push(userId);
    }
  }

  for (const match of body.matchAll(/<@([^>\s]+)>/g)) {
    const userId = match[1] as UserId | undefined;
    if (userId !== undefined && memberIds.has(userId)) {
      push(userId);
    }
  }

  for (const member of members) {
    if (member.displayName.length < 2 || seen.has(member.userId)) {
      continue;
    }
    const re = new RegExp(`@${escapeRegExp(member.displayName)}(?![\\w])`, 'i');
    if (re.test(body)) {
      push(member.userId);
    }
  }

  return out;
}
