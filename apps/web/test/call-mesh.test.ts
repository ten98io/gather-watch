/**
 * CallMesh retention/replay — the layer B1 ("you join a call and see nobody")
 * actually broke on. `pc.ontrack` fires once, whenever the peer connection
 * happens to negotiate; a pane that subscribed later used to miss it forever.
 *
 * And the credential gate: an RTCPeerConnection captures its ICE servers at
 * construction, so a peer built before the first TURN fetch answers is stuck
 * on host/srflx candidates for its entire life — the "join, then refresh the
 * tab and join again" bug, from the app side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceEntry, RoomId, TurnCredentialsResponse, UserId } from '@gather/contracts';
import {
  CALL_PEER_LOST_NOTE,
  CALL_PEER_NOTE,
  CALL_SETUP_NOTE,
  CallMesh,
  CREDENTIAL_WAIT_MS,
  DEFAULT_CAP_CAM_KBPS,
  PUBLISH_BRIDGE_MS,
  closeCallMesh,
  getCallMesh,
} from '@/lib/call-mesh';
import type { RoomConnection } from '@/lib/room-connection';

/* The TURN fetch, per test. Hoisted so the module mock below can reach it. */
const turnStub = vi.hoisted(() => ({
  fetch: (): Promise<TurnCredentialsResponse> => Promise.reject(new Error('offline')),
}));

vi.mock('@/lib/api', () => ({
  api: { rtc: { turnCredentials: () => turnStub.fetch() } },
}));

/** Drain the microtask queue — works under fake timers, unlike setTimeout(0). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const CREDENTIALS: TurnCredentialsResponse = {
  iceServers: [{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }],
  // 0 = no expiry-driven refresh, so no stray timer outlives the test.
  ttlSeconds: 0,
  fairUseRemainingGb: null,
};

/* ── fakes ────────────────────────────────────────────────────────────────── */

class FakeTrack {
  enabled = true;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(
    readonly id: string,
    readonly kind: 'audio' | 'video',
  ) {}
  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  stop(): void {}
  /** Simulate the platform ending the track (peer stopped publishing). */
  end(): void {
    for (const fn of [...(this.listeners.get('ended') ?? [])]) fn();
  }
}

const track = (id: string, kind: 'audio' | 'video'): MediaStreamTrack =>
  new FakeTrack(id, kind) as unknown as MediaStreamTrack;

class FakeDataChannel {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  constructor(readonly label: string) {}
  send(): void {}
  close(): void {}
}

interface SentParameters {
  encodings: Array<{ maxBitrate?: number }>;
}

interface FakeSender {
  track: unknown;
  /** Every parameter bag handed to setParameters — a cap write lands here. */
  setCalls: SentParameters[];
  getParameters(): SentParameters;
  setParameters(p: SentParameters): Promise<void>;
  replaceTrack(next: unknown): Promise<void>;
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
  readonly addedTracks: unknown[] = [];
  readonly senders: FakeSender[] = [];
  /** Every ICE list pushed onto this connection after construction. */
  readonly configured: unknown[] = [];
  /** What the next getStats() resolves to; link classification reads it. */
  statsResult: unknown = undefined;
  closed = false;

