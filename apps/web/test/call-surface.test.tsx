// @vitest-environment jsdom
/**
 * CallSurface — the call as the ROOM sees it, not as the server's presence
 * echo happens to describe it at one instant.
 *
 * The field report this file exists for: "each participant had to join, start
 * the call, turn on video or audio, and then REFRESH the browser tab and join
 * again for the video to work." Two app-layer causes, both asserted here:
 *
 *   • A tile that renders only while a peer's presence says 'in-call' makes the
 *     roster a function of a server round trip. Any client that re-announces
 *     its idle state ('watching'/'listening') for one beat — the playback
 *     subscriber in room-context does exactly that — blanks its own tile on
 *     every other screen, while its microphone is still arriving.
 *   • Every failure in the call path used to be swallowed (an empty onError),
 *     which is what "it just doesn't work, no idea why" is made of.
 *
 * jsdom, because both behaviours are effect behaviours: a store write has to
 * flow through the provider's memo, and a mesh failure has to reach a toast.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Member,
  PresenceEntry,
  Room,
  RoomId,
  TurnCredentialsResponse,
  UserId,
} from '@gather/contracts';
import type { RoomConnection } from '@/lib/room-connection';
import type { CallParticipant } from '@/components/call/CallSurface';

// Same classic-runtime workaround as context-menu.test.tsx / room-render.ts:
// `jsx: "preserve"` means vitest's esbuild emits React.createElement calls.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = 'room_test' as RoomId;
const ME = 'user_me' as UserId;
const PEER = 'user_peer' as UserId;

const CREDENTIALS: TurnCredentialsResponse = {
  iceServers: [{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }],
  ttlSeconds: 0,
  fairUseRemainingGb: null,
};

/* ── module doubles ──────────────────────────────────────────────────────── */

const turnStub = vi.hoisted(() => ({
  fetch: (): Promise<unknown> => Promise.resolve(undefined),
}));
const roomStub = vi.hoisted(() => ({
  connection: null as unknown,
  room: null as unknown,
  member: null as unknown,
}));

vi.mock('@/lib/api', () => ({
  api: {
    rtc: { turnCredentials: () => turnStub.fetch() },
    rooms: { listMembers: () => Promise.resolve({ members: [] }) },
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { members: [] }, refetch: () => Promise.resolve(undefined) }),
}));
vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => roomStub.connection,
  useRoom: () => ({ room: roomStub.room, member: roomStub.member }),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

const { toast } = await import('@/components/ui/toast');
const { CALL_SETUP_NOTE, closeCallMesh, getCallMesh } = await import('@/lib/call-mesh');
const {
  CallSessionProvider,
  PRESENCE_BRIDGE_MS,
  callPeerIds,
  shouldDuckContent,
  useCallSession,
} = await import('@/components/call/CallSurface');
const { getSpeechActive, getVoiceActive, resetRoomAudio } = await import(
  '@/lib/player/room-audio'
);

/* ── fakes ───────────────────────────────────────────────────────────────── */

class FakeTrack {
  enabled = true;
  constructor(
    readonly id: string,
    readonly kind: 'audio' | 'video',
  ) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  stop(): void {}
}

const track = (id: string, kind: 'audio' | 'video'): MediaStreamTrack =>
  new FakeTrack(id, kind) as unknown as MediaStreamTrack;

class FakePc {
  static instances: FakePc[] = [];
  localDescription: { type: string; sdp: string } | null = { type: 'offer', sdp: 'sdp' };
  remoteDescription: unknown = null;
  signalingState = 'stable';
  connectionState = 'new';
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((ev: { track: unknown; streams: unknown[] }) => void) | null = null;
  ondatachannel: ((ev: { channel: unknown }) => void) | null = null;
  static reset(): void {
    FakePc.instances = [];
  }
  constructor() {
    FakePc.instances.push(this);
  }
  createOffer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: 'offer', sdp: 'sdp' });
  }
  createAnswer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: 'answer', sdp: 'sdp' });
  }
  setLocalDescription(): Promise<void> {
    return Promise.resolve();
  }
  setRemoteDescription(): Promise<void> {
    return Promise.resolve();
  }
  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }
  addTrack(t: unknown): { track: unknown; getParameters(): { encodings: [] } } {
    return { track: t, getParameters: () => ({ encodings: [] }) };
  }
  removeTrack(): void {}
  getSenders(): unknown[] {
    return [];
  }
  createDataChannel(label: string): { label: string; close(): void; send(): void } {
    return { label, close: () => undefined, send: () => undefined };
  }
  close(): void {}
  emitTrack(t: MediaStreamTrack): void {
    this.ontrack?.({ track: t, streams: [] });
  }
  setConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const presenceEntry = (
  userId: UserId,
  state: PresenceEntry['state'],
  over: Partial<PresenceEntry> = {},
): PresenceEntry => ({
  userId,
  state,
  micOn: true,
  camOn: false,
  sharing: false,
  lastSeenTs: 0,
  ...over,
});

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

