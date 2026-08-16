'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Member, Room, RoomId } from '@gather/contracts';
import { api } from './api';
import { presenceIdleStateFor } from './media-kind';
import { RoomConnection } from './room-connection';
import { toast } from '@/components/ui/toast';

/**
 * Room context — THE integration point for wave-2 pane workers.
 *
 * The room page creates exactly ONE RoomConnection here; every pane
 * (Stage/Chat/Queue/Call/People) consumes it via `useRoomConnection()` and
 * must never open its own socket.
 */
export interface RoomContextValue {
  room: Room;
  member: Member;
  connection: RoomConnection;
}

const RoomContext = createContext<RoomContextValue | null>(null);

export function RoomProvider({
  room: initialRoom,
  member,
  lastEventSeq,
  children,
}: {
  room: Room;
  member: Member;
  /** Room event-stream tip from GetRoomResponse; seeds replay dedupe. */
  lastEventSeq: number | undefined;
  children: ReactNode;
}) {
  const [room, setRoom] = useState(initialRoom);
  const [connection] = useState(
    () =>
      new RoomConnection({
        api,
        roomId: initialRoom.id,
        ...(lastEventSeq === undefined ? {} : { initialSeq: lastEventSeq }),
        onGapLoss: () => {
          // A gap could not be backfilled: chat/queue/sync should refetch.
          toast.error('Connection hiccup — catching up…');
        },
      }),
  );

  useEffect(() => {
    setRoom(initialRoom);
    connection.seedRoom(initialRoom);
  }, [connection, initialRoom]);

  useEffect(() => {
    connection.connect().catch(() => {
      toast.error('Could not connect to the room. Sign in again if this persists.');
    });
    void connection.loadRecentMessages().catch(() => undefined);
    // Live room entity: theater toggle / policy edits arrive as room.updated.
    const off = connection.on('room.updated', (ev) => setRoom(ev.payload));
    // The idle presence state follows what is PLAYING (music → 'listening'),
    // 'watching' when nothing does — the server no longer infers it from the
    // room, so this client must say it accurately.
    const idleState = (): 'watching' | 'listening' =>
      presenceIdleStateFor(connection.useRoomState.getState().playback?.mediaRef ?? null);
    // Announce presence whenever the socket (re)connects — the hub's default
    // entry is 'offline' until a client says otherwise, and peers render it.
    const offStatus = connection.useStatus.subscribe((status) => {
      if (status === 'live') {
        connection.presenceUpdate({ state: idleState() });
      }
    });
    // A mixed queue flows music↔video: re-announce when the playing item's
    // kind changes — but never overwrite the richer states a member is
    // actually in ('in-call', 'away'); those surfaces own their own updates.
    let lastIdle = idleState();
    const offPlayback = connection.useRoomState.subscribe((s) => {
      const next = presenceIdleStateFor(s.playback?.mediaRef ?? null);
      if (next === lastIdle) return;
      lastIdle = next;
      const mine = s.presence[member.userId]?.state;
      if (mine === 'in-call' || mine === 'away') return;
      if (connection.status !== 'live') return;
      connection.presenceUpdate({ state: next });
    });
    return () => {
      offPlayback();
      offStatus();
      off();
      connection.close();
    };
  }, [connection, member.userId]);

  return (
    <RoomContext.Provider value={{ room, member, connection }}>{children}</RoomContext.Provider>
  );
}

export function useRoom(): RoomContextValue {
  const ctx = useContext(RoomContext);
  if (ctx === null) throw new Error('useRoom must be used within <RoomProvider>');
  return ctx;
}

/** The shared realtime connection for this room (one per room, never per pane). */
export function useRoomConnection(): RoomConnection {
  return useRoom().connection;
}

export type { RoomId };
