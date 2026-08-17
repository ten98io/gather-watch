/**
 * Room policy gating (contracts RoomPolicyLevel → MemberRole). Pure helpers
 * so panes and tests share one definition of "who may touch what". canAct
 * mirrors apps/mobile/src/permissions.ts — keep them in sync. Queue URL
 * parsing lives in lib/providers.ts (parseProviderUrl).
 */
import type { MemberRole, RoomPolicyLevel } from '@gather/contracts';

const ROLE_RANK: Record<MemberRole, number> = {
  guest: 0,
  member: 1,
  moderator: 2,
  host: 3,
};

const LEVEL_MIN_RANK: Record<RoomPolicyLevel, number> = {
  everyone: 0,
  mods: 2,
  host: 3,
};

export function canAct(level: RoomPolicyLevel, role: MemberRole): boolean {
  return ROLE_RANK[role] >= LEVEL_MIN_RANK[level];
}

/** Milliseconds → m:ss (queue rows, player chrome). */
export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
