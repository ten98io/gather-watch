'use client';

/**
 * PeoplePane — the room's roster, drawn as presence orbs (DESIGN.md §5.2):
 * avatar circles carrying the person's own accent as their edge, with an
 * in-call marker that says whether their microphone is open. Member list from
 * REST (refreshed on member.updated), live state from presence.
 *
 * THE RING DOES NOT PULSE HERE, and that is the point. §5.2 requires the
 * speaking ring to be measured from the actual audio, never from a mic-on
 * flag — this pane has only presence, which says a microphone is OPEN and
 * cannot say a word is being spoken into it. A ring that pulses for silence is
 * the same lie the ring exists to stop, so the measured version lives in the
 * one place the audio is (components/call/CallSurface.tsx) and this pane shows
 * the honest thing instead: mic open, or mic muted.
 *
 * Two tiers of row action, and they are not the same kind of thing:
 *  · MODERATION (transfer host, promote/demote, kick, ban) is power inside the
 *    room, gated exactly the way the server gates it — a control the server
 *    would refuse is a control that must not be drawn.
 *  · REPORT is not power; it is the way out for someone who has none. It sits
 *    on every row but your own, for every role, guests included, because
 *    POST /report gates on nothing but a verified identity, and it is never
 *    behind a menu.
 *
 * On a row where the viewer has NO moderation powers — which is every row a
 * guest or a plain member sees, and they are the people this affordance exists
 * for — Report is the row's only control and is drawn outright. On a row where
 * the viewer is already a host or a moderator it joins the hover strip with
 * their other controls, because five buttons and a name do not fit in 284px
 * (see MODERATION_STRIP) and a host is not who the always-visible rule
 * protects.
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
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { HOVER_REVEAL } from '@/components/ui/media-row';
import { CrownIcon, MicIcon, MicOffIcon, UsersIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';

const STATE_LABEL: Record<PresenceEntry['state'], string> = {
  watching: 'Watching',
  listening: 'Listening',
  'in-call': 'In call',
  away: 'Away',
  offline: 'Offline',
};

const ROLE_RANK: Record<MemberRole, number> = { guest: 0, member: 1, moderator: 2, host: 3 };

/** Orb size in the roster: large enough to be a face, not a favicon. */
const ORB_PX = 44;

/**
 * The moderation strip has two layouts, and that is not an indulgence.
 *
 * A host looking at a member is offered five controls — hand over the host
 * seat, moderator, kick, ban, report. Measured at `sm` they are 282px of
 * buttons in a row that has 284px for the name AND the buttons, which is why
 * the roster shipped as a stack of two-line rows where the person was the
 * smallest thing on their own row. Leaving them in the flow and merely fading
 * them costs the same width, because opacity reserves layout.
 *
 * So where there IS a pointer the strip lifts out of the flow, sits over the
 * row's right end on the row's own hover step, and is revealed by
 * `HOVER_REVEAL` like every other row affordance in the product. Where there
 * is not — touch — it stays in flow and stays visible, because a control that
 * only exists under a cursor does not exist on a phone (§10). The two layouts
 * never both apply: everything positional here is inside the hover query, so
 * the flow layout is simply what is left when that query does not match.
 *
 * The plate is `surface-2` — the row's own hover step — so under a pointer it
 * is seamless with the row, and under keyboard focus alone (no hover, so the
 * row is still `surface-1`) it reads as a plate around the controls that just
 * took focus. That difference is wanted, not tolerated.
 */
const MODERATION_STRIP =
  'flex flex-wrap items-center justify-end gap-1 ' +
  '[@media(hover:hover)]:absolute [@media(hover:hover)]:inset-y-1 ' +
  '[@media(hover:hover)]:right-1 [@media(hover:hover)]:flex-nowrap ' +
  '[@media(hover:hover)]:rounded-ctl [@media(hover:hover)]:bg-surface-2 ' +
  '[@media(hover:hover)]:pl-3';

/**
 * The first paint, cut like the rows it stands in for — a round orb at the
 * roster's own size, a name line and a shorter meta line. "Loading people…"
 * is a spinner wall with better manners (§10): it says nothing about what is
 * coming, and the pane re-shapes when it arrives. Widths differ per row
 * because four identical bars read as a loading graphic rather than as names.
 */
const ROSTER_SKELETON_WIDTHS: readonly [string, string][] = [
  ['w-1/2', 'w-2/5'],
  ['w-2/3', 'w-1/3'],
  ['w-2/5', 'w-1/2'],
  ['w-3/5', 'w-1/4'],
];