  constructor(readonly config?: { iceServers?: unknown[] }) {
    FakePc.instances.push(this);
  }
  setConfiguration(config: { iceServers?: unknown }): void {
    this.configured.push(config.iceServers);
  }
  restartIce(): void {}
  static reset(): void {
    FakePc.instances = [];
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
  addTrack(t: unknown): FakeSender {
    this.addedTracks.push(t);
    const sender: FakeSender = {
      track: t,
      setCalls: [],
      // A fresh bag with one encoding per read, like the platform.
      getParameters: () => ({ encodings: [{}] }),
      setParameters: (p: SentParameters) => {
        sender.setCalls.push(p);
        return Promise.resolve();
      },
      replaceTrack: (next: unknown) => {
        sender.track = next;
        return Promise.resolve();
      },
    };
    this.senders.push(sender);
    return sender;
  }
  // Present because RTCPeerConnection has it and MeshManager still uses it on
  // teardown and on platforms without replaceTrack — nothing here observes it.
  removeTrack(): void {}
  getSenders(): FakeSender[] {
    return this.senders;
  }
  createDataChannel(label: string): FakeDataChannel {
    return new FakeDataChannel(label);
  }
  getStats(): Promise<unknown> {
    return Promise.resolve(this.statsResult);
  }
  close(): void {
    this.closed = true;
  }
  /** Simulate the remote side publishing a track. */
  emitTrack(t: MediaStreamTrack): void {
    this.ontrack?.({ track: t, streams: [] });
  }
  /** Simulate a connection-state transition the mesh listens to. */
  setConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const presenceEntry = (userId: string, state: PresenceEntry['state']): PresenceEntry => ({
  userId: userId as UserId,
  state,
  micOn: true,
  camOn: false,
  sharing: false,
  lastSeenTs: 0,
});

/** One signalling frame the mesh handed to the room socket. */
interface SentFrame {
  type: string;
  payload: { targetUserId?: UserId; connectionId?: string };
}

interface FakeConnection {
  connection: RoomConnection;
  setPresence(next: Record<string, PresenceEntry>): void;
  /** Everything the mesh sent over the room socket, in order. */
  sent: SentFrame[];
}

function fakeConnection(initial: Record<string, PresenceEntry>): FakeConnection {
  const listeners = new Set<(s: unknown, prev: unknown) => void>();
  const state = { presence: initial };
  const sent: SentFrame[] = [];
  const connection = {
    roomId: 'room_test' as RoomId,
    rawSocket: {
      send: (type: string, payload: SentFrame['payload']) => {
        sent.push({ type, payload });
      },
    },
    useRoomState: {
      getState: () => state,
      subscribe: (fn: (s: unknown, prev: unknown) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    on: () => () => undefined,
  } as unknown as RoomConnection;
  return {
    connection,
    sent,
    setPresence(next) {
      const prev = { presence: state.presence };
      state.presence = next;
      for (const fn of [...listeners]) fn(state, prev);
    },
  };
}

/* ── suite ────────────────────────────────────────────────────────────────── */

const ME = 'user_me' as UserId;
const PEER = 'user_peer' as UserId;

describe('CallMesh', () => {
  const created: CallMesh[] = [];

  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    // TURN credentials are fetched on start(); fail fast and stay offline.
    turnStub.fetch = () => Promise.reject(new Error('offline'));
  });

  afterEach(() => {
    for (const mesh of created.splice(0)) mesh.close();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  /** Start a mesh and let the first credential attempt settle — peers are only
   *  built after it does, so every case here waits for it exactly once. */
  const startedMesh = async (
    presence: Record<string, PresenceEntry> = { [PEER]: presenceEntry(PEER, 'in-call') },
  ): Promise<{ mesh: CallMesh; conn: FakeConnection }> => {
    const conn = fakeConnection(presence);
    const mesh = new CallMesh(conn.connection, ME);
    created.push(mesh);
    mesh.start();
    await settle();
    return { mesh, conn };
  };

  it('opens one peer connection per present remote user', async () => {
    await startedMesh();
    expect(FakePc.instances).toHaveLength(1);
    // The negotiator must be wired before any track is added, otherwise
    // publishing mid-call would never re-offer.
    expect(FakePc.instances[0]?.onnegotiationneeded).not.toBeNull();
  });

  it('replays remote tracks to a subscriber that arrives after them', async () => {
    const { mesh } = await startedMesh();
    const cam = track('cam-1', 'video');
    const mic = track('mic-1', 'audio');
    FakePc.instances[0]?.emitTrack(cam);
    FakePc.instances[0]?.emitTrack(mic);

    // This is the "you join and see nobody" case: the pane subscribes late.
    const seen: Array<[UserId, string]> = [];
    mesh.onRemoteTrack((userId, t) => seen.push([userId, t.id]));

    expect(seen).toEqual([
      [PEER, 'cam-1'],
      [PEER, 'mic-1'],
    ]);
    expect(mesh.remoteTrackList()).toHaveLength(2);
  });

  it('delivers later tracks to existing subscribers exactly once', async () => {
    const { mesh } = await startedMesh();
    const seen: string[] = [];
    mesh.onRemoteTrack((_userId, t) => seen.push(t.id));
    const cam = track('cam-1', 'video');
    FakePc.instances[0]?.emitTrack(cam);
    FakePc.instances[0]?.emitTrack(cam); // duplicate delivery from the platform
    expect(seen).toEqual(['cam-1']);
  });

  it('forgets a remote track when it ends and tells subscribers', async () => {
    const { mesh } = await startedMesh();
    const removed: string[] = [];
    mesh.onRemoteTrackRemoved((_userId, t) => removed.push(t.id));
    const cam = new FakeTrack('cam-1', 'video');
    FakePc.instances[0]?.emitTrack(cam as unknown as MediaStreamTrack);
    expect(mesh.remoteTrackList()).toHaveLength(1);

    cam.end();
    expect(removed).toEqual(['cam-1']);
    expect(mesh.remoteTrackList()).toHaveLength(0);
  });

  it('drops a peer’s tracks when its connection closes', async () => {
    const { mesh } = await startedMesh();
    FakePc.instances[0]?.emitTrack(track('cam-1', 'video'));
    expect(mesh.remoteTrackList()).toHaveLength(1);
    FakePc.instances[0]?.setConnectionState('closed');
    expect(mesh.remoteTrackList()).toHaveLength(0);
  });

  it('publishes a camera turned on mid-call to peers that already exist', async () => {
    const { mesh } = await startedMesh();
    const pc = FakePc.instances[0];
    expect(pc?.addedTracks).toHaveLength(0);

    mesh.setLocalTrack('mic', track('mic-local', 'audio'));
    mesh.setLocalTrack('cam', track('cam-local', 'video'));

    // Both reached the ALREADY-connected peer; addTrack is what raises
    // negotiationneeded, which is how the re-offer gets sent.
    expect(pc?.addedTracks).toHaveLength(2);
    expect(mesh.localTrack('cam')?.id).toBe('cam-local');
  });

  it('replays local tracks to a subscriber that arrives after them', async () => {
    const { mesh } = await startedMesh();
    mesh.setLocalTrack('cam', track('cam-local', 'video'));
    const seen: Array<[string, string | null]> = [];
    mesh.onLocalTrack((role, t) => seen.push([role, t?.id ?? null]));
    expect(seen).toEqual([['cam', 'cam-local']]);
  });

  // DELETED: 'removes the camera sender when the camera is turned off'.
  // It pinned `removeTrack` on camera-off, which is the behaviour that caused
  // the reported bug — retiring the transceiver disturbed the sendrecv
  // m-line's RECEIVE direction, so turning your own camera off stopped the
  // remote one, and turning it back on queued a second renegotiation behind
  // the first so the camera needed two toggles. MeshManager now calls
  // `replaceTrack(null)` (removeTrack survives only as the fallback for
  // platforms without it). The whole test goes rather than its assertions:
  // the replacement is packages/p2p/test/camera-toggle.test.ts, which covers
  // the same MeshManager this wrapper delegates to, in four cases.

  it('connects to a peer who joins the room after the mesh started', async () => {
    const { mesh, conn } = await startedMesh({});
    expect(FakePc.instances).toHaveLength(0);
    mesh.setLocalTrack('mic', track('mic-local', 'audio'));

    conn.setPresence({ [PEER]: presenceEntry(PEER, 'in-call') });
    expect(FakePc.instances).toHaveLength(1);
    // A late peer still receives what we are already publishing.
    expect(FakePc.instances[0]?.addedTracks).toHaveLength(1);
  });

  it('hands back a fresh mesh after the room closed the old one', () => {
    const conn = fakeConnection({});
    const first = getCallMesh(conn.connection, ME);
    expect(getCallMesh(conn.connection, ME)).toBe(first);
    closeCallMesh(conn.connection);
    expect(first.closed).toBe(true);
    const second = getCallMesh(conn.connection, ME);
    created.push(second);
    expect(second).not.toBe(first);
    expect(second.closed).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   Credentials before peers
   ──────────────────────────────────────────────────────────────────────────── */

describe('CallMesh credential gate', () => {
  const created: CallMesh[] = [];

  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.reject(new Error('offline'));
  });

  afterEach(() => {
    for (const mesh of created.splice(0)) mesh.close();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  const start = (): { mesh: CallMesh; conn: FakeConnection } => {
    const conn = fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') });
    const mesh = new CallMesh(conn.connection, ME);
    created.push(mesh);
    mesh.start();
    return { mesh, conn };
  };

  it('builds no peer connection until the first credential fetch settles', async () => {
    let resolveTurn: (res: TurnCredentialsResponse) => void = () => undefined;
    turnStub.fetch = () =>
      new Promise<TurnCredentialsResponse>((resolve) => {
        resolveTurn = resolve;
      });

    start();
    await settle();

    // The peer that gets built here is the one that never connects across
    // networks: WebRTC reads iceServers ONCE, at construction.
    expect(FakePc.instances).toHaveLength(0);

    resolveTurn(CREDENTIALS);
    await settle();

    expect(FakePc.instances).toHaveLength(1);
    expect(FakePc.instances[0]?.config?.iceServers).toEqual(CREDENTIALS.iceServers);
  });

  it('connects anyway when the credential fetch fails — degraded, never stuck', async () => {
    turnStub.fetch = () => Promise.reject(new Error('offline'));

    start();
    await settle();

    // Whatever the manager yields when it has nothing (the mesh's own public
    // STUN fallback) is what the peer gets. Degraded is a call; hung is not.
    expect(FakePc.instances).toHaveLength(1);
    const urls = (FakePc.instances[0]?.config?.iceServers ?? []).flatMap((s) =>
      Array.isArray((s as { urls?: unknown }).urls) ? ((s as { urls: string[] }).urls) : [],
    );
    expect(urls.some((u) => u.startsWith('turn:'))).toBe(false);
    expect(urls.length).toBeGreaterThan(0);
  });

  it('stops waiting for a credential fetch that never answers', async () => {
    vi.useFakeTimers();
    try {
      turnStub.fetch = () => new Promise<TurnCredentialsResponse>(() => undefined);

      start();
      await settle();
      expect(FakePc.instances).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(CREDENTIAL_WAIT_MS);

      expect(FakePc.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands late credentials to the peers that were built without them', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      turnStub.fetch = () => {
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(CREDENTIALS);
      };

      start();
      await settle();
      // Built on the fallback list, because waiting longer helps nobody.
      expect(FakePc.instances).toHaveLength(1);
      expect(FakePc.instances[0]?.configured).toEqual([]);

      // The manager's own retry lands; the call repairs without a rejoin —
      // on the credential tick (CallMesh's onUpdate) or on MeshManager's own
      // repair poll, whichever gets there first. Both layers are wired here
      // deliberately: this asserts the guarantee, not one implementation.
      await vi.advanceTimersByTimeAsync(6_000);

      expect(FakePc.instances[0]?.configured).toEqual([CREDENTIALS.iceServers]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles presence that changed while the credentials were in flight', async () => {
    let resolveTurn: (res: TurnCredentialsResponse) => void = () => undefined;
    turnStub.fetch = () =>
      new Promise<TurnCredentialsResponse>((resolve) => {
        resolveTurn = resolve;
      });

    const { conn } = start();
    await settle();
    conn.setPresence({}); // everyone left while we waited
    resolveTurn(CREDENTIALS);
    await settle();

    expect(FakePc.instances).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   Failures the owner can read
   ──────────────────────────────────────────────────────────────────────────── */

describe('CallMesh failure reporting', () => {
  const created: CallMesh[] = [];

  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.resolve(CREDENTIALS);
  });

  afterEach(() => {
    for (const mesh of created.splice(0)) mesh.close();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  const startedMesh = async (): Promise<{ mesh: CallMesh; notes: string[] }> => {
    const conn = fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') });
    const mesh = new CallMesh(conn.connection, ME);
    created.push(mesh);
    const notes: string[] = [];
    mesh.onError((note) => notes.push(note));
    mesh.start();
    await settle();
    return { mesh, notes };
  };

  it('says one plain sentence, once, when a peer link fails under live media', async () => {
    const { mesh, notes } = await startedMesh();
    mesh.setLocalTrack('mic', track('mic-local', 'audio'));

    FakePc.instances[0]?.setConnectionState('failed');
    expect(notes).toEqual([CALL_PEER_NOTE]);

    // Retries and flaps must not turn one broken link into a toast storm.
    FakePc.instances[0]?.setConnectionState('failed');
    expect(notes).toEqual([CALL_PEER_NOTE]);
  });

  it('stays quiet about a link nobody is using for media', async () => {
    const { notes } = await startedMesh();
    FakePc.instances[0]?.setConnectionState('failed');
    expect(notes).toEqual([]);
  });

  it('reports a failed credential fetch when media is actually at stake', async () => {
    turnStub.fetch = () => Promise.reject(new Error('offline'));
    const { mesh, notes } = await startedMesh();

    // Nothing to say yet: the room opened, nobody is calling.
    expect(notes).toEqual([]);

    mesh.setLocalTrack('mic', track('mic-local', 'audio'));

    expect(notes).toEqual([CALL_SETUP_NOTE]);
  });

  it('exposes per-peer connection state to the UI as it changes', async () => {
    const { mesh } = await startedMesh();
    const seen: Array<[UserId, string]> = [];
    const off = mesh.onConnectionState((peerId, state) => seen.push([peerId, state]));

    FakePc.instances[0]?.setConnectionState('connected');
    FakePc.instances[0]?.setConnectionState('disconnected');
    off();
    FakePc.instances[0]?.setConnectionState('connected');

    expect(seen).toEqual([
      // Replayed on subscribe, like tracks: a pane that mounts late still
      // knows where every link stands.
      [PEER, 'new'],
      [PEER, 'connected'],
      [PEER, 'disconnected'],
    ]);
    expect(mesh.connectionStates().get(PEER)).toBe('connected');
  });

  it('stops promising a recovery once it has given up on one', async () => {
    vi.useFakeTimers();
    try {
      const { mesh, notes } = await startedMesh();
      mesh.setLocalTrack('mic', track('mic-local', 'audio'));

      FakePc.instances[0]?.setConnectionState('failed');
      expect(notes).toEqual([CALL_PEER_NOTE]);

      // The mesh restarts ICE a bounded number of times, with backoff. FakePc
      // never comes back, so the budget runs out.
      await vi.advanceTimersByTimeAsync(120_000);

      // "Trying to get it back" stops being true the moment it stops trying,
      // and a spinner that never resolves is how nobody learns to reload.
      expect(notes).toEqual([CALL_PEER_NOTE, CALL_PEER_LOST_NOTE]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   Who our media actually goes to
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The mesh connects the ROOM — it carries the DataChannel fabric, and a
 * lurker's connection is as real as a caller's. The camera belongs to the CALL,
 * and it used to ride the connection: in a room of twelve where four were
 * calling, each of those four encoded and uploaded eleven copies of their
 * camera, eight of them to people who never pressed Join. Presence is what says
 * who is in the call; this is where that answer is turned into who receives a
 * track.
 */
describe('CallMesh publish audience', () => {
  const created: CallMesh[] = [];

  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.resolve(CREDENTIALS);
  });

  afterEach(() => {
    for (const mesh of created.splice(0)) mesh.close();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  const LURKER = 'user_lurker' as UserId;

  /** Track ids ARMED on a pc. A muted sender survives but publishes nothing. */
  const armedOn = (pc: FakePc | undefined): string[] =>
    (pc?.senders ?? []).flatMap((s) =>
      s.track === null ? [] : [(s.track as MediaStreamTrack).id],
    );

  /** A caller and a lurker, in that order — so instances[0] is the caller. */
  const roomWithLurker = async (): Promise<{ mesh: CallMesh; conn: FakeConnection }> => {
    const conn = fakeConnection({
      [PEER]: presenceEntry(PEER, 'in-call'),
      [LURKER]: presenceEntry(LURKER, 'watching'),
    });
    const mesh = new CallMesh(conn.connection, ME);
    created.push(mesh);
    mesh.start();
    await settle();
    return { mesh, conn };
  };

  it('sends the camera and microphone only to the people on the call', async () => {
    const { mesh } = await roomWithLurker();
    mesh.setLocalTrack('mic', track('mic-local', 'audio'));
    mesh.setLocalTrack('cam', track('cam-local', 'video'));

    expect(armedOn(FakePc.instances[0])).toEqual(['mic-local', 'cam-local']);
    // The defect: the person who never pressed Join used to get both of these.
    expect(armedOn(FakePc.instances[1])).toEqual([]);
  });

  it('still holds the lurker’s connection — the fabric is the room’s', async () => {
    const { mesh } = await roomWithLurker();
    mesh.setLocalTrack('cam', track('cam-local', 'video'));

    // Gating the TRACK and never the connection: sync, file transfer and
    // emotes all ride the lurker's link.
    expect(FakePc.instances).toHaveLength(2);
    expect(FakePc.instances[1]?.closed).toBe(false);
  });

  it('leaves the screen share room-wide', async () => {
    const { mesh } = await roomWithLurker();
    mesh.setLocalTrack('share', track('screen-local', 'video'));
    mesh.setLocalTrack('share-audio', track('tab-audio-local', 'audio'));

    // Watching a share is not joining a call — Mode B viewers who never
    // pressed Join are most of its audience.
    expect(armedOn(FakePc.instances[1])).toEqual(['screen-local', 'tab-audio-local']);
  });

  it('publishes to someone the moment presence says they joined the call', async () => {
    const { mesh, conn } = await roomWithLurker();
    mesh.setLocalTrack('cam', track('cam-local', 'video'));
    expect(armedOn(FakePc.instances[1])).toEqual([]);

    conn.setPresence({
      [PEER]: presenceEntry(PEER, 'in-call'),
      [LURKER]: presenceEntry(LURKER, 'in-call'),
    });

    expect(armedOn(FakePc.instances[1])).toEqual(['cam-local']);
  });

  it('rides out a presence blip, and stops when it turns out not to be one', async () => {
    vi.useFakeTimers();
    try {
      const conn = fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') });
      const mesh = new CallMesh(conn.connection, ME);
      created.push(mesh);
      mesh.start();
      await settle();
      mesh.setLocalTrack('cam', track('cam-local', 'video'));
      expect(armedOn(FakePc.instances[0])).toEqual(['cam-local']);

      // A client re-announcing 'watching' for its own reasons overwrites its
      // call state for about a round trip. Pulling the camera on that would
      // cost two renegotiations and a black tile every time a queue moved.
      conn.setPresence({ [PEER]: presenceEntry(PEER, 'watching') });
      await vi.advanceTimersByTimeAsync(PUBLISH_BRIDGE_MS - 1);
      expect(armedOn(FakePc.instances[0])).toEqual(['cam-local']);

      await vi.advanceTimersByTimeAsync(2);
      // Not a blip: they left. The bridge has to close on its own clock —
      // nothing guarantees another presence event ever arrives.
      expect(armedOn(FakePc.instances[0])).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms a peer whose presence comes back inside the bridge', async () => {
    vi.useFakeTimers();
    try {
      const conn = fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') });
      const mesh = new CallMesh(conn.connection, ME);
      created.push(mesh);
      mesh.start();
      await settle();
      mesh.setLocalTrack('cam', track('cam-local', 'video'));

      conn.setPresence({ [PEER]: presenceEntry(PEER, 'watching') });
      await vi.advanceTimersByTimeAsync(1000);
      conn.setPresence({ [PEER]: presenceEntry(PEER, 'in-call') });
      await vi.advanceTimersByTimeAsync(PUBLISH_BRIDGE_MS * 2);

      // The bridge that closed behind them must not take the camera with it.
      expect(armedOn(FakePc.instances[0])).toEqual(['cam-local']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the camera by default, and never the microphone', async () => {
    const conn = fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') });
    const mesh = getCallMesh(conn.connection, ME);
    created.push(mesh);
    mesh.start();
    await settle();

    mesh.setLocalTrack('mic', track('mic-local', 'audio'));
    mesh.setLocalTrack('cam', track('cam-local', 'video'));

    const pc = FakePc.instances[0];
    const capsOn = (trackId: string): Array<number | undefined> =>
      (pc?.senders ?? [])
        .filter((s) => (s.track as MediaStreamTrack | null)?.id === trackId)
        .flatMap((s) => s.setCalls.flatMap((p) => p.encodings.map((e) => e.maxBitrate)));

    // One receiver gets the whole budget; the mesh divides it as people join.
    expect(capsOn('cam-local')).toEqual([DEFAULT_CAP_CAM_KBPS * 1000]);
    // Audio is cheap, and it is the half people notice going missing.
    expect(capsOn('mic-local')).toEqual([]);
    closeCallMesh(conn.connection);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   Endpoint identity, and the truth about the path
   ──────────────────────────────────────────────────────────────────────────── */

describe('CallMesh endpoint identity', () => {
  const created: CallMesh[] = [];

  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.resolve(CREDENTIALS);
  });

  afterEach(() => {
    for (const mesh of created.splice(0)) mesh.close();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  it('announces a token naming this tab, so two tabs are addressable apart', async () => {
    const conn = fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') });
    const mesh = new CallMesh(conn.connection, ME);
    created.push(mesh);
    mesh.start();
    await settle();

    // Without this the same account in two tabs derives ONE connectionId, the
    // far side holds one connection for the pair, and each tab's offer resets
    // the other's ICE and DTLS — the call flips between them forever.
    const hellos = conn.sent.filter((f) => f.payload.connectionId?.includes(':hello:') === true);
    expect(hellos).toHaveLength(1);
    expect(hellos[0]?.payload.targetUserId).toBe(PEER);

    const token = hellos[0]?.payload.connectionId?.split(':hello::')[1] ?? '';
    // A token the mesh will accept, and one that names the TAB — not the
    // account, which is exactly the thing both tabs have in common.
    expect(token).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(token).not.toBe(ME);
  });
});

describe('CallMesh link path', () => {
  const created: CallMesh[] = [];

  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.resolve(CREDENTIALS);
  });

  afterEach(() => {
    for (const mesh of created.splice(0)) mesh.close();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  /** Stats where the selected pair crosses a TURN relay on the local side. */
  const relayedStats = [
    { id: 'transport_1', type: 'transport', selectedCandidatePairId: 'pair_1' },
    { id: 'pair_1', type: 'candidate-pair', localCandidateId: 'cand_l', remoteCandidateId: 'cand_r' },
    { id: 'cand_l', type: 'local-candidate', candidateType: 'relay' },
    { id: 'cand_r', type: 'remote-candidate', candidateType: 'host' },
  ];

  it('tells the app whether a peer’s media is relayed or direct', async () => {
    const conn = fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') });
    const mesh = new CallMesh(conn.connection, ME);
    created.push(mesh);
    mesh.start();
    await settle();

    // Before the first poll nothing is known — and 'unknown' has to be sayable,
    // because the alternative is a badge that guesses.
    expect(mesh.linkState(PEER)).toBe('unknown');

    const seen: Array<[UserId, string]> = [];
    mesh.onLinkState((peerId, state) => seen.push([peerId, state]));

    const pc = FakePc.instances[0];
    if (pc !== undefined) pc.statsResult = relayedStats;
    await mesh.pollLinkStats();

    // Every byte of this call is crossing a server we rent. The badge said
    // 'Private' because this answer had no way out of the p2p layer.
    expect(mesh.linkState(PEER)).toBe('relayed');
    expect(mesh.linkStates().get(PEER)).toBe('relayed');
    expect(seen).toEqual([[PEER, 'unknown'], [PEER, 'relayed']]);
  });

  it('replays the current path to a subscriber that arrives late', async () => {
    const conn = fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') });
    const mesh = new CallMesh(conn.connection, ME);
    created.push(mesh);
    mesh.start();
    await settle();
    const pc = FakePc.instances[0];
    if (pc !== undefined) pc.statsResult = relayedStats;
    await mesh.pollLinkStats();

    const seen: Array<[UserId, string]> = [];
    mesh.onLinkState((peerId, state) => seen.push([peerId, state]));

    // A badge that mounts after the poll must not read 'unknown' forever.
    expect(seen).toEqual([[PEER, 'relayed']]);
  });
});
