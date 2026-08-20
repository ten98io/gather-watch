// @vitest-environment jsdom
/**
 * Share sound, and the tap that rescues it.
 *
 * Owner's words, from a live session: "screenshare is inconsistent… audio has
 * not worked till [now]". Three separate reasons, all asserted here:
 *
 *   • The share viewer threw every audio track away (`track.kind !== 'video'`
 *     → return), and the only remote <audio> element in the app was gated on
 *     being IN THE CALL. So a viewer watching a share who had not joined the
 *     call could not hear it. Ever.
 *   • The viewer accumulated video tracks and never removed stale ones, so a
 *     renegotiated share kept rendering a dead first track.
 *   • `void el.play().catch(() => undefined)` — a refused autoplay policy
 *     meant permanent silence with nothing to click and nothing said.
 *
 * jsdom, because every one of these is an effect reaching a media element.
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
  RestreamState,
  Room,
  RoomId,
  TurnCredentialsResponse,
  UserId,
} from '@gather/contracts';
import type { RoomConnection } from '@/lib/room-connection';

// `jsx: "preserve"` means vitest's esbuild emits classic React.createElement
// calls; publish React before the component modules are evaluated.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = 'room_share_sound' as RoomId;
const ME = 'user_me' as UserId;
const HOST = 'user_host' as UserId;

const CREDENTIALS: TurnCredentialsResponse = {
  iceServers: [{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }],
  ttlSeconds: 0,
  fairUseRemainingGb: null,
};

/* ── module doubles ──────────────────────────────────────────────────────── */

const roomStub = vi.hoisted(() => ({
  connection: null as unknown,
  room: null as unknown,
  member: null as unknown,
}));

vi.mock('@/lib/api', () => ({
  api: {
    rtc: { turnCredentials: () => Promise.resolve(CREDENTIALS) },
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

const { closeCallMesh } = await import('@/lib/call-mesh');
const { ScreenShareStage, SHARE_SOUND_BLOCKED_LABEL, resetShareHost } = await import(
  '@/components/stage/ScreenShareStage'
);
const { CALL_SOUND_BLOCKED_LABEL, CallSessionProvider, useCallSession } = await import(
  '@/components/call/CallSurface'
);
import type { CallSessionValue } from '@/components/call/CallSurface';

/* ── fakes ───────────────────────────────────────────────────────────────── */

class FakeTrack {
  enabled = true;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(
    readonly id: string,
    readonly kind: 'audio' | 'video',
  ) {}
  addEventListener(type: string, fn: () => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  stop(): void {}
}

const track = (id: string, kind: 'audio' | 'video'): MediaStreamTrack =>
  new FakeTrack(id, kind) as unknown as MediaStreamTrack;

/** jsdom ships no MediaStream; the sinks build one per element. */
class FakeMediaStream {
  private readonly tracks: MediaStreamTrack[] = [];
  constructor(initial: MediaStreamTrack[] = []) {
    this.tracks.push(...initial);
  }
  getTracks(): MediaStreamTrack[] {
    return [...this.tracks];
  }
  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(t: MediaStreamTrack): void {
    if (!this.tracks.includes(t)) this.tracks.push(t);
  }
  removeTrack(t: MediaStreamTrack): void {
    const i = this.tracks.indexOf(t);
    if (i >= 0) this.tracks.splice(i, 1);
  }
}

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
  ownerId: HOST,
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
  role: 'member',
  joinedAt: 1_000,
  banned: false,
});

const liveRestream = (hostUserId: UserId): RestreamState => ({
  active: true,
  hostUserId,
  startedAt: 1_000,
  viewerCount: 1,
  uplinkQuality: null,
});

interface RoomStoreState {
  presence: Record<UserId, PresenceEntry>;
  playback: null;
  restream: RestreamState | null;
  membersVersion: number;
}

/** A room connection the tests can also push server-relayed frames through. */
type TestConnection = RoomConnection & {
  deliver(type: string, payload: Record<string, unknown>): void;
};

function fakeConnection(initial: Record<UserId, PresenceEntry>): TestConnection {
  const useRoomState = create<RoomStoreState>()(() => ({
    presence: initial,
    playback: null,
    restream: liveRestream(HOST),
    membersVersion: 0,
  }));
  const inbound = new Map<string, Set<(ev: unknown) => void>>();
  return {
    roomId: ROOM_ID,
    useRoomState,
    rawSocket: { send: () => undefined },
    on: (type: string, fn: (ev: unknown) => void) => {
      const set = inbound.get(type) ?? new Set<(ev: unknown) => void>();
      set.add(fn);
      inbound.set(type, set);
      return () => set.delete(fn);
    },
    presenceUpdate: () => undefined,
    restreamStart: () => undefined,
    restreamStop: () => undefined,
    deliver: (type: string, payload: Record<string, unknown>) => {
      for (const fn of [...(inbound.get(type) ?? [])]) {
        fn({ type, roomId: ROOM_ID, seq: 1, ts: 0, payload });
      }
    },
  } as unknown as TestConnection;
}

/** Drain microtasks (the credential settle rides one). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/* ── media-element stubs ─────────────────────────────────────────────────── */

/** Whether an UNMUTED play() is permitted — the autoplay policy, in one flag. */
let allowUnmutedPlay = true;
const playCalls: Array<{ muted: boolean }> = [];

function stubMediaElements(): void {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value(this: HTMLMediaElement): Promise<void> {
      playCalls.push({ muted: this.muted });
      return allowUnmutedPlay || this.muted
        ? Promise.resolve()
        : Promise.reject(new DOMException('play() failed', 'NotAllowedError'));
    },
  });
}

let host: HTMLDivElement;
let root: Root;
const openConns: RoomConnection[] = [];

const shareVideo = (): HTMLVideoElement | null =>
  host.querySelector<HTMLVideoElement>('video[aria-label="Shared screen"]');

const shareTracks = (): MediaStreamTrack[] => {
  const el = shareVideo();
  const stream = (el as unknown as { srcObject?: FakeMediaStream } | null)?.srcObject;
  return stream === undefined || stream === null ? [] : stream.getTracks();
};

const buttonLabelled = (label: string): HTMLButtonElement | null =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) ?? null;

