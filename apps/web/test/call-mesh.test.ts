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
  CALL_PEER_NOTE,
  CALL_SETUP_NOTE,
  CallMesh,
  CREDENTIAL_WAIT_MS,
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

interface FakeSender {
  track: unknown;
  getParameters(): { encodings: [] };
  setParameters(): Promise<void>;
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
      getParameters: () => ({ encodings: [] }),
      setParameters: () => Promise.resolve(),
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

interface FakeConnection {
  connection: RoomConnection;
  setPresence(next: Record<string, PresenceEntry>): void;
}

function fakeConnection(initial: Record<string, PresenceEntry>): FakeConnection {
  const listeners = new Set<(s: unknown, prev: unknown) => void>();
  const state = { presence: initial };
  const connection = {
    roomId: 'room_test' as RoomId,
    rawSocket: { send: () => undefined },
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
});
