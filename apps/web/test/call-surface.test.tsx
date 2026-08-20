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
import type { CallParticipant, CallSessionValue } from '@/components/call/CallSurface';

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
  /** `streams` carries the sender's msid — the only thing a role can be
   *  named from (call-mesh.test.ts uses the same shape). */
  emitTrack(t: MediaStreamTrack, streams: unknown[] = []): void {
    this.ontrack?.({ track: t, streams });
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
  /** Deliver one server-relayed signalling frame, as the hub would stamp it. */
  deliver(type: string, payload: Record<string, unknown>): void;
} {
  const useRoomState = create<RoomStoreState>()(() => ({
    presence: initial,
    playback: null,
    membersVersion: 0,
  }));
  const presenceUpdates: Array<Record<string, unknown>> = [];
  const inbound = new Map<string, Set<(ev: unknown) => void>>();
  const connection = {
    roomId: ROOM_ID,
    useRoomState,
    rawSocket: { send: () => undefined },
    on: (type: string, fn: (ev: unknown) => void) => {
      const set = inbound.get(type) ?? new Set<(ev: unknown) => void>();
      set.add(fn);
      inbound.set(type, set);
      return () => set.delete(fn);
    },
    presenceUpdate: (patch: Record<string, unknown>) => presenceUpdates.push(patch),
  } as unknown as RoomConnection;
  return {
    connection,
    setPresence: (next) => useRoomState.setState({ presence: next }),
    presenceUpdates,
    deliver: (type, payload) => {
      for (const fn of [...(inbound.get(type) ?? [])]) {
        fn({ type, roomId: ROOM_ID, seq: 1, ts: 0, payload });
      }
    },
  };
}

/** Drain microtasks (the credential settle rides one). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** The roster, as any pane would read it — and the session, for assertions
 *  that need a participant's fields rather than the id line. */
