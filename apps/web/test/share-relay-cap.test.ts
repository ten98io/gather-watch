/**
 * Free-tier relay guard (docs/COST_MODEL.md): a Mode B share whose link falls
 * back to relay is bitrate-capped on the free plan — capped, never refused —
 * and the host is told once, in one plain sentence. Premium is never capped,
 * and an UNKNOWN plan counts as free: the cost risk is the operator's, so the
 * premium path has to be explicit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceEntry, RoomId, UserId } from '@playin/contracts';
import {
  CallMesh,
  FREE_SHARE_RELAY_KBPS,
  SHARE_RELAY_NOTE,
  seedSharePlan,
} from '@/lib/call-mesh';
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
  /** Every parameter bag handed to setParameters — the cap writes land here. */
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
      // A fresh bag with one encoding per read, like the platform: the cap
      // helper mutates it and hands it back through setParameters.
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

describe('free-tier relay cap (web share path)', () => {
  const created: CallMesh[] = [];

  beforeEach(() => {
    FakePc.reset();
    seedSharePlan(null);
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    // TURN credentials are fetched on start(); fail fast and stay offline.
    (globalThis as { fetch?: unknown }).fetch = () => Promise.reject(new Error('offline'));
  });

  afterEach(() => {
    for (const mesh of created.splice(0)) mesh.close();
    seedSharePlan(null);
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  /** A started mesh with one present peer, sharing, whose link polls `stats`. */
  const sharingMesh = (stats: unknown): { mesh: CallMesh; pc: FakePc | undefined } => {
    const mesh = new CallMesh(fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') }), ME);
    created.push(mesh);
    mesh.start();
    mesh.setLocalTrack('share', track('share-1', 'video'));
    const pc = FakePc.instances[0];
    if (pc !== undefined) pc.statsResult = stats;
    return { mesh, pc };
  };

  it('caps the share at 400 kbps when a free plan shares over a relayed link', async () => {
    seedSharePlan('free');
    const { mesh, pc } = sharingMesh(relayedStats);

    await mesh.pollLinkStats();

    expect(bitrateWrites(pc)).toEqual([FREE_SHARE_RELAY_KBPS * 1000]);
  });

  it('caps exactly the same way while the plan is still unknown — fail closed', async () => {
    const { mesh, pc } = sharingMesh(relayedStats);

    await mesh.pollLinkStats();

    expect(bitrateWrites(pc)).toEqual([FREE_SHARE_RELAY_KBPS * 1000]);
  });

  it('never caps premium, even over a relayed link', async () => {
    seedSharePlan('premium');
    const { mesh, pc } = sharingMesh(relayedStats);

    await mesh.pollLinkStats();

    expect(bitrateWrites(pc)).toEqual([]);
  });

  it('leaves a free share on a direct link untouched', async () => {
    seedSharePlan('free');
    const { mesh, pc } = sharingMesh(directStats);

    await mesh.pollLinkStats();

    expect(bitrateWrites(pc)).toEqual([]);
  });

  it('polls on its own clock once started — the cap needs no manual poll', async () => {
    vi.useFakeTimers();
    try {
      seedSharePlan('free');
      const { pc } = sharingMesh(relayedStats);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(bitrateWrites(pc)).toEqual([FREE_SHARE_RELAY_KBPS * 1000]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('the one-sentence note', () => {
    it('fires once when a free share link becomes relayed, and only once', async () => {
      seedSharePlan('free');
      const { mesh } = sharingMesh(relayedStats);
      const notes: number[] = [];
      mesh.onShareRelayed(() => notes.push(1));

      await mesh.pollLinkStats();
      await mesh.pollLinkStats();

      expect(notes).toHaveLength(1);
    });

    it('fires immediately when the link was already known relayed at share start', async () => {
      seedSharePlan('free');
      const { mesh } = sharingMesh(relayedStats);
      await mesh.pollLinkStats();

      const notes: number[] = [];
      mesh.onShareRelayed(() => notes.push(1));

      expect(notes).toHaveLength(1);
    });

    it('stays silent on a direct link', async () => {
      seedSharePlan('free');
      const { mesh } = sharingMesh(directStats);
      const notes: number[] = [];
      mesh.onShareRelayed(() => notes.push(1));

      await mesh.pollLinkStats();

      expect(notes).toHaveLength(0);
    });

    it('stays silent on premium, relayed or not', async () => {
      seedSharePlan('premium');
      const { mesh } = sharingMesh(relayedStats);
      const notes: number[] = [];
      mesh.onShareRelayed(() => notes.push(1));

      await mesh.pollLinkStats();

      expect(notes).toHaveLength(0);
    });

    it('is one plain sentence with no transport jargon', () => {
      expect(SHARE_RELAY_NOTE).toMatch(/Premium/);
      for (const banned of ['TURN', 'relay candidate', 'ICE', 'kbps', 'bitrate']) {
        expect(SHARE_RELAY_NOTE).not.toContain(banned);
      }
    });
  });
});
