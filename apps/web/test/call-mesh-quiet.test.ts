/**
 * A SETTLED CALL GOES QUIET — through CallMesh's own reconcile loops.
 *
 * packages/p2p/test/mesh-quiet.test.ts pins the same property one layer down,
 * against MeshManager. This file exists because the field storm (an
 * offer/answer cycle every ~500ms, forever, on a healthy connection) needed
 * an app-layer DRIVER: presence rewrites hitting reconcilePeers, the audience
 * bridge opening and closing, link polls — and any of those being
 * non-idempotent turns one blink into a renegotiation and a steady blink into
 * a storm. So here TWO real CallMesh instances run against a fake hub and a
 * peer connection fake that negotiates for real (state machine, glare
 * rollback, negotiationneeded on addTrack/removeTrack and NOT on
 * replaceTrack — Chrome's rules), presence churns the whole time, and the
 * assertion is zero frames on the wire once the pair has settled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceEntry, RoomId, TurnCredentialsResponse, UserId } from '@gather/contracts';
import { CallMesh, CREDENTIAL_WAIT_MS, PUBLISH_BRIDGE_MS } from '@/lib/call-mesh';
import type { RoomConnection } from '@/lib/room-connection';

/* The TURN fetch never answers usefully: the storm has nothing to do with
   credentials, and a rejected fetch opens the peer gate immediately. */
vi.mock('@/lib/api', () => ({
  api: {
    rtc: {
      turnCredentials: (): Promise<TurnCredentialsResponse> =>
        Promise.reject(new Error('offline')),
    },
  },
}));

const ROOM = 'room_quiet' as RoomId;
const ALICE = 'user_alice' as UserId;
const BOB = 'user_bob' as UserId;

/** Drain microtasks under fake timers. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** Advance fake time in steps, settling promise chains between them. */
const advance = async (ms: number): Promise<void> => {
  const step = 50;
  for (let done = 0; done < ms; done += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - done));
    await settle();
  }
};

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

interface Description {
  type: 'offer' | 'answer' | 'rollback';
  sdp?: string;
}

class FakeSender {
  constructor(public track: unknown) {}
  getParameters(): { encodings: Array<Record<string, unknown>> } {
    return { encodings: [{}] };
  }
  setParameters(): Promise<void> {
    return Promise.resolve();
  }
  // Chrome fidelity: replaceTrack NEVER fires negotiationneeded. Every quiet
  // assertion below leans on this being true of the fake as well.
  replaceTrack(next: unknown): Promise<void> {
    this.track = next;
    return Promise.resolve();
  }
}

/**
 * A peer connection fake that actually negotiates: the signaling-state
 * machine with implicit rollback, negotiationneeded fired (coalesced) by
 * addTrack/removeTrack/createDataChannel/restartIce and re-fired when a glare
 * rollback discards a local offer — and NOT fired by replaceTrack or
 * setParameters. No ICE model: candidates are irrelevant to offer storms and
 * would only add noise to the frame log.
 */
class NegotiatingPc {
  static instances: NegotiatingPc[] = [];
  localDescription: Description | null = null;
  remoteDescription: Description | null = null;
  signalingState = 'stable';
  connectionState = 'new';
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((ev: { track: unknown; streams: unknown[] }) => void) | null = null;
  ondatachannel: unknown = null;
  readonly senders: FakeSender[] = [];
  private counter = 0;
  private armed = false;
  private pendingStable = false;
  private closed = false;

  constructor() {
    NegotiatingPc.instances.push(this);
  }
  static reset(): void {
    NegotiatingPc.instances = [];
  }