/** Mount the viewer surface for a share the HOST is running. */
const mountViewer = async (): Promise<TestConnection> => {
  const connection = fakeConnection({
    [HOST]: presenceEntry(HOST, 'watching', { sharing: true }),
  });
  openConns.push(connection);
  roomStub.connection = connection;
  roomStub.room = room();
  roomStub.member = member();
  await act(async () => {
    root.render(<ScreenShareStage restream={liveRestream(HOST)} />);
    await settle();
  });
  return connection;
};

const emit = async (...tracks: MediaStreamTrack[]): Promise<void> => {
  await act(async () => {
    for (const t of tracks) FakePc.instances[0]?.emitTrack(t);
    await settle();
  });
};

/** One role announcement, as the hub relays it from the sharing host. */
const announce = (conn: TestConnection, role: string, streamId: string): void => {
  conn.deliver('webrtc.offer', {
    fromUserId: HOST,
    targetUserId: ME,
    connectionId: `mesh:${ROOM_ID}:role:${role}:${streamId}`,
    sdp: '',
  });
};

describe('share audio reaches a viewer, in or out of the call', () => {
  beforeEach(() => {
    FakePc.reset();
    playCalls.length = 0;
    allowUnmutedPlay = true;
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    (globalThis as { MediaStream?: unknown }).MediaStream = FakeMediaStream;
    stubMediaElements();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    for (const conn of openConns.splice(0)) closeCallMesh(conn);
    resetShareHost();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    delete (globalThis as { MediaStream?: unknown }).MediaStream;
  });

  it('plays the share audio for a viewer who never joined the call', async () => {
    await mountViewer();
    const video = track('share-v', 'video');
    const audio = track('share-a', 'audio');

    await emit(video, audio);

    // The sink is the share element itself: one element, one copy of the
    // sound, no dependence on having pressed Join.
    expect(shareTracks()).toContain(audio);
    expect(shareTracks()).toContain(video);
    expect(playCalls.length).toBeGreaterThan(0);
  });

  it('drops a track the mesh has withdrawn instead of rendering a dead one', async () => {
    await mountViewer();
    const first = new FakeTrack('share-v1', 'video');
    await emit(first as unknown as MediaStreamTrack);
    expect(shareTracks()).toHaveLength(1);

    // The mesh forgets a remote track when it ends (call-mesh retainRemote).
    await act(async () => {
      first.emit('ended');
      await settle();
    });

    expect(shareTracks()).toHaveLength(0);
    expect(host.textContent).toContain('Connecting to the host’s screen');
  });

  it('renders the newest video of a renegotiated share, not the stale first one', async () => {
    await mountViewer();
    const first = track('share-v1', 'video');
    const second = track('share-v2', 'video');

    await emit(first, second);

    expect(shareTracks()).toEqual([second]);
  });

  it('offers a tap to enable sound when autoplay refuses the share', async () => {
    allowUnmutedPlay = false;
    await mountViewer();

    await emit(track('share-v', 'video'), track('share-a', 'audio'));

    // Muted playback is always allowed, so the picture runs and the sound is
    // one tap away — never silence with nothing to click.
    expect(shareVideo()?.muted).toBe(true);
    const button = buttonLabelled(SHARE_SOUND_BLOCKED_LABEL);
    expect(button).not.toBeNull();

    allowUnmutedPlay = true; // a click IS the gesture the policy wanted
    await act(async () => {
      button?.click();
      await settle();
    });

    expect(shareVideo()?.muted).toBe(false);
    expect(buttonLabelled(SHARE_SOUND_BLOCKED_LABEL)).toBeNull();
  });

  it('renders the host’s screen, not their face, when both cross one connection', async () => {
    // The other half of the tile rule (call-surface.test.tsx): the stage takes
    // the 'share' track and refuses the 'cam', however the two are ordered —
    // one sink per track, no element rendering another element's track.
    const conn = await mountViewer();
    const screen = track('screen-1', 'video');
    const face = track('cam-1', 'video');

    await act(async () => {
      announce(conn, 'share', 'host-share');
      announce(conn, 'cam', 'host-cam');
      FakePc.instances[0]?.emitTrack(screen, [{ id: 'host-share' }]);
      // The face arrives NEWER — under newest-video-wins it takes the stage.
      FakePc.instances[0]?.emitTrack(face, [{ id: 'host-cam' }]);
      await settle();
    });

    expect(shareTracks()).toEqual([screen]);
  });
});

