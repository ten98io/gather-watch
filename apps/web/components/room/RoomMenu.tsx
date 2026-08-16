'use client';

/**
 * RoomMenu — room CRUD (host/mod) + the free-plan expiry countdown chip.
 * Rename broadcasts room.updated to everyone; delete is a double-confirm and
 * lands back on /home. The chip counts down to room.expiresAt (amber under
 * 30 min) and explains that activity resets the clock.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { UpdateRoomResponse } from '@playin/contracts';
import { Ok } from '@playin/contracts';
import type { Room, RoomId } from '@playin/contracts';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);
  return now;
}

export function ExpiryChip({ room }: { room: Room }) {
  const now = useNow(30_000);
  if (room.expiresAt === null) return null;
  const remainingMs = Math.max(0, room.expiresAt - now);
  const h = Math.floor(remainingMs / 3_600_000);
  const m = Math.ceil((remainingMs % 3_600_000) / 60_000);
  const soon = remainingMs < 30 * 60_000;
  return (
    <span
      title="Free-plan rooms expire after 4 hours — any room activity resets the clock. Premium rooms persist."
      className={
        soon
          ? 'rounded-full bg-warn/20 px-2 py-0.5 text-xs font-medium text-warn'
          : 'rounded-full bg-glass px-2 py-0.5 text-xs text-low'
      }
    >
      ⏳ {h}h {m}m
    </span>
  );
}

export function RoomMenu({ room, canManage }: { room: Room; canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(room.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const roomId = room.id as RoomId;

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
      toast.error(err instanceof Error ? err.message : 'Rename failed');
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
      toast.error(err instanceof Error ? err.message : 'Delete failed');
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
            Rename the room or delete it for everyone. Deletion removes members,
            invites, and history — there is no undo.
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