function RosterSkeleton() {
  return (
    <div>
      <p role="status" className="sr-only">
        Loading the people in this room.
      </p>
      <ul aria-hidden className="flex flex-col gap-1">
        {ROSTER_SKELETON_WIDTHS.map(([name, meta]) => (
          <li key={name} className="flex items-center gap-3 px-2 py-2">
            <Skeleton
              radius="pill"
              className="shrink-0"
              style={{ width: ORB_PX, height: ORB_PX }}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton radius="ctl" className={`h-4 ${name}`} />
              <Skeleton radius="ctl" className={`h-3 ${meta}`} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

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

  const inCallCount = Object.values(presence).filter((p) => p.state === 'in-call').length;

  return (
    <section aria-label="People" data-room={roomId} className="flex h-full min-h-0 flex-col">
      {/* An overline over a count, rather than one 12px line of grey: the pane
          is ABOUT the people in it, so the number is allowed to be the biggest
          thing on it. Separated by whitespace, not by a rule (§4), and wearing
          the same header shape as the Queue so the rail reads as one object. */}
      <header className="flex items-end justify-between gap-3 px-1">
        <h3 className="min-w-0">
          <span className="block text-caption text-low">In this room</span>
          <span className="block truncate font-display text-title text-hi">
            <span className="tabular-nums">{members.length}</span>{' '}
            {members.length === 1 ? 'person' : 'people'}
            {/* Metadata inside a title stays `text-low` (§3). The call is the
                one thing about this roster that is happening right now. */}
            {inCallCount > 0 && (
              <span className="text-low">
                {' · '}
                <span className="tabular-nums">{inCallCount}</span> in the call
              </span>
            )}
          </span>
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="-mr-2 shrink-0"
          onClick={() => void copyInvite()}
        >
          Copy invite
        </Button>
      </header>

      {members.length === 0 ? (
        <div className="mt-6 min-h-0 flex-1 overflow-y-auto">
          {membersQuery.isPending ? (
            <RosterSkeleton />
          ) : (
            <EmptyState
              variant="signature"
              icon={<UsersIcon size={24} />}
              title="Nobody here yet"
              description="Send the invite link and this room fills up — everyone lands on the same second of the same thing."
            />
          )}
        </div>
      ) : (
        <ul className="mt-6 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-2">
          {members.map(({ member: m, user }) => {
            const p = presence[user.id];
            const inCall = p !== undefined && p.state === 'in-call';
            const isMe = user.id === me;
            const actionable =
              !isMe && (iAmHost || (iAmMod && ROLE_RANK[m.role] < ROLE_RANK.moderator));
            /** Both host-only role writes refuse the same three rows — a guest
             *  (upgrading is an account move, not a room one), a banned member,
             *  and the host seat itself. Drawing either button for those is
             *  drawing a 403. */
            const roleActionable =
              iAmHost && !isMe && !m.banned && (m.role === 'member' || m.role === 'moderator');
            /** Whether this VIEWER can do anything to this row beyond report
             *  it — the one thing that decides which of the two action layouts
             *  the row takes. See MODERATION_STRIP. */
            const hasPowers = actionable || roleActionable;
            const isMod = m.role === 'moderator';
            const meta = [
              ROLE_LABEL[m.role],
              p !== undefined ? STATE_LABEL[p.state] : 'Offline',
              p?.sharing === true ? 'sharing' : null,
            ]
              .filter((part): part is string => part !== null)
              .join(' · ');
            return (
              <li
                key={user.id}
                className={cn(
                  'group relative flex items-center gap-3 rounded-card px-2 py-2',
                  'transition-colors duration-150',
                  '[@media(hover:hover)]:hover:bg-surface-2',
                )}
              >
                <span className="relative shrink-0">
                  <Avatar
                    src={user.avatarUrl}
                    name={user.displayName}
                    accentColor={user.accentColor}
                    size={ORB_PX}
                    // The row's own text names this person one line later, and
                    // an orb that announces them too makes every roster entry
                    // read out twice.
                    decorative
                  />
                  {inCall && (
                    // `surface-3`, and it has to be the TOP rung rather than a
                    // neighbouring one: the marker overhangs a row that is
                    // `surface-1` at rest and `surface-2` under a pointer, so
                    // any step it borrows from those two disappears in one of
                    // the row's own states. (It was `surface-1`, which is the
                    // rail — invisible at rest, which is most of the time.)
                    <span
                      aria-hidden
                      className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full bg-surface-3 text-low"
                    >
                      {p.micOn ? (
                        <MicIcon size={12} />
                      ) : (
                        <MicOffIcon size={12} className="text-danger" />
                      )}
                    </span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-1.5 text-body text-hi">
                    <span className="truncate">
                      {user.displayName}
                      {isMe ? ' (you)' : ''}
                    </span>
                    {m.role === 'host' && (
                      // Decorative: the meta line under it already says "Host"
                      // in words, so the crown must not be announced twice.
                      <CrownIcon size={14} aria-hidden className="shrink-0 text-low" />
                    )}
                  </p>
                  <p className="truncate text-label text-low">
                    {meta}
                    {inCall && !p.micOn ? ' · muted' : ''}
                  </p>
                </div>
                {!isMe && (
                  <div
                    // One ternary, never two stacked layout utilities: `cn` is
                    // a plain joiner and the later class does not win.
                    className={
                      hasPowers
                        ? cn(MODERATION_STRIP, HOVER_REVEAL)
                        : 'flex shrink-0 items-center'
                    }
                  >
                    {roleActionable && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Make ${user.displayName} host`}
                          onClick={() => {
                            void api.rooms
                              .transferHost(roomId, { toUserId: user.id })
                              .then(() => toast.success(`${user.displayName} is now host`))
                              .catch((err: unknown) => {
                                toast.error(
                                  describeError(err, 'Could not hand over the host seat'),
                                );
                              });
                          }}
                        >
                          <CrownIcon size={16} aria-hidden />
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
                          <>
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
                            {/* A confirmation with no way out is a trap: the
                                row used to stay armed until it was clicked. A
                                destructive confirmation costs no step (§12). */}
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Keep ${user.displayName} in the room`}
                              onClick={() => setConfirmBan(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Ban ${user.displayName}`}
                            onClick={() => setConfirmBan(user.id)}
                          >
                            {/* The colour rides the LABEL, not the button:
                                `ghost` already sets `text-mid` and a
                                `hover:text-hi` that would take the warning
                                away exactly when the pointer is on it. */}
                            <span className="text-danger">Ban</span>
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
      )}

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