/* ── ducking the share's sound under speech ─────────────────────────────── */

const { DUCK_ATTACK_MS, DUCK_HOLD_MS, DUCK_RELEASE_MS, DUCK_TARGET } = await import(
  '@/lib/player/ducking'
);
const { publishSpeechActive, resetRoomAudio } = await import('@/lib/player/room-audio');

describe('the share element ducks while somebody on the call is talking', () => {
  beforeEach(() => {
    // Installed BEFORE the viewer mounts: attachContentDucking captures its
    // clock (Date.now) at attach, so a later fake would never reach it. 'Date'
    // is faked explicitly so the envelope's clock and the tick interval move
    // together under advanceTimersByTime — the deterministic drive.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    FakePc.reset();
    playCalls.length = 0;
    allowUnmutedPlay = true;
    resetRoomAudio();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    (globalThis as { MediaStream?: unknown }).MediaStream = FakeMediaStream;
    stubMediaElements();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    for (const conn of openConns.splice(0)) closeCallMesh(conn);
    resetShareHost();
    resetRoomAudio();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    delete (globalThis as { MediaStream?: unknown }).MediaStream;
    vi.useRealTimers();
  });

  it('ducks while speech is active, releases after, and touches only the element', async () => {
    await mountViewer();
    const audio = track('share-a', 'audio');
    await emit(track('share-v', 'video'), audio);
    const el = shareVideo();
    expect(el?.volume).toBe(1);

    publishSpeechActive(true);
    vi.advanceTimersByTime(DUCK_ATTACK_MS + 60);
    expect(el?.volume).toBeCloseTo(DUCK_TARGET, 5);

    // The duck is the ELEMENT's volume and nothing else. Track enabled state
    // is sink-ownership plumbing (claimAudioSink), and `muted` is the autoplay
    // fallback's latch — a duck that wrote either would break a different
    // feature to soften this one.
    expect((audio as unknown as { enabled: boolean }).enabled).toBe(true);
    expect(el?.muted).toBe(false);

    publishSpeechActive(false);
    vi.advanceTimersByTime(DUCK_HOLD_MS + DUCK_RELEASE_MS + 100);
    expect(el?.volume).toBe(1);
  });

  it('holds the duck through the word gaps inside one sentence', async () => {
    await mountViewer();
    await emit(track('share-v', 'video'), track('share-a', 'audio'));
    const el = shareVideo();

    publishSpeechActive(true);
    vi.advanceTimersByTime(DUCK_ATTACK_MS + 60);
    expect(el?.volume).toBeCloseTo(DUCK_TARGET, 5);

    // Four detector flickers, each shorter than the hold: the level is flat.
    for (let i = 0; i < 4; i += 1) {
      publishSpeechActive(false);
      vi.advanceTimersByTime(150);
      publishSpeechActive(true);
      vi.advanceTimersByTime(150);
      expect(el?.volume).toBeCloseTo(DUCK_TARGET, 5);
    }
  });
});

