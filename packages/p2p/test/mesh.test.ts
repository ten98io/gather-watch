import { describe, expect, it } from 'vitest';
import type { PresenceEntry, UserId } from '@gather/contracts';
import { MeshManager } from '../src/mesh';
import type { SyncBeacon } from '../src/channels';
import type { MediaStreamTrackLike } from '../src/types';
import { MockNetwork, MockPeerConnection, SignalRouter, VirtualClock, rid, uid } from './harness';

const ROOM = rid('room-mesh');

interface World {
  clock: VirtualClock;
  net: MockNetwork;
  router: SignalRouter;
  managers: Map<UserId, MeshManager>;
  errors: Array<{ user: UserId; peer: UserId; context: string }>;
}

function makeWorld(userIds: string[]): World {
  const clock = new VirtualClock();
  const net = new MockNetwork(clock);
  const router = new SignalRouter(clock, ROOM);
  const managers = new Map<UserId, MeshManager>();
  const errors: World['errors'] = [];
  for (const raw of userIds) {
    const userId = uid(raw);
    net.setNextOwner(raw);
    // setNextOwner tags pcs created during THIS manager's synchronous addPeer
    // calls; peers are added lazily in syncPeers below, so re-tag before each.
    const manager = new MeshManager({
      roomId: ROOM,
      localUserId: userId,
      rtcFactory: (config) => {
        net.setNextOwner(raw);
        return net.rtcFactory(config);
      },
      send: router.attach(userId, (ev) => {
        managers.get(userId)?.handleSignal(ev);
      }),
      now: () => clock.now(),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onError: (peer, context) => {
        errors.push({ user: userId, peer, context });
      },
    });
    managers.set(userId, manager);
  }
  return { clock, net, router, managers, errors };
}

function connectedCount(manager: MeshManager): number {
  let count = 0;
  for (const state of manager.connectionStates().values()) {
    if (state === 'connected') count += 1;
  }
  return count;
}

