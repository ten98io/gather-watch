/**
 * Shared room-policy helper: maps a policy level to the member roles it
 * admits. Used by every module that gates mutations on room.policies.
 */
import type { MemberRole, RoomPolicyLevel } from '@gather/contracts';

/** 'host' → host only; 'mods' → host+moderator; 'everyone' → any member (incl. guests). */
export function policyAllows(level: RoomPolicyLevel, role: MemberRole): boolean {
  switch (level) {
    case 'host':
      return role === 'host';
    case 'mods':
      return role === 'host' || role === 'moderator';
    case 'everyone':
      return true;
  }
}
