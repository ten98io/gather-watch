// @vitest-environment jsdom
/**
 * The room provider must not announce you out of a call you just joined.
 *
 * `inCallIntent` (lib/call-mesh.ts) exists precisely for this caller and its
 * docstring names it: the playback subscriber in RoomProvider flips
 * 'watching'/'listening' as a mixed queue moves between music and video, and
 * it decided whether to keep quiet by reading the server's ECHO of your own
 * presence. The echo is a full round trip behind the truth, so a sync.state
 * landing within one RTT of pressing Join overwrote 'in-call' — and every
 * other client dropped your tile. Local intent is the only thing that is
 * never late.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member, Room, RoomId, UserId } from '@gather/contracts';
import type { RoomConnection } from '@/lib/room-connection';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = 'room_intent' as RoomId;
const ME = 'user_me' as UserId;

vi.mock('@/lib/api', () => ({
  // No token: connect() rejects fast and the provider says so through the
  // mocked toast. Nothing here needs a socket — the subscriber under test
  // runs off the store.
  ensureAccessToken: () => Promise.resolve(null),
  WS_URL: 'ws://api.test/ws',
  api: {},
}));
vi.mock('@/components/ui/toast', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { closeCallMesh, setCallIntent } = await import('@/lib/call-mesh');

const room = (): Room => ({
  id: ROOM_ID,
  kind: 'watch',
  name: 'Test room',
  inviteCode: 'ABCD2345' as Room['inviteCode'],
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
  hasPassword: false,
  createdAt: 1_000,
});

const member = (): Member => ({
  roomId: ROOM_ID,
  userId: ME,
  role: 'host',
  joinedAt: 1_000,
  banned: false,
});

let captured: RoomConnection | null = null;

function Grab() {
  captured = useRoomConnection();
  return null;
}

let host: HTMLDivElement;
let root: Root;

/** The mixed queue moving from a video item to a music item — the exact
 *  change that makes the subscriber want to re-announce. */
const musicPlayback = {
  mediaRef: { kind: 'soundcloud' as const, url: 'https://soundcloud.com/a/b' },
  positionMs: 0,
  rate: 1,
  playing: true,
  serverTs: 1_000,
  seq: 1,
  queueIndex: 0,
};

describe('playback re-announce vs. a call you just joined', () => {
  beforeEach(async () => {
    captured = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <RoomProvider room={room()} member={member()} lastEventSeq={0}>
          <Grab />
        </RoomProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    if (captured !== null) closeCallMesh(captured);
  });

  it('stays quiet while this client means to be in the call, echo or no echo', async () => {
    const conn = captured;
    if (conn === null) throw new Error('no connection');
    conn.useStatus.setState('live');
    const spy = vi.spyOn(conn, 'presenceUpdate').mockImplementation(() => undefined);

    // Join: the intent is local and immediate. The server's presence echo
    // still says nothing about us — that is the whole window this guards.
    setCallIntent(conn, true);

    await act(async () => {
      conn.useRoomState.setState({ playback: musicPlayback });
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('still follows the playing item when this client is not calling', async () => {
    const conn = captured;
    if (conn === null) throw new Error('no connection');
    conn.useStatus.setState('live');
    const spy = vi.spyOn(conn, 'presenceUpdate').mockImplementation(() => undefined);

    await act(async () => {
      conn.useRoomState.setState({ playback: musicPlayback });
    });

    expect(spy).toHaveBeenCalledWith({ state: 'listening' });
  });
});
