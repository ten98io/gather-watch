import { describe, expect, it } from 'vitest';
import { PerfectNegotiator } from '../src/negotiation';
import type { InboundSignal } from '../src/types';
import { MockNetwork, MockPeerConnection, SignalRouter, VirtualClock, rid, uid } from './harness';

const ROOM = rid('room-1');
const ALICE = uid('alice');
const BOB = uid('bob');

interface Side {
  pc: MockPeerConnection;
  negotiator: PerfectNegotiator;
  errors: Array<{ context: string; err: unknown }>;
}

function makePair(clock: VirtualClock, net: MockNetwork, router: SignalRouter): [Side, Side] {
  const sides = new Map<string, Side>();
  const build = (local: typeof ALICE, remote: typeof ALICE): Side => {
    net.setNextOwner(local);
    const pc = net.rtcFactory({ iceServers: [] }) as MockPeerConnection;
    const errors: Array<{ context: string; err: unknown }> = [];
    const send = router.attach(local, (ev: InboundSignal) => {
      const side = sides.get(local);
      if (side !== undefined) void side.negotiator.handleSignal(ev);
    });
    const negotiator = new PerfectNegotiator({
      pc,
      roomId: ROOM,
      localUserId: local,
      remoteUserId: remote,
      connectionId: 'c1',
      send,
      now: () => clock.now(),
      onError: (context, err) => {
        errors.push({ context, err });
      },
    });
    const side: Side = { pc, negotiator, errors };
    sides.set(local, side);
    return side;
  };
  return [build(ALICE, BOB), build(BOB, ALICE)];
}

describe('PerfectNegotiator', () => {
  it('assigns politeness to the lexicographically lower userId', () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock);
    const router = new SignalRouter(clock, ROOM);
    const [alice, bob] = makePair(clock, net, router);
    expect(alice.negotiator.polite).toBe(true);
    expect(bob.negotiator.polite).toBe(false);
  });

  it('resolves simultaneous glare: both offer, both settle connected', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock);
    const router = new SignalRouter(clock, ROOM);
    const [alice, bob] = makePair(clock, net, router);

    // Both sides trigger negotiationneeded in the same tick.
    alice.pc.createDataChannel('sync', { negotiated: true, id: 0 });
    bob.pc.createDataChannel('sync', { negotiated: true, id: 0 });
    await clock.advance(200);

    expect(alice.pc.signalingState).toBe('stable');
    expect(bob.pc.signalingState).toBe('stable');
    expect(alice.pc.connectionState).toBe('connected');
    expect(bob.pc.connectionState).toBe('connected');
    // The impolite side (bob) won the glare — alice answered his offer — and
    // then alice RE-OFFERED: her own offer was rolled back unapplied, so the
    // browser's negotiation-needed check comes up true again on stable (the
    // mock models this; Chrome does it for real). Bob answers that re-offer,
    // which is why HIS final remote description is an offer while hers is the
    // answer that completed the exchange. One glare answer each way, no more:
    // the re-offer must converge, not echo.
    expect(alice.pc.remoteDescription?.sdp?.startsWith('answer:')).toBe(true);
    const toBob = router.sentEvents.filter((ev) => ev.payload.targetUserId === BOB);
    const toAlice = router.sentEvents.filter((ev) => ev.payload.targetUserId === ALICE);
    expect(toBob.filter((ev) => ev.type === 'webrtc.answer')).toHaveLength(1);
    expect(toAlice.filter((ev) => ev.type === 'webrtc.answer')).toHaveLength(1);
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
  });

  it('queues ICE candidates until a remote description exists', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock);
    const router = new SignalRouter(clock, ROOM);
    const [alice, bob] = makePair(clock, net, router);

    // Hand-deliver a candidate from bob before any offer arrived.
    const early: InboundSignal = {
      type: 'webrtc.ice',
      roomId: ROOM,
      seq: 1,
      ts: Math.floor(clock.now()),
      payload: {
        targetUserId: ALICE,
        fromUserId: BOB,
        connectionId: 'c1',
        candidate: { candidate: 'cand:early', sdpMid: '0', sdpMLineIndex: 0 },
      },
    };
    await alice.negotiator.handleSignal(early);
    await clock.flush();
    expect(alice.pc.addedCandidates).toEqual([]);

    // A normal exchange later flushes the queue.
    bob.pc.createDataChannel('sync', { negotiated: true, id: 0 });
    await clock.advance(200);
    expect(alice.pc.addedCandidates.some((c) => c.candidate === 'cand:early')).toBe(true);
    expect(alice.errors).toEqual([]);
  });

  it('drops stale answers without corrupting state', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock);
    const router = new SignalRouter(clock, ROOM);
    const [alice, bob] = makePair(clock, net, router);
    void bob;

    const stale: InboundSignal = {
      type: 'webrtc.answer',
      roomId: ROOM,
      seq: 1,
      ts: Math.floor(clock.now()),
      payload: { targetUserId: ALICE, fromUserId: BOB, connectionId: 'c1', sdp: 'answer:99:1' },
    };
    await alice.negotiator.handleSignal(stale);
    await clock.flush();
    expect(alice.pc.signalingState).toBe('stable');
    expect(alice.pc.remoteDescription).toBeNull();
    expect(alice.errors).toEqual([]);
  });

  it('ignores signals with a foreign connectionId or sender', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock);
    const router = new SignalRouter(clock, ROOM);
    const [alice] = makePair(clock, net, router);

    const foreign: InboundSignal = {
      type: 'webrtc.offer',
      roomId: ROOM,
      seq: 1,
      ts: Math.floor(clock.now()),
      payload: { targetUserId: ALICE, fromUserId: BOB, connectionId: 'OTHER', sdp: 'offer:99:1' },
    };
    await alice.negotiator.handleSignal(foreign);
    expect(alice.pc.signalingState).toBe('stable');

    const spoofed: InboundSignal = {
      type: 'webrtc.offer',
      roomId: ROOM,
      seq: 2,
      ts: Math.floor(clock.now()),
      payload: {
        targetUserId: ALICE,
        fromUserId: uid('mallory'),
        connectionId: 'c1',
        sdp: 'offer:99:2',
      },
    };
    await alice.negotiator.handleSignal(spoofed);
    expect(alice.pc.signalingState).toBe('stable');
  });

  it('falls back to createOffer({iceRestart:true}) when restartIce is absent', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock);
    const router = new SignalRouter(clock, ROOM);
    const [alice, bob] = makePair(clock, net, router);
    void bob;

    delete (alice.pc as { restartIce?: () => void }).restartIce;
    alice.negotiator.restartIce();
    await clock.advance(50);
    const restartOffer = router.sentEvents.find(
      (ev) => ev.type === 'webrtc.offer' && ev.payload.sdp.includes(':restart'),
    );
    expect(restartOffer).toBeDefined();
  });
});
