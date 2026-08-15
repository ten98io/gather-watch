'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Member, Room, RoomId } from '@playin/contracts';
import { api } from './api';
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
  room,
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
  const [connection] = useState(
    () =>
      new RoomConnection({
        api,
        roomId: room.id,
        ...(lastEventSeq === undefined ? {} : { initialSeq: lastEventSeq }),
        onGapLoss: () => {
          // A gap could not be backfilled: chat/queue/sync should refetch.
          toast.error('Connection hiccup — catching up…');
        },
      }),
  );

  useEffect(() => {
    connection.connect().catch(() => {
      toast.error('Could not connect to the room. Sign in again if this persists.');
    });
    return () => {
      connection.close();
    };
  }, [connection]);

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
