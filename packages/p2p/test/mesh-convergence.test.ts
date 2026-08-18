/**
 * The two ways a first join used to end with no call at all, and only a browser
 * refresh could rescue it:
 *
 *  A. presence reaches the two clients at different times, so one side offers
 *     while the other has never heard of it and drops the offer on the floor;
 *  B. the TURN credential fetch is started but not awaited, so every peer
 *     built in that window runs with NO ice servers for its entire life.
 *
 * Both are convergence bugs: the mesh has all the information it needs and
 * still settles into a dead state. These tests pin the convergent behaviour.
 */

import { describe, expect, it } from 'vitest';
import type { TurnCredentialsResponse, UserId } from '@gather/contracts';
import { MeshManager } from '../src/mesh';
import { TurnCredentialManager } from '../src/turn';
import type { IceServerLike, InboundSignal } from '../src/types';
import { MockNetwork, MockPeerConnection, SignalRouter, VirtualClock, rid, uid } from './harness';

const ROOM = rid('room-converge');

const TURN_SERVERS: IceServerLike[] = [
  { urls: ['turn:turn.example:3478'], username: 'u', credential: 'c' },
];

interface World {
  clock: VirtualClock;
  net: MockNetwork;
  router: SignalRouter;
  managers: Map<UserId, MeshManager>;
  errors: Array<{ user: UserId; peer: UserId; context: string }>;
}

interface WorldOptions {
  /** Same seam the app uses: TurnCredentialManager.iceServers, read per peer. */
  getIceServers?: () => IceServerLike[];
  /** Model an injected primitive that cannot be reconfigured in place. */
  withoutSetConfiguration?: boolean;
}

function makeWorld(userIds: string[], opts: WorldOptions = {}): World {
  const clock = new VirtualClock();
  const net = new MockNetwork(clock);
  const router = new SignalRouter(clock, ROOM);
  const managers = new Map<UserId, MeshManager>();
  const errors: World['errors'] = [];
  for (const raw of userIds) {
    const userId = uid(raw);
    const manager = new MeshManager({
      roomId: ROOM,
      localUserId: userId,
      rtcFactory: (config) => {
        net.setNextOwner(raw);
        const pc = net.rtcFactory(config);
        if (opts.withoutSetConfiguration === true) {
          Object.defineProperty(pc, 'setConfiguration', { value: undefined, configurable: true });
        }
        return pc;
      },
      send: router.attach(userId, (ev) => {
        managers.get(userId)?.handleSignal(ev);
      }),
      now: () => clock.now(),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      ...(opts.getIceServers === undefined ? {} : { getIceServers: opts.getIceServers }),
      onError: (peer, context) => {
        errors.push({ user: userId, peer, context });
      },
    });
    managers.set(userId, manager);
  }
  return { clock, net, router, managers, errors };
}

/** All live pcs created for an owner tag (test helper). */
function livePcs(net: MockNetwork, ownerTag: string): MockPeerConnection[] {
  const anyNet = net as unknown as { pcs: Map<number, MockPeerConnection> };
  const out: MockPeerConnection[] = [];
  for (const pc of anyNet.pcs.values()) {
    if (pc.ownerTag === ownerTag && pc.connectionState !== 'closed') out.push(pc);
  }
  return out;
}

/** The connectionId both sides of a pair compute for themselves. */
function pairId(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `mesh:${ROOM}:${lo}~${hi}`;
}

