/**
 * CallMesh retention/replay — the layer B1 ("you join a call and see nobody")
 * actually broke on. `pc.ontrack` fires once, whenever the peer connection
 * happens to negotiate; a pane that subscribed later used to miss it forever.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PresenceEntry, RoomId, UserId } from '@gather/contracts';
import { CallMesh, closeCallMesh, getCallMesh } from '@/lib/call-mesh';
import type { RoomConnection } from '@/lib/room-connection';

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
  readonly removedSenders: unknown[] = [];
  readonly senders: FakeSender[] = [];
  closed = false;

  constructor() {
    FakePc.instances.push(this);
  }
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
  removeTrack(sender: unknown): void {
    this.removedSenders.push(sender);
  }
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
    (globalThis as { fetch?: unknown }).fetch = () => Promise.reject(new Error('offline'));
  });

  afterEach(() => {
    for (const mesh of created.splice(0)) mesh.close();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  const startedMesh = (
    presence: Record<string, PresenceEntry> = { [PEER]: presenceEntry(PEER, 'in-call') },
  ): { mesh: CallMesh; conn: FakeConnection } => {
    const conn = fakeConnection(presence);
    const mesh = new CallMesh(conn.connection, ME);
    created.push(mesh);
    mesh.start();
    return { mesh, conn };
  };

  it('opens one peer connection per present remote user', () => {
    startedMesh();
    expect(FakePc.instances).toHaveLength(1);
    // The negotiator must be wired before any track is added, otherwise
    // publishing mid-call would never re-offer.
    expect(FakePc.instances[0]?.onnegotiationneeded).not.toBeNull();
  });

  it('replays remote tracks to a subscriber that arrives after them', () => {
    const { mesh } = startedMesh();
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

  it('delivers later tracks to existing subscribers exactly once', () => {
    const { mesh } = startedMesh();
    const seen: string[] = [];
    mesh.onRemoteTrack((_userId, t) => seen.push(t.id));
    const cam = track('cam-1', 'video');
    FakePc.instances[0]?.emitTrack(cam);
    FakePc.instances[0]?.emitTrack(cam); // duplicate delivery from the platform
    expect(seen).toEqual(['cam-1']);
  });

  it('forgets a remote track when it ends and tells subscribers', () => {
    const { mesh } = startedMesh();
    const removed: string[] = [];
    mesh.onRemoteTrackRemoved((_userId, t) => removed.push(t.id));
    const cam = new FakeTrack('cam-1', 'video');
    FakePc.instances[0]?.emitTrack(cam as unknown as MediaStreamTrack);
    expect(mesh.remoteTrackList()).toHaveLength(1);

    cam.end();
    expect(removed).toEqual(['cam-1']);
    expect(mesh.remoteTrackList()).toHaveLength(0);
  });

  it('drops a peer’s tracks when its connection closes', () => {
    const { mesh } = startedMesh();
    FakePc.instances[0]?.emitTrack(track('cam-1', 'video'));
    expect(mesh.remoteTrackList()).toHaveLength(1);
    FakePc.instances[0]?.setConnectionState('closed');
    expect(mesh.remoteTrackList()).toHaveLength(0);
  });

  it('publishes a camera turned on mid-call to peers that already exist', () => {
    const { mesh } = startedMesh();
    const pc = FakePc.instances[0];
    expect(pc?.addedTracks).toHaveLength(0);

    mesh.setLocalTrack('mic', track('mic-local', 'audio'));
    mesh.setLocalTrack('cam', track('cam-local', 'video'));

    // Both reached the ALREADY-connected peer; addTrack is what raises
    // negotiationneeded, which is how the re-offer gets sent.
    expect(pc?.addedTracks).toHaveLength(2);
    expect(mesh.localTrack('cam')?.id).toBe('cam-local');
  });

  it('replays local tracks to a subscriber that arrives after them', () => {
    const { mesh } = startedMesh();
    mesh.setLocalTrack('cam', track('cam-local', 'video'));
    const seen: Array<[string, string | null]> = [];
    mesh.onLocalTrack((role, t) => seen.push([role, t?.id ?? null]));
    expect(seen).toEqual([['cam', 'cam-local']]);
  });

  it('removes the camera sender when the camera is turned off', () => {
    const { mesh } = startedMesh();
    mesh.setLocalTrack('cam', track('cam-local', 'video'));
    mesh.setLocalTrack('cam', null);
    expect(FakePc.instances[0]?.removedSenders).toHaveLength(1);
    expect(mesh.localTrack('cam')).toBeNull();
  });

  it('connects to a peer who joins the room after the mesh started', () => {
    const { mesh, conn } = startedMesh({});
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
