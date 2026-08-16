'use client';

/**
 * PeoplePane — presence orbs (DESIGN.md §5.2): avatar circles with
 * accent-colored edges and a pulsing speaking ring while in-call with mic
 * on. Member list from REST (refreshed on member.updated), live state from
 * presence. Host/mod actions: transfer host, kick, ban.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatInviteCode } from '@playin/contracts';
import type { MemberRole, PresenceEntry, RoomId } from '@playin/contracts';
import { api } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/labels';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

const STATE_LABEL: Record<PresenceEntry['state'], string> = {
  watching: 'Watching',
  listening: 'Listening',
  'in-call': 'In call',
  away: 'Away',
  offline: 'Offline',
};

const ROLE_RANK: Record<MemberRole, number> = { guest: 0, member: 1, moderator: 2, host: 3 };

export function PeoplePane({ roomId }: { roomId: RoomId }) {
  const connection = useRoomConnection();
  const { room, member } = useRoom();
  const me = member.userId;
  const presence = connection.useRoomState((s) => s.presence);
  const membersVersion = connection.useRoomState((s) => s.membersVersion);
  const [confirmBan, setConfirmBan] = useState<string | null>(null);

  const membersQuery = useQuery({
    queryKey: ['members', roomId],
    queryFn: () => api.rooms.listMembers(roomId),
  });

  useEffect(() => {
    if (membersVersion > 0) void membersQuery.refetch();
    // NOTE: deps intentionally minimal (re-run only on the version bump).
  }, [membersVersion]);
  const members = membersQuery.data?.members ?? [];
  const iAmHost = member.role === 'host';
  const iAmMod = ROLE_RANK[member.role] >= ROLE_RANK.moderator;

  const copyInvite = async (): Promise<void> => {
    const link = `${window.location.origin}/join/${room.inviteCode}`;
    const pretty = formatInviteCode(room.inviteCode);
    try {
      await navigator.clipboard.writeText(link);
      toast.success(`Invite copied: ${pretty}`);
    } catch {
      // Clipboard blocked — surface the link itself, explained.
      toast.error(`Copy this invite link: ${link}`);
    }
  };

  return (
    <section aria-label="People" data-room={roomId} className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border-glass px-3 py-1.5">
        <span className="flex-1 text-xs font-medium text-low">{members.length} in room</span>
        <Button variant="ghost" size="sm" onClick={() => void copyInvite()}>
          Copy invite
        </Button>
      </div>

      <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {members.length === 0 && (
          <li className="py-10 text-center text-sm text-low">
            {membersQuery.isPending ? 'Loading people…' : 'No members found.'}
          </li>
        )}
        {members.map(({ member: m, user }) => {
          const p = presence[user.id];
          const speaking = p?.state === 'in-call' && p.micOn;
          const actionable = user.id !== me && (iAmHost || (iAmMod && ROLE_RANK[m.role] < ROLE_RANK.moderator));
          return (
            <li key={user.id} className="flex items-center gap-3 rounded-ctl px-2 py-1.5 hover:bg-glass">
              <Avatar
                src={user.avatarUrl}
                name={user.displayName}
                accentColor={user.accentColor}
                speaking={speaking}
                size={40}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-hi">
                  {user.displayName}
                  {user.id === me ? ' (you)' : ''}
                </p>
                <p className="text-xs text-low">
                  {ROLE_LABEL[m.role]}
                  {p !== undefined ? ` · ${STATE_LABEL[p.state]}` : ' · offline'}
                  {p?.sharing === true ? ' · sharing' : ''}
                  {p !== undefined && p.state === 'in-call' ? (p.micOn ? ' · 🎙' : ' · 🔇') : ''}
                </p>
              </div>
              {m.role === 'host' && <Badge variant="aurora">{ROLE_LABEL.host}</Badge>}
              {actionable && (
                <div className="flex flex-wrap justify-end gap-1">
                  {iAmHost && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Make ${user.displayName} host`}
                      onClick={() => {
                        void api.rooms
                          .transferHost(roomId, { toUserId: user.id })
                          .then(() => toast.success(`${user.displayName} is now host`))
                          .catch(() => toast.error('Host transfer failed'));
                      }}
                    >
                      👑
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Kick ${user.displayName}`}
                    onClick={() => {
                      void api.rooms
                        .kickMember(roomId, { userId: user.id })
                        .catch(() => toast.error('Kick failed'));
                    }}
                  >
                    Kick
                  </Button>
                  {confirmBan === user.id ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setConfirmBan(null);
                        void api.rooms
                          .banMember(roomId, { userId: user.id, banned: true })
                          .catch(() => toast.error('Ban failed'));
                      }}
                    >
                      Ban?
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger"
                      aria-label={`Ban ${user.displayName}`}
                      onClick={() => setConfirmBan(user.id)}
                    >
                      Ban
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
