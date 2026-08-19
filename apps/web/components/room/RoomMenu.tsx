'use client';

/**
 * RoomMenu — everything you can do TO a room, from one place.
 *
 * It used to render nothing at all for a plain member, which quietly made two
 * promises false: app/legal/abuse tells users a room can be reported "from
 * inside the app (… room menu)", and leaving a room had no control anywhere
 * (the header arrow is navigation — it always was). So the menu now opens for
 * everyone and each row carries its own gate:
 *
 *  · rename + policies — host or moderator, exactly what the server enforces
 *  · password          — host only; rotation IS recovery (there is no reset
 *                        flow), so the same field sets, rotates, and (empty)
 *                        clears
 *  · leave, report     — everyone, guests included
 *  · delete            — host or moderator, behind a double confirm
 *
 * Rename and delete broadcast to the room; a policy change lands as
 * room.updated, so the controls read `room` and never mirror it in state.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SetRoomPasswordResponse, UpdateRoomResponse } from '@gather/contracts';
import { Ok } from '@gather/contracts';
import type { Room, RoomId, RoomPolicyLevel, UpdatePoliciesBody } from '@gather/contracts';
import { api, apiFetch } from '@/lib/api';
import { describeError } from '@/lib/describe-error';
import { useRoom } from '@/lib/room-context';
import { ReportDialog } from '@/components/report/ReportDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';

/** Ascending by how many people it lets in — the order they are read in. */
const TIERS: readonly RoomPolicyLevel[] = ['host', 'mods', 'everyone'];

/** Short enough for three side by side in a dialog; the row label asks the
 *  question, so these only have to answer it. */
const TIER_LABEL: Record<RoomPolicyLevel, string> = {
  host: 'Host',
  mods: 'Mods',
  everyone: 'Everyone',
};

/**
 * The three tiered policies. Each carries its own patch builder rather than a
 * computed key: `{ [key]: tier }` off a union widens to a string index
 * signature, which is not an UpdatePoliciesBody.
 */
const TIER_POLICIES: ReadonlyArray<{
  key: 'playbackControl' | 'queueControl' | 'chat';
  label: string;
  patch(tier: RoomPolicyLevel): UpdatePoliciesBody;
}> = [
  {
    key: 'playbackControl',
    label: 'Who can play',
    patch: (tier) => ({ playbackControl: tier }),
  },
  { key: 'queueControl', label: 'Who can queue', patch: (tier) => ({ queueControl: tier }) },
  { key: 'chat', label: 'Who can chat', patch: (tier) => ({ chat: tier }) },
];