describe('mesh convergence — asymmetric peer sets', () => {
  it('admits a peer whose signal arrives before presence lists it', async () => {
    const world = makeWorld(['alice', 'bob']);
    const alice = world.managers.get(uid('alice'))!;
    const bob = world.managers.get(uid('bob'))!;

    // Presence reached alice first. bob's roster is still empty, so bob never
    // calls syncPeers — exactly the window the field report lands in.
    alice.syncPeers([uid('bob')]);
    await world.clock.advance(300);

    expect(bob.peers()).toEqual([uid('alice')]);
    expect(alice.connectionStates().get(uid('bob'))).toBe('connected');
    expect(bob.connectionStates().get(uid('alice'))).toBe('connected');
    expect(alice.fabric.isOpen(uid('bob'), 'sync')).toBe(true);
    expect(world.errors).toEqual([]);
  });

  it('drops a signal that is not for this pair', () => {
    const world = makeWorld(['alice']);
    const alice = world.managers.get(uid('alice'))!;

    const foreign: InboundSignal = {
      type: 'webrtc.offer',
      roomId: ROOM,
      seq: 1,
      ts: 1,
      payload: {
        targetUserId: uid('alice'),
        connectionId: 'mesh:some-other-room:alice~mallory',
        sdp: 'offer:99:1',
        fromUserId: uid('mallory'),
      },
    };
    alice.handleSignal(foreign);

    expect(alice.peers()).toEqual([]);
    expect(world.net.pcCount).toBe(0);
  });

  it('swallows a departed peer’s trailing signals, then lets a persistent one back in', async () => {
    const world = makeWorld(['alice', 'bob']);
    const alice = world.managers.get(uid('alice'))!;
    const bob = world.managers.get(uid('bob'))!;
    alice.syncPeers([uid('bob')]);
    bob.syncPeers([uid('alice')]);
    await world.clock.advance(300);
    expect(alice.connectionStates().get(uid('bob'))).toBe('connected');

    const offerFromBob = (seq: number): InboundSignal => ({
      type: 'webrtc.offer',
      roomId: ROOM,
      seq,
      ts: Math.floor(world.clock.now()),
      payload: {
        targetUserId: uid('alice'),
        connectionId: pairId('alice', 'bob'),
        sdp: `offer:99:${seq}`,
        fromUserId: uid('bob'),
      },
    });

    // Presence drops bob; a signal of his is still in flight behind it. That
    // must not leave a phantom peer nobody can see or remove.
    alice.syncPeers([]);
    alice.handleSignal(offerFromBob(2));
    await world.clock.advance(50);
    expect(alice.peers()).toEqual([]);

    // Presence bringing bob back re-opens the door immediately.
    alice.syncPeers([uid('bob')]);
    await world.clock.advance(300);
    expect(alice.connectionStates().get(uid('bob'))).toBe('connected');

    // And if presence is the thing that is wrong — bob keeps re-offering long
    // after the departure — the suppression expires rather than locking him
    // out until presence recovers.
    alice.syncPeers([]);
    await world.clock.advance(6000);
    alice.handleSignal(offerFromBob(3));
    await world.clock.advance(50);
    expect(alice.peers()).toEqual([uid('bob')]);
  });

  it('re-sends an offer that went unanswered instead of deadlocking', async () => {
    const world = makeWorld(['alice', 'bob']);
    const alice = world.managers.get(uid('alice'))!;
    const bob = world.managers.get(uid('bob'))!;

    // The signalling hop is down while both sides open: every offer is lost.
    world.router.partition(uid('alice'), uid('bob'));
    alice.syncPeers([uid('bob')]);
    bob.syncPeers([uid('alice')]);
    await world.clock.advance(500);
    expect(alice.connectionStates().get(uid('bob'))).toBe('new');
    expect(bob.connectionStates().get(uid('alice'))).toBe('new');

    // Signalling comes back. Nothing else can restart the exchange: presence
    // has not changed and negotiationneeded already fired for both sides.
    world.router.heal(uid('alice'), uid('bob'));
    await world.clock.advance(1000);
    expect(alice.connectionStates().get(uid('bob'))).toBe('new');

    await world.clock.advance(4000);
    expect(alice.connectionStates().get(uid('bob'))).toBe('connected');
    expect(bob.connectionStates().get(uid('alice'))).toBe('connected');
    expect(world.errors).toEqual([]);
  });

  it('gives up re-offering a peer that never answers', async () => {
    const world = makeWorld(['alice', 'bob']);
    const alice = world.managers.get(uid('alice'))!;
    world.router.partition(uid('alice'), uid('bob'));
    alice.syncPeers([uid('bob')]);

    // Far past every retry: the mesh must not re-offer forever.
    await world.clock.advance(120_000);
    const offers = world.router.sentEvents.filter(
      (ev) => ev.type === 'webrtc.offer' && ev.payload.targetUserId === uid('bob'),
    );
    expect(offers).toHaveLength(5); // the original + 4 bounded re-sends
    expect(alice.connectionStates().get(uid('bob'))).toBe('new');
  });
});

