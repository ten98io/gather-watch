'use client';

/**
 * RoomMenu — room CRUD (host/mod). Rename broadcasts room.updated to everyone;
 * delete is a double-confirm and lands back on /home. The password row is
 * host-only: rotation IS recovery (there is no reset flow), so the same field
 * sets, rotates, and (submitted empty) clears.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SetRoomPasswordResponse, UpdateRoomResponse } from '@gather/contracts';
import { Ok } from '@gather/contracts';
import type { Room, RoomId } from '@gather/contracts';
import { apiFetch } from '@/lib/api';
import { describeError } from '@/lib/describe-error';
import { useRoom } from '@/lib/room-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';

export function RoomMenu({ room, canManage }: { room: Room; canManage: boolean }) {
  const router = useRouter();
  const { member } = useRoom();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(room.name);
  const [password, setPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const roomId = room.id as RoomId;
  const isHost = member.role === 'host';

  if (!canManage) return null;

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
          setOpen(true);
        }}
      >
        ⚙
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-label="Room settings">
          <DialogTitle>Room settings</DialogTitle>
          <DialogDescription>
            Rename the room, gate it with a password, or delete it for everyone.
            Deletion removes members, invites, and history — there is no undo.
          </DialogDescription>

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
        </DialogContent>
      </Dialog>
    </>
  );
}
