/**
 * WHY A CALL DID NOT CONNECT — the half of it that lives in the mesh.
 *
 * The owner's production test: two people on different networks, both joined,
 * both tiles rendered, the room said "2 IN CALL", and neither could see or hear
 * the other. The room never said why, and there was nothing in the product for
 * anybody to read. The cause was configuration — the API falls back to a single
 * STUN server with no relay when the Cloudflare TURN keys are unset — and 5–25%
 * of real network pairs cannot hole-punch, so those calls do not degrade, they
 * never connect at all.
 *
 * Everything needed to say so was already here. This file pins the two facts
 * the mesh now hands upward:
 *
 *   1. whether this deployment has a relay AT ALL, known from the first
 *      credential answer — before anybody dials;
 *   2. which links it has stopped trying to reach.
 *
 * They are separate on purpose. The verdict is deliberately NOT a timer of the
 * app's own — it is the end of MeshManager's ICE recovery budget, the only
 * deadline in the system that knows what it has already tried — and it carries
 * no cause, because a cause travelling on the event as well would give one
 * sentence two sources that can drift apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceEntry, RoomId, TurnCredentialsResponse, UserId } from '@gather/contracts';
import { CALL_NO_RELAY_NOTE, CALL_PEER_LOST_NOTE, CallMesh } from '@/lib/call-mesh';
import type { RelayAvailability } from '@/lib/call-mesh';
import type { RoomConnection } from '@/lib/room-connection';

const turnStub = vi.hoisted(() => ({
  fetch: (): Promise<TurnCredentialsResponse> => Promise.reject(new Error('offline')),
}));

vi.mock('@/lib/api', () => ({
  api: { rtc: { turnCredentials: () => turnStub.fetch() } },
}));

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const ME = 'user_me' as UserId;
const PEER = 'user_peer' as UserId;
const OTHER = 'user_other' as UserId;

/**
 * What the deployment actually serves today: one Google STUN server and no
 * relay. STUN tells a peer what its own public address is; it cannot carry a
 * packet for anyone, so a pair of networks that will not connect directly has
 * nothing left to try.
 */
const STUN_ONLY: TurnCredentialsResponse = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  ttlSeconds: 0,
  fairUseRemainingGb: null,
};

/** A configured deployment: somewhere to relay through. */
const WITH_RELAY: TurnCredentialsResponse = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['turn:relay.test:3478', 'turns:relay.test:5349'], username: 'u', credential: 'c' },
  ],
  ttlSeconds: 0,
  fairUseRemainingGb: null,
};