  createOffer(): Promise<Description> {
    this.counter += 1;
    return Promise.resolve({ type: 'offer', sdp: `offer:${this.counter}` });
  }
  createAnswer(): Promise<Description> {
    if (this.signalingState !== 'have-remote-offer') {
      return Promise.reject(new Error(`InvalidStateError: createAnswer in ${this.signalingState}`));
    }
    this.counter += 1;
    return Promise.resolve({ type: 'answer', sdp: `answer:${this.counter}` });
  }
  async setLocalDescription(description?: Description): Promise<void> {
    let desc = description;
    if (desc === undefined) {
      desc =
        this.signalingState === 'have-remote-offer'
          ? await this.createAnswer()
          : await this.createOffer();
    }
    if (desc.type === 'offer') {
      if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer') {
        throw new Error(`InvalidStateError: local offer in ${this.signalingState}`);
      }
      this.localDescription = desc;
      this.signalingState = 'have-local-offer';
      return;
    }
    if (this.signalingState !== 'have-remote-offer') {
      throw new Error(`InvalidStateError: local answer in ${this.signalingState}`);
    }
    this.localDescription = desc;
    this.signalingState = 'stable';
    this.onBackToStable();
  }
  setRemoteDescription(description: Description): Promise<void> {
    if (description.type === 'offer') {
      if (this.signalingState === 'have-local-offer') {
        // Implicit rollback; the discarded local offer's changes are
        // un-negotiated again, so the browser re-fires negotiationneeded on
        // the next return to stable. Chrome does; so does this fake.
        this.localDescription = null;
        this.signalingState = 'stable';
        this.pendingStable = true;
      } else if (this.signalingState !== 'stable') {
        return Promise.reject(new Error(`InvalidStateError: remote offer in ${this.signalingState}`));
      }
      this.remoteDescription = description;
      this.signalingState = 'have-remote-offer';
      return Promise.resolve();
    }
    if (this.signalingState !== 'have-local-offer') {
      return Promise.reject(new Error(`InvalidStateError: answer in ${this.signalingState}`));
    }
    this.remoteDescription = description;
    this.signalingState = 'stable';
    this.onBackToStable();
    return Promise.resolve();
  }
  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }
  addTrack(t: unknown): FakeSender {
    const sender = new FakeSender(t);
    this.senders.push(sender);
    this.fireNegotiationNeeded();
    return sender;
  }
  removeTrack(sender: FakeSender): void {
    const index = this.senders.indexOf(sender);
    if (index >= 0) this.senders.splice(index, 1);
    this.fireNegotiationNeeded();
  }
  getSenders(): FakeSender[] {
    return [...this.senders];
  }
  createDataChannel(label: string): { label: string; readyState: string; close: () => void } {
    this.fireNegotiationNeeded();
    return { label, readyState: 'connecting', close: () => undefined };
  }
  restartIce(): void {
    this.fireNegotiationNeeded();
  }
  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }
  private fireNegotiationNeeded(): void {
    if (this.armed) return;
    this.armed = true;
    setTimeout(() => {
      this.armed = false;
      if (this.closed) return;
      if (this.signalingState !== 'stable') {
        this.pendingStable = true;
        return;
      }
      this.onnegotiationneeded?.();
    }, 0);
  }
  private onBackToStable(): void {
    if (!this.pendingStable) return;
    this.pendingStable = false;
    this.fireNegotiationNeeded();
  }
}

/* ── a two-user room: fake connections cross-wired through a fake hub ────── */

const presenceEntry = (userId: UserId, state: PresenceEntry['state']): PresenceEntry => ({
  userId,
  state,
  micOn: true,
  camOn: true,
  sharing: false,
  lastSeenTs: 0,
});

interface SentFrame {
  type: string;
  payload: Record<string, unknown>;
}

interface FakeEnd {
  connection: RoomConnection;
  userId: UserId;
  sent: SentFrame[];
  setPresence(next: Record<string, PresenceEntry>): void;
  deliver(type: string, payload: Record<string, unknown>): void;
}

/** Two room connections whose webrtc frames reach each other the way the hub
 *  relays them: fromUserId stamped from the sending side, one hop of delay. */
