'use client';

/**
 * PeoplePane — presence orbs (DESIGN.md §5.2): avatar circles with
 * accent-colored edges and a pulsing speaking ring while in-call with mic
 * on. Member list from REST (refreshed on member.updated), live state from
 * presence.
 *
 * Two tiers of row action, and they are not the same kind of thing:
 *  · MODERATION (transfer host, promote/demote, kick, ban) is power inside the
 *    room, gated exactly the way the server gates it — a control the server
 *    would refuse is a control that must not be drawn.
 *  · REPORT is not power; it is the way out for someone who has none. It sits
 *    on every row but your own, for every role, guests included, because
 *    POST /report gates on nothing but a verified identity.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatInviteCode } from '@gather/contracts';
import type { MemberRole, PresenceEntry, RoomId, UserId } from '@gather/contracts';
import { api } from '@/lib/api';
import { describeError } from '@/lib/describe-error';
import { ROLE_LABEL } from '@/lib/labels';
import { canAct } from '@/lib/permissions';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { ReportDialog } from '@/components/report/ReportDialog';
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
  /** One dialog for the whole roster, not one per row. */
  const [reportTarget, setReportTarget] = useState<{ userId: UserId; name: string } | null>(
    null,
  );

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
  const iAmMod = canAct('mods', member.role);

  /** POST /rooms/:id/members/role. Host only, and the server refuses the host
   *  seat, a guest, a banned row and the caller themselves — so the button is
   *  drawn for none of those. */
  const setRole = (userId: UserId, name: string, role: 'moderator' | 'member'): void => {
    void api.rooms
      .setMemberRole(roomId, { userId, role })
      .then(() =>
        toast.success(
          role === 'moderator' ? `${name} is now a moderator` : `${name} is now a member`,
        ),
      )
      .catch((err: unknown) => {
        toast.error(describeError(err, 'Could not change that role'));
      });
  };

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
          const isMe = user.id === me;
          const actionable =
            !isMe && (iAmHost || (iAmMod && ROLE_RANK[m.role] < ROLE_RANK.moderator));
          /** Both host-only role writes refuse the same three rows — a guest
           *  (upgrading is an account move, not a room one), a banned member,
           *  and the host seat itself. Drawing either button for those is
           *  drawing a 403. */
          const roleActionable =
            iAmHost && !isMe && !m.banned && (m.role === 'member' || m.role === 'moderator');
          const isMod = m.role === 'moderator';
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
                  {isMe ? ' (you)' : ''}
                </p>
                <p className="text-xs text-low">
                  {ROLE_LABEL[m.role]}
                  {p !== undefined ? ` · ${STATE_LABEL[p.state]}` : ' · offline'}
                  {p?.sharing === true ? ' · sharing' : ''}
                  {p !== undefined && p.state === 'in-call' ? (p.micOn ? ' · 🎙' : ' · 🔇') : ''}
                </p>
              </div>
              {m.role === 'host' && <Badge variant="aurora">{ROLE_LABEL.host}</Badge>}
              {!isMe && (
                <div className="flex flex-wrap justify-end gap-1">
                  {roleActionable && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Make ${user.displayName} host`}
                        onClick={() => {
                          void api.rooms
                            .transferHost(roomId, { toUserId: user.id })
                            .then(() => toast.success(`${user.displayName} is now host`))
                            .catch((err: unknown) => {
                              toast.error(describeError(err, 'Could not hand over the host seat'));
                            });
                        }}
                      >
                        👑
                      </Button>
                      <Button
                        // cn() is a plain joiner, so the on/off fills are a
                        // variant ternary rather than two stacked classes.
                        variant={isMod ? 'secondary' : 'ghost'}
                        size="sm"
                        aria-pressed={isMod}
                        aria-label={
                          isMod
                            ? `Remove moderator from ${user.displayName}`
                            : `Make ${user.displayName} a moderator`
                        }
                        onClick={() => {
                          setRole(user.id, user.displayName, isMod ? 'member' : 'moderator');
                        }}
                      >
                        {ROLE_LABEL.moderator}
                      </Button>
                    </>
                  )}
                  {actionable && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Kick ${user.displayName}`}
                        onClick={() => {
                          void api.rooms
                            .kickMember(roomId, { userId: user.id })
                            .catch((err: unknown) => {
                              toast.error(describeError(err, 'Could not remove them'));
                            });
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
                              .catch((err: unknown) => {
                                toast.error(describeError(err, 'Could not ban them'));
                              });
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
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Report ${user.displayName}`}
                    onClick={() => {
                      setReportTarget({ userId: user.id, name: user.displayName });
                    }}
                  >
                    Report
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {reportTarget !== null && (
        <ReportDialog
          open
          onOpenChange={(next) => {
            if (!next) setReportTarget(null);
          }}
          target={{ kind: 'user', userId: reportTarget.userId }}
          subject={reportTarget.name}
        />
      )}
    </section>
  );
}