interface RoomStoreState {
  presence: Record<UserId, PresenceEntry>;
  playback: null;
  membersVersion: number;
}

function fakeConnection(initial: Record<UserId, PresenceEntry>): {
  connection: RoomConnection;
  setPresence(next: Record<UserId, PresenceEntry>): void;
  presenceUpdates: Array<Record<string, unknown>>;
} {
  const useRoomState = create<RoomStoreState>()(() => ({
    presence: initial,
    playback: null,
    membersVersion: 0,
  }));
  const presenceUpdates: Array<Record<string, unknown>> = [];
  const connection = {
    roomId: ROOM_ID,
    useRoomState,
    rawSocket: { send: () => undefined },
    on: () => () => undefined,
    presenceUpdate: (patch: Record<string, unknown>) => presenceUpdates.push(patch),
  } as unknown as RoomConnection;
  return {
    connection,
    setPresence: (next) => useRoomState.setState({ presence: next }),
    presenceUpdates,
  };
}

/** Drain microtasks (the credential settle rides one). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** The roster, as any pane would read it. */
function Probe() {
  const call = useCallSession();
  return <div data-testid="roster">{call.participants.map((p) => p.userId).join(',')}</div>;
}

let host: HTMLDivElement;
let root: Root;

const roster = (): string => host.querySelector('[data-testid="roster"]')?.textContent ?? '';

describe('CallSurface roster', () => {
  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.resolve(CREDENTIALS);
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  const mount = async (presence: Record<UserId, PresenceEntry>) => {
    const conn = fakeConnection(presence);
    roomStub.connection = conn.connection;
    roomStub.room = room();
    roomStub.member = member();
    await act(async () => {
      root.render(
        <CallSessionProvider>
          <Probe />
        </CallSessionProvider>,
      );
      await settle();
    });
    return conn;
  };

  it('keeps a peer whose media is live when their presence blips out of the call', async () => {
    const conn = await mount({ [PEER]: presenceEntry(PEER, 'in-call') });
    expect(roster()).toBe(PEER);

    // Their microphone arrives — from here on, media is the evidence.
    await act(async () => {
      FakePc.instances[0]?.emitTrack(track('mic-peer', 'audio'));
      await settle();
    });
    expect(roster()).toBe(PEER);

    // The blip: their client re-announces an idle state for one beat. Nothing
    // about their media changed, so nothing about their tile may change.
    await act(async () => {
      conn.setPresence({ [PEER]: presenceEntry(PEER, 'listening') });
      await settle();
    });

    expect(roster()).toBe(PEER);
  });

  it('stops showing a peer once the bridge runs out — the roster never lies', async () => {
    vi.useFakeTimers();
    try {
      const conn = await mount({ [PEER]: presenceEntry(PEER, 'in-call') });
      await act(async () => {
        FakePc.instances[0]?.emitTrack(track('mic-peer', 'audio'));
        await settle();
      });
      // A real departure looks exactly like a blip for the first instant…
      await act(async () => {
        conn.setPresence({ [PEER]: presenceEntry(PEER, 'watching', { micOn: false }) });
        await settle();
      });
      expect(roster()).toBe(PEER);

      // …and stops looking like one when nothing takes it back.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PRESENCE_BRIDGE_MS + 100);
      });

      expect(roster()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bridges a peer whose presence has only just stopped saying in-call', () => {
    const now = 100_000;
    expect(
      callPeerIds({
        me: ME,
        presence: { [PEER]: presenceEntry(PEER, 'listening') },
        trackPeers: new Set([PEER]),
        everInCall: new Set([PEER]),
        // The transition is younger than the bookkeeping that records it.
        leftCallAt: new Map(),
        now,
      }),
    ).toEqual([PEER]);
  });

  it('drops a peer who really left, even though a track object lingers', () => {
    const now = 100_000;
    const presence = { [PEER]: presenceEntry(PEER, 'watching', { micOn: false }) };
    expect(
      callPeerIds({
        me: ME,
        presence,
        trackPeers: new Set([PEER]),
        everInCall: new Set([PEER]),
        // They stopped being in the call longer ago than the bridge allows.
        leftCallAt: new Map([[PEER, now - PRESENCE_BRIDGE_MS - 1]]),
        now,
      }),
    ).toEqual([]);
  });

  it('never counts a screen-sharer who is not in the call as a caller', () => {
    const now = 100_000;
    expect(
      callPeerIds({
        me: ME,
        presence: { [PEER]: presenceEntry(PEER, 'watching', { sharing: true }) },
        // A share publishes video through the same mesh; it is not a call.
        trackPeers: new Set([PEER]),
        everInCall: new Set(),
        leftCallAt: new Map(),
        now,
      }),
    ).toEqual([]);
  });

  it('surfaces a call failure to the user in one plain sentence', async () => {
    turnStub.fetch = () => Promise.reject(new Error('offline'));
    const conn = await mount({ [PEER]: presenceEntry(PEER, 'in-call') });

    // The moment media is at stake — this is what join() does with the mic.
    await act(async () => {
      getCallMesh(conn.connection, ME).setLocalTrack('mic', track('mic-local', 'audio'));
      await settle();
    });

    expect(vi.mocked(toast.error).mock.calls.map((c) => c[0])).toEqual([CALL_SETUP_NOTE]);
    closeCallMesh(conn.connection);
  });
});