describe('mesh convergence — ICE servers', () => {
  it('repairs a peer built while the credential fetch was still pending', async () => {
    let credentials: IceServerLike[] = [];
    const world = makeWorld(['alice', 'bob'], { getIceServers: () => credentials });
    const alice = world.managers.get(uid('alice'))!;
    const bob = world.managers.get(uid('bob'))!;

    // The app kicks the fetch off WITHOUT awaiting it and reconciles presence
    // immediately, so both peers are built before the credentials land.
    world.clock.setTimeoutFn(() => {
      credentials = TURN_SERVERS;
    }, 200);
    alice.syncPeers([uid('bob')]);
    bob.syncPeers([uid('alice')]);

    const pc = livePcs(world.net, 'alice')[0]!;
    expect(pc.config.iceServers).not.toEqual([]);

    await world.clock.advance(2000);

    expect(pc.config.iceServers).toEqual(TURN_SERVERS);
    expect(alice.connectionStates().get(uid('bob'))).toBe('connected');
    expect(world.errors).toEqual([]);
  });

  it('rebuilds a still-forming connection when the platform has no setConfiguration', async () => {
    let credentials: IceServerLike[] = [];
    // Browser and react-native RTCPeerConnection both have setConfiguration; an
    // injected primitive need not, and the repair still has to happen.
    const world = makeWorld(['alice'], {
      getIceServers: () => credentials,
      withoutSetConfiguration: true,
    });
    const alice = world.managers.get(uid('alice'))!;

    // bob is in presence but nothing of his ever answers — exactly the peer
    // that needs real ICE servers, and the only kind worth rebuilding for.
    alice.syncPeers([uid('bob')]);
    expect(livePcs(world.net, 'alice')[0]!.config.iceServers).not.toEqual(TURN_SERVERS);

    credentials = TURN_SERVERS;
    await world.clock.advance(1000);

    const pcs = livePcs(world.net, 'alice');
    expect(pcs).toHaveLength(1);
    expect(pcs[0]!.config.iceServers).toEqual(TURN_SERVERS);
    expect(world.net.pcCount).toBe(2); // the fallback connection was replaced
    expect(world.errors).toEqual([]);
  });

  it('never drops a working link to install credentials it does not need', async () => {
    let credentials: IceServerLike[] = [];
    const world = makeWorld(['alice', 'bob'], {
      getIceServers: () => credentials,
      withoutSetConfiguration: true,
    });
    const alice = world.managers.get(uid('alice'))!;
    const bob = world.managers.get(uid('bob'))!;

    alice.syncPeers([uid('bob')]);
    bob.syncPeers([uid('alice')]);
    await world.clock.advance(300);
    expect(alice.connectionStates().get(uid('bob'))).toBe('connected');

    // The link came up on the fallback. Credentials arriving now cannot be
    // spliced in without a new connection, and the call is worth more.
    credentials = TURN_SERVERS;
    await world.clock.advance(1000);

    expect(alice.connectionStates().get(uid('bob'))).toBe('connected');
    expect(world.net.pcCount).toBe(2); // one pc per side, nothing rebuilt
    expect(world.errors).toEqual([]);
  });

  it('a failed credential fetch still yields a usable STUN-only list', async () => {
    let iceServers: () => IceServerLike[] = () => [];
    const world = makeWorld(['alice', 'bob'], { getIceServers: () => iceServers() });
    const alice = world.managers.get(uid('alice'))!;
    const bob = world.managers.get(uid('bob'))!;

    const turnErrors: unknown[] = [];
    const turn = new TurnCredentialManager({
      getTurnCredentials: (): Promise<TurnCredentialsResponse> =>
        Promise.reject(new Error('502 from the TURN endpoint')),
      now: () => world.clock.now(),
      setTimeoutFn: world.clock.setTimeoutFn,
      clearTimeoutFn: world.clock.clearTimeoutFn,
      onError: (err) => {
        turnErrors.push(err);
      },
    });
    iceServers = () => turn.iceServers();
    void turn.start();

    alice.syncPeers([uid('bob')]);
    bob.syncPeers([uid('alice')]);
    await world.clock.advance(2000);

    expect(turnErrors.length).toBeGreaterThan(0);
    expect(turn.iceServers()).toEqual([]);

    const pc = livePcs(world.net, 'alice')[0]!;
    const urls = pc.config.iceServers.flatMap((server) => server.urls);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith('stun:'))).toBe(true);
    // A failed fetch must not stall the room: the call still forms.
    expect(alice.connectionStates().get(uid('bob'))).toBe('connected');

    turn.stop();
    alice.close();
    bob.close();
  });
});
