/**
 * Room policy gating (contracts RoomPolicyLevel → MemberRole) + queue URL
 * parsing. Pure helpers so panes and tests share one definition of "who may
 * touch what". Mirrors apps/mobile/src/permissions.ts — keep them in sync.
 */
import type { MemberRole, RoomPolicyLevel } from '@playin/contracts';

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

/** A URL pasted into the queue box → contracts MediaRef. null = not a URL we
 *  can play natively (YouTube watch/shorts links are understood). */
export function mediaRefFromUrl(raw: string):
  | { kind: 'youtube'; videoId: string }
  | { kind: 'url'; url: string; mime: string }
  | null {
  const url = raw.trim();
  const yt =
    /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/)|youtu\.be\/)([\w-]{6,})/.exec(url);
  const videoId = yt?.[1];
  if (videoId !== undefined) return { kind: 'youtube', videoId };
  if (!/^https?:\/\/\S+$/.test(url)) return null;
  const lower = url.split('?')[0]?.toLowerCase() ?? '';
  const mime = lower.endsWith('.m3u8')
    ? 'application/x-mpegURL'
    : lower.endsWith('.mp3')
      ? 'audio/mpeg'
      : lower.endsWith('.m4a') || lower.endsWith('.aac')
        ? 'audio/aac'
        : lower.endsWith('.webm')
          ? 'video/webm'
          : 'video/mp4';
  return { kind: 'url', url, mime };
}

/** Milliseconds → m:ss (queue rows, player chrome). */
export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
