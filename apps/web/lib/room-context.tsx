'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Member, Room, RoomId } from '@gather/contracts';
import { api } from './api';
import { inCallIntent } from './call-mesh';
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

/**
 * The context itself carries the join-response SNAPSHOTS plus the connection;
 * `useRoom` overlays the live store on top, so a promotion, demotion, or host
 * transfer reaches every permission gate without a rejoin. Consumers never
 * see this shape.
 */
interface RoomContextSeed {
  snapshotRoom: Room;
  snapshotMember: Member;
  connection: RoomConnection;
}

const RoomContext = createContext<RoomContextSeed | null>(null);

export function RoomProvider({
  room: initialRoom,
  member: initialMember,
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
        roomId: initialRoom.id,
        // Lets the connection's presence keepalive re-assert THIS member's
        // current state (in-call, sharing, away) instead of an idle default.
        userId: initialMember.userId,
        ...(lastEventSeq === undefined ? {} : { initialSeq: lastEventSeq }),
        onGapLoss: () => {
          // A gap could not be backfilled: chat/queue/sync should refetch.
          toast.error('Connection hiccup — catching up…');
        },
      }),
  );

  useEffect(() => {
    connection.seedRoom(initialRoom);
    connection.seedMember(initialMember);
  }, [connection, initialRoom, initialMember]);

  useEffect(() => {
    connection.connect().catch(() => {
      toast.error('Couldn’t connect to the room. Sign in again if this persists.');
    });
    void connection.loadRecentMessages().catch(() => undefined);
    // The idle presence state follows what is PLAYING (music → 'listening'),
    // 'watching' when nothing does — the server no longer infers it from the
    // room, so this client must say it accurately.
    const idleState = (): 'watching' | 'listening' =>
      presenceIdleStateFor(connection.useRoomState.getState().playback?.mediaRef ?? null);
    // The on-connect announce used to live here. It now rides the connection's
    // own open frame (RoomConnection.requestRoomSnapshot), which carries
    // `wantSnapshot` as well — two frames per open would mean two full room
    // snapshots, and the second one has nothing to add. What this provider
    // still owns is the part the connection cannot know: which idle state the
    // PLAYING item implies, re-announced below whenever that changes. On a
    // fresh open the store has no playback yet, so there is nothing accurate
    // to say until the snapshot lands — and when it lands, this fires.
    //
    // A mixed queue flows music↔video: re-announce when the playing item's
    // kind changes — but never overwrite the richer states a member is
    // actually in ('in-call', 'away'); those surfaces own their own updates.
    //
    // 'in-call' is asked of LOCAL INTENT first (call-mesh's inCallIntent) and
    // only then of the server's echo. The echo is a full round trip behind:
    // a sync.state landing inside that window used to overwrite the 'in-call'
    // we had just announced, and every other client dropped our tile until
    // the reassert loop clawed it back.
    let lastIdle = idleState();
    const offPlayback = connection.useRoomState.subscribe((s) => {
      const next = presenceIdleStateFor(s.playback?.mediaRef ?? null);
      if (next === lastIdle) return;
      lastIdle = next;
      if (inCallIntent(connection)) return;
      const mine = s.presence[initialMember.userId]?.state;
      if (mine === 'in-call' || mine === 'away') return;
      if (connection.status !== 'live') return;
      connection.presenceUpdate({ state: next });
    });
    return () => {
      offPlayback();
      connection.close();
    };
  }, [connection, initialMember.userId]);

  const seed = useMemo(
    () => ({ snapshotRoom: initialRoom, snapshotMember: initialMember, connection }),
    [connection, initialRoom, initialMember],
  );

  return <RoomContext.Provider value={seed}>{children}</RoomContext.Provider>;
}

export function useRoom(): RoomContextValue {
  const ctx = useContext(RoomContext);
  if (ctx === null) throw new Error('useRoom must be used within <RoomProvider>');
  const { connection, snapshotRoom, snapshotMember } = ctx;
  // Live overlays: seeded from the join response, advanced by room.updated /
  // member.updated — so every gate (canAct, host checks, theater visibility)
  // follows a role change with no rejoin. The reducers keep identities stable
  // when content is unchanged, so effects keyed on these objects stay quiet
  // across unrelated events (presence, chat, sync ticks).
  const liveRoom = connection.useRoomState((s) => s.room);
  const liveMember = connection.useRoomState((s) => s.members[snapshotMember.userId]);
  return {
    room: liveRoom ?? snapshotRoom,
    member: liveMember ?? snapshotMember,
    connection,
  };
}

/** The shared realtime connection for this room (one per room, never per pane). */
export function useRoomConnection(): RoomConnection {
  const ctx = useContext(RoomContext);
  if (ctx === null) throw new Error('useRoomConnection must be used within <RoomProvider>');
  return ctx.connection;
}

export type { RoomId };