/* ── the call's own sink ─────────────────────────────────────────────────── */

let session: CallSessionValue | null = null;

function Probe() {
  session = useCallSession();
  return null;
}

describe('exactly one element plays a given track', () => {
  beforeEach(() => {
    FakePc.reset();
    playCalls.length = 0;
    allowUnmutedPlay = true;
    session = null;
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    (globalThis as { MediaStream?: unknown }).MediaStream = FakeMediaStream;
    stubMediaElements();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () =>
          Promise.resolve(new FakeMediaStream([track('mic-local', 'audio')]) as unknown),
      },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    for (const conn of openConns.splice(0)) closeCallMesh(conn);
    resetShareHost();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    delete (globalThis as { MediaStream?: unknown }).MediaStream;
  });

  it('stands the call sink down for audio the share viewer is already playing', async () => {
    const connection = fakeConnection({ [HOST]: presenceEntry(HOST, 'in-call', { sharing: true }) });
    openConns.push(connection);
    roomStub.connection = connection;
    roomStub.room = room();
    roomStub.member = member();

    // The real nesting: room-shell wraps StagePane in CallSessionProvider.
    await act(async () => {
      root.render(
        <CallSessionProvider>
          <Probe />
          <ScreenShareStage restream={liveRestream(HOST)} />
        </CallSessionProvider>,
      );
      await settle();
    });
    await act(async () => {
      session?.join();
      await settle();
    });

    const audio = track('share-a', 'audio');
    await act(async () => {
      FakePc.instances[0]?.emitTrack(track('share-v', 'video'));
      FakePc.instances[0]?.emitTrack(audio);
      await settle();
    });

    // The share element owns it; the call's hidden <audio> never appears, so
    // the sound is never played twice a few milliseconds apart.
    expect(shareTracks()).toContain(audio);
    expect(host.querySelectorAll('audio')).toHaveLength(0);
  });

  it('hands the sound back to the call when the share viewer goes away', async () => {
    const connection = fakeConnection({ [HOST]: presenceEntry(HOST, 'in-call', { sharing: true }) });
    openConns.push(connection);
    roomStub.connection = connection;
    roomStub.room = room();
    roomStub.member = member();

    await act(async () => {
      root.render(
        <CallSessionProvider>
          <Probe />
          <ScreenShareStage restream={liveRestream(HOST)} />
        </CallSessionProvider>,
      );
      await settle();
    });
    await act(async () => {
      session?.join();
      await settle();
    });
    await act(async () => {
      FakePc.instances[0]?.emitTrack(track('share-a', 'audio'));
      await settle();
    });
    expect(host.querySelectorAll('audio')).toHaveLength(0);

    // The share ends: the stage stops rendering the viewer, and the claim it
    // held has to go with it or the room goes quiet for good.
    await act(async () => {
      root.render(
        <CallSessionProvider>
          <Probe />
        </CallSessionProvider>,
      );
      await settle();
    });

    expect(host.querySelectorAll('audio')).toHaveLength(1);
  });
});

describe('the call sink says something when autoplay refuses it', () => {
  beforeEach(() => {
    FakePc.reset();
    playCalls.length = 0;
    allowUnmutedPlay = true;
    session = null;
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    (globalThis as { MediaStream?: unknown }).MediaStream = FakeMediaStream;
    stubMediaElements();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () =>
          Promise.resolve(new FakeMediaStream([track('mic-local', 'audio')]) as unknown),
      },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    for (const conn of openConns.splice(0)) closeCallMesh(conn);
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    delete (globalThis as { MediaStream?: unknown }).MediaStream;
  });

  it('surfaces a tap-to-enable-sound affordance instead of a silent call', async () => {
    allowUnmutedPlay = false;
    const connection = fakeConnection({ [HOST]: presenceEntry(HOST, 'in-call') });
    openConns.push(connection);
    roomStub.connection = connection;
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

    // A hidden <audio> whose play() was refused is a call where you hear
    // NOBODY, permanently, with nothing on screen to fix it.
    expect(buttonLabelled(CALL_SOUND_BLOCKED_LABEL)).not.toBeNull();

    allowUnmutedPlay = true;
    await act(async () => {
      buttonLabelled(CALL_SOUND_BLOCKED_LABEL)?.click();
      await settle();
    });

    expect(buttonLabelled(CALL_SOUND_BLOCKED_LABEL)).toBeNull();
  });
});