function TierRow({
  label,
  value,
  disabled,
  onPick,
}: {
  label: string;
  value: RoomPolicyLevel;
  disabled: boolean;
  onPick(tier: RoomPolicyLevel): void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-mid">{label}</span>
      <div role="group" aria-label={label} className="flex gap-1">
        {TIERS.map((tier) => (
          <Button
            key={tier}
            // cn() is a plain joiner, so the selected fill is a variant
            // ternary — two background utilities would simply both apply.
            variant={tier === value ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={tier === value}
            aria-label={`${label}: ${TIER_LABEL[tier]}`}
            disabled={disabled}
            onClick={() => {
              onPick(tier);
            }}
          >
            {TIER_LABEL[tier]}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function RoomMenu({ room, canManage }: { room: Room; canManage: boolean }) {
  const router = useRouter();
  const { member } = useRoom();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(room.name);
  const [password, setPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Local while the thumb moves; the room is still the source of truth, and
   *  the commit below is what makes them agree again. */
  const [skipPct, setSkipPct] = useState(() =>
    Math.round(room.policies.skipVoteThreshold * 100),
  );
  const roomId = room.id as RoomId;
  const isHost = member.role === 'host';

  const rename = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === room.name) return;
    setBusy(true);
    try {
      await apiFetch(`/rooms/${roomId}`, {
        method: 'PATCH',
        body: { name: trimmed },
        schema: UpdateRoomResponse,
      });
      toast.success('Room renamed');
      setOpen(false);
    } catch (err) {
      toast.error(describeError(err, 'Could not rename the room'));
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async (): Promise<void> => {
    const trimmed = password.trim();
    // Nothing to do: no password set, and none entered.
    if (trimmed.length === 0 && !room.hasPassword) return;
    setBusy(true);
    try {
      await apiFetch(`/rooms/${roomId}/password`, {
        method: 'PATCH',
        body: { password: trimmed.length > 0 ? trimmed : null },
        schema: SetRoomPasswordResponse,
      });
      toast.success(trimmed.length > 0 ? 'Room password saved' : 'Room password cleared');
      setPassword('');
    } catch (err) {
      toast.error(describeError(err, 'Could not update the password'));
    } finally {
      setBusy(false);
    }
  };

  const savePolicies = async (patch: UpdatePoliciesBody, done: string): Promise<void> => {
    setBusy(true);
    try {
      await api.rooms.updatePolicies(roomId, patch);
      toast.success(done);
    } catch (err) {
      toast.error(describeError(err, 'Could not change what the room allows'));
      // The failed value is still under the thumb; put the room's back.
      setSkipPct(Math.round(room.policies.skipVoteThreshold * 100));
    } finally {
      setBusy(false);
    }
  };

  const leave = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.rooms.leaveRoom(roomId);
      // Off the room screen before the socket closes behind us: the same
      // removal that ends the session would otherwise land as a notice
      // telling the person they were removed from a room they just left.
      router.push('/home');
    } catch (err) {
      toast.error(describeError(err, 'Could not leave the room'));
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await apiFetch(`/rooms/${roomId}`, { method: 'DELETE', schema: Ok });
      toast.success('Room deleted');
      router.push('/home');
    } catch (err) {
      toast.error(describeError(err, 'Could not delete the room'));
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Room settings"
        onClick={() => {
          setName(room.name);
          setPassword('');
          setConfirmDelete(false);
          setConfirmLeave(false);
          setSkipPct(Math.round(room.policies.skipVoteThreshold * 100));
          setOpen(true);
        }}
      >
        ⚙
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-label="Room settings">
          <DialogTitle>Room settings</DialogTitle>
          <DialogDescription>
            {canManage
              ? 'Rename the room, gate it with a password, set what it allows, or delete it ' +
                'for everyone. Deletion removes members, invites, and history — there is no undo.'
              : 'Leave this room, or report it to whoever runs this instance.'}
          </DialogDescription>

          {canManage && (
            <form
              className="mt-4 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void rename();
              }}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                aria-label="Room name"
              />
              <Button type="submit" disabled={busy || name.trim().length === 0}>
                Rename
              </Button>
            </form>
          )}

          {isHost && (
            <form
              className="mt-4 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void savePassword();
              }}
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                maxLength={120}
                placeholder={
                  room.hasPassword
                    ? 'New password (submit empty to clear)'
                    : 'Set a room password'
                }
                aria-label="Room password"
              />
              <Button type="submit" disabled={busy}>
                {room.hasPassword ? 'Update' : 'Set'}
              </Button>
            </form>
          )}
          {isHost && (
            <p className="mt-1.5 text-xs text-low">
              New joins need the password. If it is lost, set a new one here — that is the
              recovery.
            </p>
          )}

          {canManage && (
            <section className="mt-6 border-t border-border-glass pt-4">
              <h3 className="text-sm font-medium text-hi">What this room allows</h3>
              <p className="mt-1 text-xs text-low">
                Applies the moment you pick it, for everyone who is here.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {TIER_POLICIES.map(({ key, label, patch }) => (
                  <TierRow
                    key={key}
                    label={label}
                    value={room.policies[key]}
                    disabled={busy}
                    onPick={(tier) => {
                      void savePolicies(patch(tier), `${label}: ${TIER_LABEL[tier]}`);
                    }}
                  />
                ))}
              </div>

              <div className="mt-4 flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-mid">Skip on a vote of</span>
                  <span className="text-xs text-low">
                    {skipPct === 0 ? 'Nobody — voting off' : `${skipPct}% of the room`}
                  </span>
                </div>
                <Slider
                  aria-label="Skip on a vote of"
                  min={0}
                  max={100}
                  step={10}
                  value={skipPct}
                  disabled={busy}
                  onValueChange={setSkipPct}
                  onValueCommit={(pct) => {
                    void savePolicies(
                      { skipVoteThreshold: pct / 100 },
                      pct === 0 ? 'Vote-skip turned off' : `Skip at ${pct}% of the room`,
                    );
                  }}
                />
              </div>

              <label className="mt-4 flex items-center justify-between gap-4">
                <span className="text-sm text-mid">Wait for everyone before playing</span>
                <Switch
                  aria-label="Wait for everyone before playing"
                  checked={room.policies.waitForAll}
                  disabled={busy}
                  onCheckedChange={(on) => {
                    void savePolicies(
                      { waitForAll: on },
                      on ? 'The room waits for everyone' : 'The room no longer waits',
                    );
                  }}
                />
              </label>
            </section>
          )}

          <div className="mt-6 border-t border-border-glass pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {confirmLeave ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-mid">Leave this room?</span>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmLeave(false)}>
                    Stay
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => void leave()}
                  >
                    Leave
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmLeave(true)}>
                  Leave room…
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  // One dialog at a time: the report surface replaces this
                  // one rather than stacking a second modal on top of it.
                  setOpen(false);
                  setReporting(true);
                }}
              >
                Report this room…
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-low">
              Leaving takes this room off your list — you need an invite to come back.
            </p>
          </div>

          {canManage && (
            <div className="mt-6 border-t border-border-glass pt-4">
              {confirmDelete ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-danger">Delete this room for everyone?</span>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                      Keep
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => void remove()}
                    >
                      Delete room
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirmDelete(true)}>
                  Delete room…
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {reporting && (
        <ReportDialog
          open
          onOpenChange={setReporting}
          target={{ kind: 'room', roomId }}
          subject="this room"
        />
      )}
    </>
  );
}