describe('MeshManager', () => {
  it('connects two peers despite simultaneous (glare) startup', async () => {
    const world = makeWorld(['alice', 'bob']);
    const alice = world.managers.get(uid('alice'))!;
    const bob = world.managers.get(uid('bob'))!;

    alice.syncPeers([uid('bob')]);
    bob.syncPeers([uid('alice')]);
    await world.clock.advance(300);

    expect(alice.connectionStates().get(uid('bob'))).toBe('connected');
    expect(bob.connectionStates().get(uid('alice'))).toBe('connected');
    for (const label of ['sync', 'file'] as const) {
      expect(alice.fabric.isOpen(uid('bob'), label)).toBe(true);
      expect(bob.fabric.isOpen(uid('alice'), label)).toBe(true);
    }

    // Typed traffic flows over the fabric.
    const seen: Array<{ from: UserId; beacon: SyncBeacon }> = [];
    bob.fabric.onMessage('sync', (peerId, msg) => {
      seen.push({ from: peerId, beacon: msg });
    });
    const beacon: SyncBeacon = {
      t: 'beacon',
      positionMs: 1234,
      rate: 1,
      playing: true,
      masterTs: Math.floor(world.clock.now()),
      epoch: 1,
    };
    expect(alice.fabric.send(uid('bob'), 'sync', beacon)).toBe(true);
    await world.clock.advance(20);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.from).toBe(uid('alice'));
    expect(seen[0]?.beacon).toEqual(beacon);
    expect(world.errors).toEqual([]);
  });

  it('forms n*(n-1)/2 links across a 4-peer mesh', async () => {
    const users = ['u1', 'u2', 'u3', 'u4'];
    const world = makeWorld(users);
    for (const raw of users) {
      const others = users.filter((u) => u !== raw).map((u) => uid(u));
      world.managers.get(uid(raw))!.syncPeers(others);
    }
    await world.clock.advance(500);

    let totalDirected = 0;
    for (const raw of users) {
      const manager = world.managers.get(uid(raw))!;
      expect(connectedCount(manager)).toBe(3);
      totalDirected += connectedCount(manager);
    }
    // 12 directed ends = 6 undirected pairs = n*(n-1)/2 for n=4.
    expect(totalDirected).toBe(12);
    // Each side owns one pc per remote peer: exactly 12 pcs, no leaks.
    expect(world.net.pcCount).toBe(12);
  });

  it('tears down cleanly when a peer leaves', async () => {
    const users = ['u1', 'u2', 'u3', 'u4'];
    const world = makeWorld(users);
    for (const raw of users) {
      const others = users.filter((u) => u !== raw).map((u) => uid(u));
      world.managers.get(uid(raw))!.syncPeers(others);
    }
    await world.clock.advance(500);

    world.managers.get(uid('u4'))!.close();
    const survivors = ['u1', 'u2', 'u3'];
    for (const raw of survivors) {
      const others = survivors.filter((u) => u !== raw).map((u) => uid(u));
      world.managers.get(uid(raw))!.syncPeers(others);
    }
    await world.clock.advance(100);

    for (const raw of survivors) {
      const manager = world.managers.get(uid(raw))!;
      expect(connectedCount(manager)).toBe(2);
      expect(manager.connectionStates().has(uid('u4'))).toBe(false);
      expect(manager.fabric.isOpen(uid('u4'), 'sync')).toBe(false);
    }
  });

  it('applyPresence filters out the local user and offline entries', () => {
    const world = makeWorld(['alice']);
    const alice = world.managers.get(uid('alice'))!;
    const entry = (raw: string, state: PresenceEntry['state']): PresenceEntry => ({
      userId: uid(raw),
      state,
      micOn: false,
      camOn: false,
      sharing: false,
      lastSeenTs: Math.floor(world.clock.now()),
    });
    alice.applyPresence([
      entry('alice', 'watching'),
      entry('bob', 'watching'),
      entry('carol', 'in-call'),
      entry('dave', 'offline'),
    ]);
    expect(new Set(alice.peers())).toEqual(new Set([uid('bob'), uid('carol')]));
  });

  it('publishes local tracks to remote ontrack', async () => {
    const world = makeWorld(['alice', 'bob']);
    const alice = world.managers.get(uid('alice'))!;
    const bob = world.managers.get(uid('bob'))!;
    alice.syncPeers([uid('bob')]);
    bob.syncPeers([uid('alice')]);
    await world.clock.advance(300);

    const received: Array<{ peer: UserId; trackId: string }> = [];
    bob.onRemoteTrack((peerId, track) => {
      received.push({ peer: peerId, trackId: track.id });
    });
    const mic: MediaStreamTrackLike = { id: 'mic-1', kind: 'audio', enabled: true };
    alice.setLocalTrack('mic', mic);
    await world.clock.advance(100);

    expect(received).toContainEqual({ peer: uid('alice'), trackId: 'mic-1' });
  });

  it('reacts to link failure with an ICE restart', async () => {
    const world = makeWorld(['alice', 'bob']);
    const alice = world.managers.get(uid('alice'))!;
    const bob = world.managers.get(uid('bob'))!;
    alice.syncPeers([uid('bob')]);
    bob.syncPeers([uid('alice')]);
    await world.clock.advance(300);

    // Find alice's pc (ownerTag 'alice') and force it to fail.
    const stats = await alice.pollStats();
    const stat = stats.get(uid('bob')) as { pcId: number; ownerTag: string };
    expect(stat.ownerTag).toBe('alice');
    // Reach the pc through the fabric-agnostic route: force failure via the
    // harness by re-polling the connection state map after failing.
    const before = world.router.sentEvents.length;
    // The mesh holds the pc internally; simulate the platform event by firing
    // the state change on the mock. Locate it via MockNetwork ownership.
    const pcs = findPcs(world.net, 'alice');
    expect(pcs).toHaveLength(1);
    (pcs[0] as MockPeerConnection).forceConnectionState('failed');
    await world.clock.advance(100);

    const restartSeen =
      (pcs[0] as MockPeerConnection).restartCount >= 1 ||
      world.router.sentEvents
        .slice(before)
        .some((ev) => ev.type === 'webrtc.offer' && ev.payload.sdp.includes(':restart'));
    expect(restartSeen).toBe(true);
    expect(alice.connectionStates().get(uid('bob'))).toBe('failed');
  });
});

/** All live pcs created for an owner tag (test helper). */
function findPcs(net: MockNetwork, ownerTag: string): MockPeerConnection[] {
  const out: MockPeerConnection[] = [];
  // MockNetwork keeps pcs private; walk via the factory count and stats shape
  // instead — simplest is to track through a public probe:
  const anyNet = net as unknown as { pcs: Map<number, MockPeerConnection> };
  for (const pc of anyNet.pcs.values()) {
    if (pc.ownerTag === ownerTag && pc.connectionState !== 'closed') out.push(pc);
  }
  return out;
}