function makeRoom(): { a: FakeEnd; b: FakeEnd } {
  const make = (userId: UserId): FakeEnd => {
    const listeners = new Set<(s: unknown, prev: unknown) => void>();
    const inbound = new Map<string, Set<(ev: unknown) => void>>();
    const state: { presence: Record<string, PresenceEntry> } = { presence: {} };
    const sent: SentFrame[] = [];
    const end: FakeEnd = {
      userId,
      sent,
      connection: {
        roomId: ROOM,
        rawSocket: {
          send: (type: string, payload: Record<string, unknown>) => {
            sent.push({ type, payload });
            route(userId, type, payload);
          },
        },
        useRoomState: {
          getState: () => state,
          subscribe: (fn: (s: unknown, prev: unknown) => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        },
        on: (type: string, fn: (ev: unknown) => void) => {
          const set = inbound.get(type) ?? new Set<(ev: unknown) => void>();
          set.add(fn);
          inbound.set(type, set);
          return () => set.delete(fn);
        },
      } as unknown as RoomConnection,
      setPresence(next) {
        const prev = { presence: state.presence };
        state.presence = next;
        for (const fn of [...listeners]) fn(state, prev);
      },
      deliver(type, payload) {
        for (const fn of [...(inbound.get(type) ?? [])]) {
          fn({ type, roomId: ROOM, seq: 1, ts: 0, payload });
        }
      },
    };
    return end;
  };
  const a = make(ALICE);
  const b = make(BOB);
  const route = (from: UserId, type: string, payload: Record<string, unknown>): void => {
    if (!type.startsWith('webrtc.')) return;
    const target = payload.targetUserId === ALICE ? a : b;
    // The hub stamps fromUserId from the authenticated socket and adds a hop.
    setTimeout(() => {
      target.deliver(type, { ...payload, fromUserId: from });
    }, 5);
  };
  return { a, b };
}

/** Frame types both ends sent after `from` — a storm fails loud with them. */
function framesSince(ends: FakeEnd[], from: number[]): string[] {
  return ends.flatMap((end, i) => end.sent.slice(from[i]).map((f) => f.type));
}

describe('CallMesh quiet after convergence', () => {
  // Mutated in place (push/splice), never reassigned.
  const meshes: CallMesh[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    NegotiatingPc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = NegotiatingPc;
    let minted = 0;
    (globalThis as { MediaStream?: unknown }).MediaStream = class {
      id = `stream-${minted++}`;
    };
  });

  afterEach(() => {
    for (const mesh of meshes.splice(0)) mesh.close();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    delete (globalThis as { MediaStream?: unknown }).MediaStream;
    vi.useRealTimers();
  });

  it('presence churn, a call and a share settle to zero frames on the wire', async () => {
    const { a, b } = makeRoom();
    const alice = new CallMesh(a.connection, ALICE);
    const bob = new CallMesh(b.connection, BOB);
    meshes.push(alice, bob);
    alice.start();
    bob.start();

    const bothInCall = (): Record<string, PresenceEntry> => ({
      [ALICE]: presenceEntry(ALICE, 'in-call'),
      [BOB]: presenceEntry(BOB, 'in-call'),
    });
    a.setPresence(bothInCall());
    b.setPresence(bothInCall());
    await advance(CREDENTIAL_WAIT_MS + 500);

    // Both on the call, alice also shares — CallSurface's and
    // ScreenShareStage's exact calls.
    alice.setLocalTrack('mic', track('a-mic', 'audio'));
    alice.setLocalTrack('cam', track('a-cam', 'video'));
    bob.setLocalTrack('mic', track('b-mic', 'audio'));
    bob.setLocalTrack('cam', track('b-cam', 'video'));
    await advance(2000);
    alice.setLocalTrack('share', track('a-share', 'video'));
    alice.setLocalTrack('share-audio', track('a-share-audio', 'audio'));
    await advance(3000);

    // Sanity: negotiation actually happened, exactly one pc per side, and it
    // was never rebuilt — the dump's storm ran on ONE stable connection.
    expect(NegotiatingPc.instances).toHaveLength(2);
    expect(a.sent.some((f) => f.type === 'webrtc.offer')).toBe(true);
    expect(b.sent.some((f) => f.type === 'webrtc.answer' || f.type === 'webrtc.offer')).toBe(true);
    for (const pc of NegotiatingPc.instances) expect(pc.signalingState).toBe('stable');

    // THE PROPERTY. A minute of the loops that never stop in production —
    // presence rewritten every second (reconcilePeers runs on every write),
    // BOB blinking out of 'in-call' and back inside the bridge window (the
    // reassert fight), link polls on their own 5s clock — and not one frame.
    const snapshot = [a.sent.length, b.sent.length];
    for (let second = 0; second < 60; second += 1) {
      const blink = second % 10 === 3;
      const next = (): Record<string, PresenceEntry> => ({
        [ALICE]: presenceEntry(ALICE, 'in-call'),
        [BOB]: presenceEntry(BOB, blink ? 'watching' : 'in-call'),
      });
      a.setPresence(next());
      b.setPresence(next());
      await advance(1000);
    }
    expect(framesSince([a, b], snapshot)).toEqual([]);
    for (const pc of NegotiatingPc.instances) expect(pc.signalingState).toBe('stable');
    expect(NegotiatingPc.instances).toHaveLength(2);
  });

  it('a real leave and rejoin move tracks by replaceTrack — still zero frames', async () => {
    const { a, b } = makeRoom();
    const alice = new CallMesh(a.connection, ALICE);
    const bob = new CallMesh(b.connection, BOB);
    meshes.push(alice, bob);
    alice.start();
    bob.start();
    const both = (bobState: PresenceEntry['state']): Record<string, PresenceEntry> => ({
      [ALICE]: presenceEntry(ALICE, 'in-call'),
      [BOB]: presenceEntry(BOB, bobState),
    });
    a.setPresence(both('in-call'));
    b.setPresence(both('in-call'));
    await advance(CREDENTIAL_WAIT_MS + 500);
    alice.setLocalTrack('mic', track('a-mic', 'audio'));
    alice.setLocalTrack('cam', track('a-cam', 'video'));
    await advance(2000);

    const alicePc = NegotiatingPc.instances.find((pc) => pc.senders.length > 0);
    expect(alicePc).toBeDefined();
    const senders = [...(alicePc?.senders ?? [])];
    const snapshot = [a.sent.length, b.sent.length];

    // Bob leaves the call for real: the bridge runs out, the audience drops
    // him, and alice's senders are MUTED, not demolished. Then he rejoins and
    // the same senders re-arm. removeTrack/addTrack here is the storm.
    a.setPresence(both('watching'));
    b.setPresence(both('watching'));
    await advance(PUBLISH_BRIDGE_MS + 1000);
    expect(alicePc?.senders.map((s) => (s.track as { id?: string } | null)?.id ?? null)).toEqual([
      null,
      null,
    ]);
    a.setPresence(both('in-call'));
    b.setPresence(both('in-call'));
    await advance(2000);

    expect(framesSince([a, b], snapshot)).toEqual([]);
    expect(alicePc?.senders).toEqual(senders);
    expect(alicePc?.senders.map((s) => (s.track as { id?: string } | null)?.id ?? null)).toEqual([
      'a-mic',
      'a-cam',
    ]);
  });
});