/* ── fakes ────────────────────────────────────────────────────────────────── */

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
  /** How many times ICE was restarted on this link — the recovery budget. */
  restarts = 0;
  constructor(readonly config?: { iceServers?: unknown[] }) {
    FakePc.instances.push(this);
  }
  static reset(): void {
    FakePc.instances = [];
  }
  setConfiguration(): void {}
  restartIce(): void {
    this.restarts += 1;
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
  createDataChannel(label: string): FakeDataChannel {
    return new FakeDataChannel(label);
  }
  close(): void {}
  setConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const presenceEntry = (userId: UserId, state: PresenceEntry['state']): PresenceEntry => ({
  userId,
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
    presenceUpdate: () => undefined,
  } as unknown as RoomConnection;
}

/* ── suite ────────────────────────────────────────────────────────────────── */

describe('what the mesh knows about a relay before anybody dials', () => {
  const created: CallMesh[] = [];

  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.resolve(STUN_ONLY);
  });

  afterEach(() => {
    for (const mesh of created.splice(0)) mesh.close();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  /** What a subscriber is told the moment it arrives — the app reads this
   *  fact by subscribing, so the tests read it the same way. */
  const relayOf = (mesh: CallMesh): RelayAvailability => {
    let seen: RelayAvailability | null = null;
    mesh.onRelayAvailability((state) => {
      seen = state;
    })();
    if (seen === null) throw new Error('onRelayAvailability replayed nothing');
    return seen;
  };

  const started = async (
    presence: Record<string, PresenceEntry> = { [PEER]: presenceEntry(PEER, 'in-call') },
  ): Promise<CallMesh> => {
    const mesh = new CallMesh(fakeConnection(presence), ME);
    created.push(mesh);
    mesh.start();
    await settle();
    return mesh;
  };

  it('reads a STUN-only answer as what it is: no relay to fall back on', async () => {
    const mesh = await started();
    expect(relayOf(mesh)).toBe('absent');
  });

  it('reads a turn: url as a relay, whatever else is in the list', async () => {
    turnStub.fetch = () => Promise.resolve(WITH_RELAY);
    const mesh = await started();
    expect(relayOf(mesh)).toBe('available');
  });

  /**
   * `relayAvailable` is optional on the wire so a client can never out-run the
   * API it talks to. A response that does not carry it has not said "no relay"
   * — it has said nothing — and the servers themselves are then the witness,
   * which is the same fact from the other end: the API derives its own flag
   * off exactly the list it issued.
   *
   * Anything that is not a boolean gets the same treatment. A proxy that
   * rewrites the field to null, or a build that stringifies it, must not be
   * read as a denial.
   */
  it('never reads an unanswered field as an answer', async () => {
    for (const flag of [undefined, null, 'false', 0]) {
      turnStub.fetch = () => Promise.resolve({ ...WITH_RELAY, relayAvailable: flag } as never);
      expect(relayOf(await started())).toBe('available');

      turnStub.fetch = () => Promise.resolve({ ...STUN_ONLY, relayAvailable: flag } as never);
      expect(relayOf(await started())).toBe('absent');
    }
  });

  it('lets the API overrule the server list, in both directions', async () => {
    turnStub.fetch = () => Promise.resolve({ ...STUN_ONLY, relayAvailable: true });
    expect(relayOf(await started())).toBe('available');

    turnStub.fetch = () => Promise.resolve({ ...WITH_RELAY, relayAvailable: false });
    expect(relayOf(await started())).toBe('absent');
  });

  /** A fetch that never answered is not evidence of anything. Blaming the
   *  deployment for a link that failed while we were still offline would be a
   *  confident wrong answer, which is worse than no answer. */
  it('stays "unknown" while nothing has answered', async () => {
    turnStub.fetch = () => Promise.reject(new Error('offline'));
    const mesh = await started();
    expect(relayOf(mesh)).toBe('unknown');
  });

  it('replays the current answer to a late subscriber', async () => {
    const mesh = await started();
    const seen: string[] = [];
    mesh.onRelayAvailability((state) => seen.push(state));
    expect(seen).toEqual(['absent']);
  });
});

describe('links the mesh has stopped trying to reach', () => {
  const created: CallMesh[] = [];

  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.resolve(STUN_ONLY);
  });

  afterEach(() => {
    for (const mesh of created.splice(0)) mesh.close();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  const started = async (
    presence: Record<string, PresenceEntry> = { [PEER]: presenceEntry(PEER, 'in-call') },
  ): Promise<{ mesh: CallMesh; notes: string[]; verdicts: Array<[UserId, boolean]> }> => {
    const mesh = new CallMesh(fakeConnection(presence), ME);
    created.push(mesh);
    const notes: string[] = [];
    const verdicts: Array<[UserId, boolean]> = [];
    mesh.onError((note) => notes.push(note));
    mesh.onUnreachablePeer((peerId, lost) => verdicts.push([peerId, lost]));
    mesh.start();
    await settle();
    return { mesh, notes, verdicts };
  };

  /** Spend the whole ICE recovery budget on every live link. */
  const exhaust = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(120_000);
  };

  it('names the connectivity case instead of retrying at nothing forever', async () => {
    vi.useFakeTimers();
    try {
      const { mesh, verdicts } = await started();
      FakePc.instances[0]?.setConnectionState('failed');
      // Still trying: the budget has not run out, so there is no verdict yet
      // and the surface is right to say "connecting".
      expect(verdicts).toEqual([]);
      expect(mesh.unreachablePeers().size).toBe(0);

      await exhaust();

      // It restarted ICE the budgeted number of times first, then stopped —
      // and stopping is the event, not a deadline anybody here invented.
      expect(verdicts).toEqual([[PEER, true]]);
      expect(mesh.unreachablePeers().has(PEER)).toBe(true);
      expect(FakePc.instances[0]?.restarts).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the sentence that matches the cause, once, when media is at stake', async () => {
    vi.useFakeTimers();
    try {
      const { mesh, notes } = await started();
      mesh.setLocalTrack('mic', { id: 'mic', kind: 'audio' } as unknown as MediaStreamTrack);
      FakePc.instances[0]?.setConnectionState('failed');
      await exhaust();

      expect(notes).toContain(CALL_NO_RELAY_NOTE);
      // "Reloading usually fixes it" is false here: a reload rebuilds exactly
      // the same impossible link.
      expect(notes).not.toContain(CALL_PEER_LOST_NOTE);
      expect(notes.filter((n) => n === CALL_NO_RELAY_NOTE)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /** With a relay configured, "this room has no relay" would be a confident
   *  wrong answer — and reloading genuinely is the remaining move. */
  it('does not blame a relay this deployment actually has', async () => {
    vi.useFakeTimers();
    try {
      turnStub.fetch = () => Promise.resolve(WITH_RELAY);
      const { mesh, notes } = await started();
      mesh.setLocalTrack('mic', { id: 'mic', kind: 'audio' } as unknown as MediaStreamTrack);
      FakePc.instances[0]?.setConnectionState('failed');
      await exhaust();

      expect(notes).toContain(CALL_PEER_LOST_NOTE);
      expect(notes).not.toContain(CALL_NO_RELAY_NOTE);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The mesh is per-link. One person on a hostile network must not make the
   * others look broken — that is the difference between "Alex can't get in"
   * and "the call is down", and the room only gets to say the second one when
   * it is true.
   */
  it('gives up on one link without giving up on the others', async () => {
    vi.useFakeTimers();
    try {
      const { mesh } = await started({
        [PEER]: presenceEntry(PEER, 'in-call'),
        [OTHER]: presenceEntry(OTHER, 'in-call'),
      });
      expect(FakePc.instances).toHaveLength(2);
      FakePc.instances[0]?.setConnectionState('connected');
      FakePc.instances[1]?.setConnectionState('failed');
      await exhaust();

      const verdicts = mesh.unreachablePeers();
      expect(verdicts.size).toBe(1);
      expect(verdicts.has(OTHER)).toBe(true);
      expect(mesh.connectionStates().get(PEER)).toBe('connected');
    } finally {
      vi.useRealTimers();
    }
  });

  /** A verdict is not a headstone. A link that comes back must take its own
   *  sentence off the screen, or the room is lying in the other direction. */
  it('takes the verdict back when the link comes back', async () => {
    vi.useFakeTimers();
    try {
      const { mesh, verdicts } = await started();
      FakePc.instances[0]?.setConnectionState('failed');
      await exhaust();
      expect(mesh.unreachablePeers().has(PEER)).toBe(true);

      FakePc.instances[0]?.setConnectionState('connected');

      expect(mesh.unreachablePeers().size).toBe(0);
      expect(verdicts).toEqual([
        [PEER, true],
        [PEER, false],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays standing verdicts to a subscriber that arrives after them', async () => {
    vi.useFakeTimers();
    try {
      const { mesh } = await started();
      FakePc.instances[0]?.setConnectionState('failed');
      await exhaust();

      const late: Array<[UserId, boolean]> = [];
      mesh.onUnreachablePeer((peerId, lost) => late.push([peerId, lost]));
      expect(late).toEqual([[PEER, true]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