let session: CallSessionValue | null = null;
function Probe() {
  const call = useCallSession();
  session = call;
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
 * A sharing peer's tile — the Meet behaviour, owner-confirmed twice.
 *
 * The old rule ("a sharing peer shows the avatar, the mesh cannot tell their
 * camera from their screen") was justified by a limitation that no longer
 * exists: track roles ride the wire, so a track named 'cam' is the face
 * whatever else its owner publishes. What stays binding is the interop rule —
 * a role of NULL (an older client that announces nothing) keeps the pre-role
 * behaviour, avatar while sharing, because their unnamed video may BE the
 * screen and a tile must never render the stage's track.
 */
describe('a sharing peer’s tile video', () => {
  beforeEach(() => {
    FakePc.reset();
    session = null;
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.resolve(CREDENTIALS);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
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

  /** One role announcement, as the hub relays it from the peer. */
  const announce = (
    conn: ReturnType<typeof fakeConnection>,
    role: string,
    streamId: string,
  ): void => {
    conn.deliver('webrtc.offer', {
      fromUserId: PEER,
      targetUserId: ME,
      connectionId: `mesh:room_test:role:${role}:${streamId}`,
      sdp: '',
    });
  };

  const peer = (): CallParticipant | undefined =>
    session?.participants.find((p) => p.userId === PEER);

  it('keeps a sharing peer’s named camera on their tile, never their screen', async () => {
    const conn = await mount({
      [PEER]: presenceEntry(PEER, 'in-call', { camOn: true, sharing: true }),
    });
    await act(async () => {
      announce(conn, 'cam', 'peer-cam');
      announce(conn, 'share', 'peer-share');
      FakePc.instances[0]?.emitTrack(track('cam-1', 'video'), [{ id: 'peer-cam' }]);
      // The screen arrives NEWER — under a newest-video rule this is the
      // mid-scramble that puts the shared screen in a 44px circle.
      FakePc.instances[0]?.emitTrack(track('screen-1', 'video'), [{ id: 'peer-share' }]);
      await settle();
    });

    expect(peer()?.sharing).toBe(true);
    expect(peer()?.videoTrack?.id).toBe('cam-1');
  });

  it('keeps the avatar for a sharing peer whose client cannot name the track', async () => {
    const conn = await mount({
      [PEER]: presenceEntry(PEER, 'in-call', { camOn: true, sharing: true }),
    });
    await act(async () => {
      // No announcement ever lands: the mesh answers null, not a guess.
      FakePc.instances[0]?.emitTrack(track('video-1', 'video'), [{ id: 'unannounced' }]);
      await settle();
    });
    expect(peer()?.videoTrack).toBeNull();

    // The same unnamed track still renders once they stop sharing — the
    // pre-role behaviour, kept exactly.
    await act(async () => {
      conn.setPresence({
        [PEER]: presenceEntry(PEER, 'in-call', { camOn: true, sharing: false }),
      });
      await settle();
    });
    expect(peer()?.videoTrack?.id).toBe('video-1');
  });

  it('never puts a share-role track on a tile, even before presence says "sharing"', async () => {
    // The mid-scramble: the share track crosses the mesh ahead of the presence
    // write that flips `sharing` — a round trip apart by construction. During
    // that window the old `!sharing` gate is open, so only the ROLE stands
    // between the stage's track and a second element on a tile.
    const conn = await mount({
      [PEER]: presenceEntry(PEER, 'in-call', { camOn: true, sharing: false }),
    });
    await act(async () => {
      announce(conn, 'share', 'peer-share');
      FakePc.instances[0]?.emitTrack(track('screen-1', 'video'), [{ id: 'peer-share' }]);
      await settle();
    });

    // camOn presence notwithstanding, the only video is the stage's.
    expect(peer()?.videoTrack).toBeNull();
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

/**
 * The speaking-detection AudioContext, across a tab suspension.
 *
 * Browsers suspend WebAudio when a tab sits in the background; a context
 * resumed once at build and never again reads flat silence from then on, so
 * the speaking rings and the duck died quietly after a background stint. The
 * fix resumes on demand — the poll tick, and the visibility flip — and this
 * suite drives a context that genuinely goes silent while not 'running', so
 * the assertions are about the SIGNAL surviving, not about a resume() call.
 */
describe('speaking detection survives a tab suspension', () => {
  /** Hears speech only while its context is running — a suspended graph in
   *  real browsers stops producing data, which is the whole failure mode. */
  class FakeAnalyser {
    fftSize = 512;
    smoothingTimeConstant = 0;
    constructor(private readonly ctx: FakeAudioContext) {}
    connect(): void {}
    disconnect(): void {}
    getByteTimeDomainData(data: Uint8Array): void {
      data.fill(this.ctx.state === 'running' ? 255 : 128);
    }
  }
  class FakeAudioContext {
    static instances: FakeAudioContext[] = [];
    state: 'suspended' | 'running' | 'closed' = 'suspended';
    resumeCalls = 0;
    destination = {};
    constructor() {
      FakeAudioContext.instances.push(this);
    }
    resume(): Promise<void> {
      this.resumeCalls += 1;
      this.state = 'running';
      return Promise.resolve();
    }
    close(): Promise<void> {
      this.state = 'closed';
      return Promise.resolve();
    }
    createGain(): { gain: { value: number }; connect(): void; disconnect(): void } {
      return { gain: { value: 0 }, connect: () => undefined, disconnect: () => undefined };
    }
    createMediaStreamSource(): { connect(): void; disconnect(): void } {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    createAnalyser(): FakeAnalyser {
      return new FakeAnalyser(this);
    }
  }
  class FakeMediaStream {
    constructor(private readonly tracks: MediaStreamTrack[] = []) {}
    getTracks(): MediaStreamTrack[] {
      return [...this.tracks];
    }
    getAudioTracks(): MediaStreamTrack[] {
      return this.tracks.filter((t) => t.kind === 'audio');
    }
    getVideoTracks(): MediaStreamTrack[] {
      return this.tracks.filter((t) => t.kind === 'video');
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakePc.reset();
    FakeAudioContext.instances = [];
    session = null;
    resetRoomAudio();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    (globalThis as { MediaStream?: unknown }).MediaStream = FakeMediaStream;
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: () => Promise.resolve(),
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () =>
          Promise.resolve(new FakeMediaStream([track('mic-local', 'audio')]) as unknown),
      },
    });
    turnStub.fetch = () => Promise.resolve(CREDENTIALS);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    resetRoomAudio();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    delete (globalThis as { MediaStream?: unknown }).MediaStream;
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    vi.useRealTimers();
  });

  it('keeps the duck signal alive after the context is suspended and back', async () => {
    const conn = fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') });
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
    await act(async () => {
      session?.join();
      await settle();
    });
    await act(async () => {
      FakePc.instances[0]?.emitTrack(track('mic-peer', 'audio'));
      await settle();
    });

    // The measured path, end to end: analyser hears the peer, the duck signal
    // publishes. (The context started 'suspended', as real ones do — the
    // build-time resume is what brings it up the first time.)
    const ctx = FakeAudioContext.instances.at(-1);
    expect(ctx).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(getSpeechActive()).toBe(true);
    const resumesBefore = ctx?.resumeCalls ?? 0;

    // THE SUSPENSION: the browser parks the tab's audio. No event reaches the
    // page, the interval survives (throttled), the graph reads silence.
    if (ctx !== undefined) ctx.state = 'suspended';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    // The poll notices and resumes: the signal is still alive, not frozen at
    // a stale reading and not silently dead.
    expect(ctx?.state).toBe('running');
    expect(ctx?.resumeCalls ?? 0).toBeGreaterThan(resumesBefore);
    expect(getSpeechActive()).toBe(true);

    // And the visibility flip is the earliest wake — it resumes immediately,
    // before any throttled timer gets around to it.
    if (ctx !== undefined) ctx.state = 'suspended';
    const resumesBeforeFlip = ctx?.resumeCalls ?? 0;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(ctx?.state).toBe('running');
    expect(ctx?.resumeCalls ?? 0).toBeGreaterThan(resumesBeforeFlip);
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
