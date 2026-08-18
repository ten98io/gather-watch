/**
 * Share quality (web path): a Mode B share is NEVER bitrate-capped, whatever
 * the link does. The old free-tier guard capped a relayed share at 400 kbps
 * and fell back to capping whenever the account plan was unknown — which was
 * every share, since the plan lookup is gone. Everyone shares at full quality.
 *
 * What must survive the removal: the link-stats poll. Classification (direct
 * vs relayed) only advances inside MeshManager.pollStats(), the app layer owns
 * the interval, and connection diagnostics read the result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceEntry, RoomId, UserId } from '@gather/contracts';
import { CallMesh } from '@/lib/call-mesh';
import * as callMesh from '@/lib/call-mesh';
import type { RoomConnection } from '@/lib/room-connection';

/* ── fakes (the CallMesh slice of call-mesh.test.ts, plus stats) ─────────── */

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
  /** Every parameter bag handed to setParameters — a cap write would land here. */
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
  readonly senders: FakeSender[] = [];
  /** What the next getStats() resolves to; classification reads this. */
  statsResult: unknown = undefined;
  /** How many times the link was polled — the poll loop's only visible trace. */
  statsPolls = 0;
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
  removeTrack(): void {}
  getSenders(): FakeSender[] {
    return this.senders;
  }
  getStats(): Promise<unknown> {
    this.statsPolls += 1;
    return Promise.resolve(this.statsResult);
  }
  createDataChannel(label: string): FakeDataChannel {
    return new FakeDataChannel(label);
  }
  close(): void {
    this.closed = true;
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

function fakeConnection(initial: Record<string, PresenceEntry>): RoomConnection {
  const state = { presence: initial };
  return {
    roomId: 'room_test' as RoomId,
    rawSocket: { send: () => undefined },
    useRoomState: {
      getState: () => state,
      subscribe: () => () => undefined,
    },
    on: () => () => undefined,
  } as unknown as RoomConnection;
}

/** Stats where the selected pair crosses a TURN relay on the local side. */
const relayedStats = [
  { id: 'transport_1', type: 'transport', selectedCandidatePairId: 'pair_1' },
  {
    id: 'pair_1',
    type: 'candidate-pair',
    localCandidateId: 'cand_l',
    remoteCandidateId: 'cand_r',
  },
  { id: 'cand_l', type: 'local-candidate', candidateType: 'relay' },
  { id: 'cand_r', type: 'remote-candidate', candidateType: 'host' },
];

/** Stats where both sides of the selected pair resolve without a relay. */
const directStats = [
  { id: 'transport_1', type: 'transport', selectedCandidatePairId: 'pair_1' },
  {
    id: 'pair_1',
    type: 'candidate-pair',
    localCandidateId: 'cand_l',
    remoteCandidateId: 'cand_r',
  },
  { id: 'cand_l', type: 'local-candidate', candidateType: 'srflx' },
  { id: 'cand_r', type: 'remote-candidate', candidateType: 'host' },
];

/** Every maxBitrate value that reached the share sender, in write order. */
const bitrateWrites = (pc: FakePc | undefined): number[] =>
  (pc?.senders ?? []).flatMap((s) =>
    s.setCalls.flatMap((p) => p.encodings.flatMap((e) => (e.maxBitrate === undefined ? [] : [e.maxBitrate]))),
  );

/* ── suite ───────────────────────────────────────────────────────────────── */

const ME = 'user_me' as UserId;
const PEER = 'user_peer' as UserId;

describe('share quality (web share path)', () => {
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

  /** Drain the microtask queue — works under fake timers, unlike setTimeout(0). */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  /** A started mesh with one present peer, sharing, whose link polls `stats`.
   *  Peers are built only once the first TURN credential attempt settles
   *  (lib/call-mesh.ts), so this waits for it before reading the connection. */
  const sharingMesh = async (stats: unknown): Promise<{ mesh: CallMesh; pc: FakePc | undefined }> => {
    const mesh = new CallMesh(fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') }), ME);
    created.push(mesh);
    mesh.start();
    await settle();
    mesh.setLocalTrack('share', track('share-1', 'video'));
    const pc = FakePc.instances[0];
    if (pc !== undefined) pc.statsResult = stats;
    return { mesh, pc };
  };

  it('never caps the share over a relayed link — the case that used to degrade', async () => {
    const { mesh, pc } = await sharingMesh(relayedStats);

    await mesh.pollLinkStats();

    expect(bitrateWrites(pc)).toEqual([]);
  });

  it('never caps the share over a direct link either', async () => {
    const { mesh, pc } = await sharingMesh(directStats);

    await mesh.pollLinkStats();

    expect(bitrateWrites(pc)).toEqual([]);
  });

  it('still polls link stats on its own clock — classification must keep running', async () => {
    vi.useFakeTimers();
    try {
      const { pc } = await sharingMesh(relayedStats);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(pc?.statsPolls).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pc?.statsPolls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling once the mesh is closed', async () => {
    vi.useFakeTimers();
    try {
      const { mesh, pc } = await sharingMesh(relayedStats);
      await vi.advanceTimersByTimeAsync(5_000);
      mesh.close();

      await vi.advanceTimersByTimeAsync(15_000);

      expect(pc?.statsPolls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes nothing about plans or quality limits any more', () => {
    for (const gone of [
      'FREE_SHARE_RELAY_KBPS',
      'SHARE_RELAY_NOTE',
      'seedSharePlan',
      'primeSharePlan',
      'onShareRelayed',
    ]) {
      expect(Object.keys(callMesh)).not.toContain(gone);
    }
    expect(Object.getOwnPropertyNames(CallMesh.prototype)).not.toContain('onShareRelayed');
  });
});