/**
 * The call surface is the only place in the app that knows both "who has a
 * microphone open" and "who is making noise right now". The content player
 * needs both and cannot see either, so this is where they are published
 * (lib/player/room-audio.ts). What is asserted here is that the two signals
 * stay APART — they are read from different sources, on different timescales,
 * and are consumed by different machinery.
 */
describe('CallSurface publishes the room-audio signals', () => {
  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.resolve(CREDENTIALS);
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    resetRoomAudio();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    resetRoomAudio();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  const mount = async (presence: Record<UserId, PresenceEntry>) => {
    const conn = fakeConnection(presence);
    roomStub.connection = conn.connection;
    roomStub.room = room();
    roomStub.member = member();
    await act(async () => {
      root.render(
        <CallSessionProvider>
          <Probe />
        </CallSessionProvider>,
      );
      await settle();
    });
    return conn;
  };

  it('drives the sync band from presence mic state, and lets it go when the mics close', async () => {
    const conn = await mount({
      [ME]: presenceEntry(ME, 'in-call', { micOn: true }),
      [PEER]: presenceEntry(PEER, 'watching', { micOn: false }),
    });
    expect(getVoiceActive()).toBe(true);

    await act(async () => {
      conn.setPresence({
        [ME]: presenceEntry(ME, 'watching', { micOn: false }),
        [PEER]: presenceEntry(PEER, 'watching', { micOn: false }),
      });
      await settle();
    });
    expect(getVoiceActive()).toBe(false);
  });

  it('does not tighten the band for one person talking to an empty room', async () => {
    await mount({ [ME]: presenceEntry(ME, 'in-call', { micOn: true }) });
    expect(getVoiceActive()).toBe(false);
  });

  /** A publisher that unmounts without standing its signals down leaves the
   *  player tightened, or ducked, forever — with nothing on screen to explain
   *  either. */
  it('stands both signals down when the call surface goes away', async () => {
    await mount({
      [ME]: presenceEntry(ME, 'in-call', { micOn: true }),
      [PEER]: presenceEntry(PEER, 'in-call', { micOn: true }),
    });
    expect(getVoiceActive()).toBe(true);

    act(() => root.unmount());
    expect(getVoiceActive()).toBe(false);
    expect(getSpeechActive()).toBe(false);

    // afterEach unmounts again; a second unmount of the same root is a no-op.
    root = createRoot(host);
  });
});

describe('what may duck the content', () => {
  const participant = (over: Partial<CallParticipant>): CallParticipant => ({
    userId: PEER,
    name: 'Peer',
    avatarUrl: null,
    accentColor: null,
    isMe: false,
    micOn: true,
    camOn: false,
    sharing: false,
    speaking: false,
    videoTrack: null,
    linkStatus: 'ok',
    ...over,
  });

  it('ducks for a peer who is actually making sound', () => {
    expect(
      shouldDuckContent({
        participants: [participant({ speaking: true })],
        soundBlocked: false,
      }),
    ).toBe(true);
    expect(
      shouldDuckContent({ participants: [participant({ speaking: false })], soundBlocked: false }),
    ).toBe(false);
  });

  /**
   * My own microphone must never duck my own content. Echo cancellation is
   * referenced against what the browser is rendering, not against arbitrary
   * page audio, so a loud film leaks into my own mic — and a duck driven by
   * my own mic would then be a loop: film leaks in, level drops, leak stops,
   * level climbs, leak returns. The film would breathe on its own with nobody
   * saying a word.
   */
  it('never ducks for my own microphone', () => {
    expect(
      shouldDuckContent({
        participants: [participant({ userId: ME, isMe: true, speaking: true })],
        soundBlocked: false,
      }),
    ).toBe(false);
  });

  /**
   * A3/B6 tail. The speaking ring is measured off the raw tracks by an
   * AnalyserNode, which keeps working while autoplay policy is refusing the
   * <audio> sinks. Ducking on that reading would take the film away from
   * someone to make room for voices they cannot hear at all.
   */
  it('does not duck while this browser is refusing to play the call', () => {
    expect(
      shouldDuckContent({ participants: [participant({ speaking: true })], soundBlocked: true }),
    ).toBe(false);
  });
});
