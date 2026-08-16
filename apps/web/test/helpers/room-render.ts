/**
 * Shared harness for SSR-rendering room components (`react-dom/server`) in
 * this package's node-environment vitest — same approach as
 * extension-gate.test.ts, extended with a real <RoomProvider> whose
 * server-authoritative store is seeded per render.
 *
 * Seeding works by mutating the store's INITIAL state as well as setting the
 * live state: zustand v5 answers React's server render from
 * `getInitialState()`, so a plain `setState` alone would be invisible to
 * `renderToStaticMarkup`. `<Seeded>` does both during its own render, which in
 * the single-pass server renderer is guaranteed to run before its children
 * read the store. Every render mounts a fresh RoomProvider (fresh
 * RoomConnection, fresh stores), so mutations never leak across cases.
 */
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  InviteCode,
  MediaRef,
  Member,
  PlaybackState,
  QueueItem,
  QueueItemId,
  Room,
  RoomId,
  UserId,
} from '@gather/contracts';
import type { RoomState } from '@/lib/room-connection';

// `tsconfig.json` sets `jsx: "preserve"` (Next compiles JSX itself), so
// vitest's esbuild compiles this package's .tsx to the CLASSIC runtime and
// every component reaches for a free variable `React` at render time. Publish
// it before the component modules are evaluated; the dynamic import below is
// what defers their evaluation past this line.
(globalThis as unknown as { React: typeof React }).React = React;

const roomContext = await import('@/lib/room-context');
export const { RoomProvider } = roomContext;
const { useRoomConnection } = roomContext;

export const h = React.createElement;

export const ROOM_ID = 'room-static' as RoomId;
export const ME = 'user-me' as UserId;

export function makeRoom(kind: Room['kind'], over: Partial<Room> = {}): Room {
  return {
    id: ROOM_ID,
    kind,
    name: 'Static test room',
    inviteCode: 'ABCD2345' as InviteCode,
    ownerId: ME,
    policies: {
      playbackControl: 'everyone',
      queueControl: 'everyone',
      chat: 'everyone',
      maxPublishers: 8,
      waitForAll: true,
      skipVoteThreshold: 0.5,
    },
    relayMode: 'mesh',
    theater: false,
    expiresAt: null,
    createdAt: 1_000,
    ...over,
  };
}

export function makeMember(role: Member['role']): Member {
  return { roomId: ROOM_ID, userId: ME, role, joinedAt: 1_000, banned: false };
}

export function playbackFor(mediaRef: MediaRef, queueIndex: number | null): PlaybackState {
  return { mediaRef, positionMs: 0, rate: 1, playing: true, serverTs: 1_000, seq: 1, queueIndex };
}

let itemCounter = 0;
export function queueItem(mediaRef: MediaRef, title: string): QueueItem {
  itemCounter += 1;
  return {
    id: `qi-${itemCounter}` as QueueItemId,
    mediaRef,
    title,
    durationMs: null,
    artworkUrl: null,
    addedBy: ME,
    votesToSkip: [],
  };
}

function Seeded({ patch, children }: { patch: Partial<RoomState>; children?: ReactNode }) {
  const connection = useRoomConnection();
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

/** Static-markup render of `node` inside a fresh RoomProvider + seeded store. */
export function renderInRoom(
  room: Room,
  member: Member,
  patch: Partial<RoomState>,
  node: ReactNode,
): string {
  // Children ride the props object: createElement's typing only accepts rest
  // children when the component declares its `children` prop optional.
  return renderToStaticMarkup(
    h(RoomProvider, {
      room,
      member,
      lastEventSeq: 0,
      children: h(Seeded, { patch, children: node }),
    }),
  );
}
