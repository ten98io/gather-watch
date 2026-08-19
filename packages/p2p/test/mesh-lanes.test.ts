/**
 * TWO MESHES, ONE IDENTITY.
 *
 * A person sharing from the extension is in the room twice: the web tab holds
 * the call, and the offscreen document holds the screen capture. Both sign as
 * the same user — correctly, because the server stamps `fromUserId` from the
 * authenticated socket — and the hub hands a direct signal to EVERY socket that
 * user has open in the room.
 *
 * That is fine right up until both meshes derive the SAME connectionId for a
 * given viewer, which the pair-derived id did by construction. The viewer then
 * answered whichever of the two spoke first and dropped the other answer as a
 * stale/glare loser (negotiation.ts), so roughly half the time it landed on the
 * call peer and never received the share, and the other half on the share peer
 * and never heard the sharer's voice.
 *
 * The fix is a LANE: an auxiliary mesh names itself inside the connectionId, so
 * the two ids differ and the viewer holds both connections. These tests pin the
 * behaviour that fix has to produce — and the three shapes it must not disturb:
 * one mesh per person, two web tabs of one person, and the popup guest who
 * shares with no web tab at all.
 */

import { describe, expect, it } from 'vitest';
import type { UserId } from '@gather/contracts';
import { MeshManager } from '../src/mesh';
import type { MeshLane } from '../src/mesh';
import type { MediaStreamTrackLike } from '../src/types';
import { MockNetwork, MockPeerConnection, SignalRouter, VirtualClock, rid, uid } from './harness';

const ROOM = rid('room-lanes');

const track = (id: string, kind: 'audio' | 'video'): MediaStreamTrackLike => ({
  id,
  kind,
  enabled: true,
});

/** One mesh, i.e. one of a person's sockets. */
interface Endpoint {
  /** Owner tag stamped on every pc this endpoint builds. */
  tag: string;
  userId: UserId;
  mesh: MeshManager;
  /** Every remote track this endpoint was handed. */
  received: Array<{ from: UserId; trackId: string }>;
  /** Every connection-state event this endpoint reported. */
  states: Array<{ peer: UserId; state: string }>;
}

interface World {
  clock: VirtualClock;
  net: MockNetwork;
  router: SignalRouter;
  errors: Array<{ tag: string; peer: UserId; context: string }>;
  add: (tag: string, rawUserId: string, lane?: MeshLane, endpointId?: string) => Endpoint;
}

function makeWorld(): World {
  const clock = new VirtualClock();
  const net = new MockNetwork(clock);
  const router = new SignalRouter(clock, ROOM);
  const errors: World['errors'] = [];
  return {
    clock,
    net,
    router,
    errors,
    add: (tag, rawUserId, lane, endpointId) => {
      const userId = uid(rawUserId);
      const received: Endpoint['received'] = [];
      const states: Endpoint['states'] = [];
      const mesh = new MeshManager({
        roomId: ROOM,
        localUserId: userId,
        rtcFactory: (config) => {
          net.setNextOwner(tag);
          return net.rtcFactory(config);
        },
        send: router.attach(userId, (ev) => {
          mesh.handleSignal(ev);
        }),
        now: () => clock.now(),
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        ...(lane === undefined ? {} : { lane }),
        ...(endpointId === undefined ? {} : { endpointId }),
        onError: (peer, context) => {
          errors.push({ tag, peer, context });
        },
      });
      mesh.onRemoteTrack((peerId, t) => {
        received.push({ from: peerId, trackId: t.id });
      });
      mesh.onConnectionState((peerId, state) => {
        states.push({ peer: peerId, state });
      });
      return { tag, userId, mesh, received, states };
    },
  };
}

/** Live pcs an owner tag built. */
function livePcs(net: MockNetwork, ownerTag: string): MockPeerConnection[] {
  const anyNet = net as unknown as { pcs: Map<number, MockPeerConnection> };
  const out: MockPeerConnection[] = [];
  for (const pc of anyNet.pcs.values()) {
    if (pc.ownerTag === ownerTag && pc.connectionState !== 'closed') out.push(pc);
  }
  return out;
}

describe('mesh lanes — one identity, two meshes', () => {
  it('delivers BOTH the call and the share to a viewer, not one of them at random', async () => {
    const world = makeWorld();
    const web = world.add('alice-web', 'alice');
    const share = world.add('alice-share', 'alice', 'share');
    const bob = world.add('bob', 'bob');

    // The web tab holds alice's voice; the offscreen document holds her screen.
    web.mesh.setLocalTrack('mic', track('alice-mic', 'audio'));
    share.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    share.mesh.setLocalTrack('share-audio', track('alice-tab-audio', 'audio'));

    // Presence names PEOPLE: both of alice's meshes see bob, and bob sees
    // alice exactly once. Nothing tells bob there are two of her.
    web.mesh.syncPeers([uid('bob')]);
    share.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(500);

    // Both of alice's meshes reach bob. Today one of them loses the race.
    expect(web.mesh.connectionStates().get(uid('bob'))).toBe('connected');
    expect(share.mesh.connectionStates().get(uid('bob'))).toBe('connected');

    // And bob has all three tracks, from what looks to him like one person.
    expect(bob.received.every((r) => r.from === uid('alice'))).toBe(true);
    expect([...new Set(bob.received.map((r) => r.trackId))].sort()).toEqual([
      'alice-mic',
      'alice-screen',
      'alice-tab-audio',
    ]);
    expect(world.errors).toEqual([]);
  });

  it('keeps the two meshes on connection ids that cannot collide', async () => {
    const world = makeWorld();
    const web = world.add('alice-web', 'alice');
    const share = world.add('alice-share', 'alice', 'share');
    const bob = world.add('bob', 'bob');

    share.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    web.mesh.syncPeers([uid('bob')]);
    share.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(500);

    const ids = new Set(world.router.sentEvents.map((ev) => ev.payload.connectionId));
    // The call keeps the id it always had — an older build on the other end
    // still meets it there — and the share gets one of its own.
    expect([...ids].sort()).toEqual([
      `mesh:${ROOM}:alice/share~bob`,
      `mesh:${ROOM}:alice~bob`,
    ]);
    // Bob holds two connections to one person, and reports one person.
    expect(bob.mesh.peers()).toEqual([uid('alice')]);
    expect(livePcs(world.net, 'bob')).toHaveLength(2);
  });

  it('never carries the viewer’s own media, or the fabric, onto the share link', async () => {
    const world = makeWorld();
    const web = world.add('alice-web', 'alice');
    const share = world.add('alice-share', 'alice', 'share');
    const bob = world.add('bob', 'bob');

    share.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    bob.mesh.setLocalTrack('mic', track('bob-mic', 'audio'));
    bob.mesh.setLocalTrack('cam', track('bob-cam', 'video'));
    web.mesh.syncPeers([uid('bob')]);
    share.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(500);

    // The offscreen document has no UI and no use for bob's camera; sending it
    // there would spend his uplink twice over for nothing.
    expect(share.received).toEqual([]);
    expect(livePcs(world.net, 'alice-share')[0]?.senders.map((s) => s.track?.id)).toEqual([
      'alice-screen',
    ]);
    // The DataChannel fabric is keyed by USER. Letting the share link attach
    // 'sync' under the same id would replace the call's channels with a share's.
    expect(bob.mesh.fabric.isOpen(uid('alice'), 'sync')).toBe(true);
    expect(web.mesh.fabric.isOpen(uid('bob'), 'sync')).toBe(true);
    expect(share.mesh.fabric.isOpen(uid('bob'), 'sync')).toBe(false);
  });

  it('reports one person as connected while either of their meshes is up', async () => {
    const world = makeWorld();
    const web = world.add('alice-web', 'alice');
    const share = world.add('alice-share', 'alice', 'share');
    const bob = world.add('bob', 'bob');

    share.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    web.mesh.syncPeers([uid('bob')]);
    share.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(500);
    expect(bob.mesh.connectionStates().get(uid('alice'))).toBe('connected');
    const beforeShareEnds = bob.states.length;

    // The share ends: the offscreen document closes its whole mesh. Alice is
    // still on the call, so nothing about her may read as 'closed' — the web
    // app drops a peer's retained tracks the moment it sees that.
    share.mesh.close();
    await world.clock.advance(200);
    expect(bob.mesh.connectionStates().get(uid('alice'))).toBe('connected');
    expect(bob.states.slice(beforeShareEnds).map((s) => s.state)).not.toContain('closed');

    // Presence taking alice away takes every endpoint of hers with it.
    bob.mesh.syncPeers([]);
    expect(bob.mesh.peers()).toEqual([]);
    expect(bob.states.at(-1)).toEqual({ peer: uid('alice'), state: 'closed' });
  });

  it('connects a share endpoint that met its peers before it had a track', async () => {
    const world = makeWorld();
    const web = world.add('alice-web', 'alice');
    const share = world.add('alice-share', 'alice', 'share');
    const bob = world.add('bob', 'bob');

    // Presence first, capture second. A share link carries no DataChannel
    // fabric, so unlike a call link it has NOTHING to negotiate until a track
    // shows up — and `negotiationneeded` does not fire twice for one change.
    web.mesh.syncPeers([uid('bob')]);
    share.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(300);
    expect(share.mesh.connectionStates().get(uid('bob'))).toBe('new');

    share.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    await world.clock.advance(300);

    expect(share.mesh.connectionStates().get(uid('bob'))).toBe('connected');
    expect(bob.received.map((r) => r.trackId)).toEqual(['alice-screen']);
    expect(world.errors).toEqual([]);
  });

  it('drops a share endpoint that died instead of restarting ICE at it forever', async () => {
    const world = makeWorld();
    const web = world.add('alice-web', 'alice');
    const share = world.add('alice-share', 'alice', 'share');
    const bob = world.add('bob', 'bob');

    share.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    web.mesh.syncPeers([uid('bob')]);
    share.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(500);
    expect(livePcs(world.net, 'bob')).toHaveLength(2);

    // Bob's end of the share link fails. Presence still lists alice, so no
    // reconcile will ever clean it up; the endpoint has to reap itself, and a
    // share that comes back offers again and is re-admitted.
    // Bob's share link is the one with no fabric channels on it.
    const sharePc = livePcs(world.net, 'bob').find((pc) => pc.channels.size === 0);
    expect(sharePc).toBeDefined();
    sharePc!.forceConnectionState('failed');
    await world.clock.advance(200);

    expect(sharePc!.restartCount).toBe(0);
    expect(livePcs(world.net, 'bob')).toHaveLength(1);
    expect(bob.mesh.connectionStates().get(uid('alice'))).toBe('connected');
  });
});

describe('mesh lanes — the shapes that must not change', () => {
  it('leaves one-mesh-per-person deriving exactly the id it always did', async () => {
    const world = makeWorld();
    const alice = world.add('alice', 'alice');
    const bob = world.add('bob', 'bob');

    alice.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(300);

    const ids = new Set(world.router.sentEvents.map((ev) => ev.payload.connectionId));
    expect([...ids]).toEqual([`mesh:${ROOM}:alice~bob`]);
    expect(alice.mesh.connectionStates().get(uid('bob'))).toBe('connected');
    expect(bob.mesh.connectionStates().get(uid('alice'))).toBe('connected');
    expect(world.errors).toEqual([]);
  });

  it('leaves a person who announces no endpoint on exactly the id they always had', async () => {
    const world = makeWorld();
    // Neither side carries an endpoint token: an older build, the extension,
    // anything that has not been taught to announce. The id must be the one
    // both of them have always derived, or they never meet at all.
    const tabA = world.add('alice-tab-a', 'alice');
    const bob = world.add('bob', 'bob');

    tabA.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(500);

    const ids = new Set(world.router.sentEvents.map((ev) => ev.payload.connectionId));
    expect([...ids]).toEqual([`mesh:${ROOM}:alice~bob`]);
    expect(livePcs(world.net, 'bob')).toHaveLength(1);
    expect(bob.mesh.connectionStates().get(uid('alice'))).toBe('connected');
    expect(world.errors).toEqual([]);
  });

  it('still works for the popup guest who shares with no web tab at all', async () => {
    const world = makeWorld();
    // The popup join opens ONE socket, and it is the share. There is no second
    // mesh to collide with, and there never was — this path was already right.
    const guest = world.add('guest-share', 'guest', 'share');
    const bob = world.add('bob', 'bob');

    guest.mesh.setLocalTrack('share', track('guest-screen', 'video'));
    guest.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('guest')]);
    await world.clock.advance(500);

    expect(bob.received.map((r) => r.trackId)).toEqual(['guest-screen']);
    expect(guest.mesh.connectionStates().get(uid('bob'))).toBe('connected');
    // Presence lists the guest, so bob also dials a call peer that nobody is
    // behind. It must not make the person read as unreachable.
    expect(bob.mesh.connectionStates().get(uid('guest'))).toBe('connected');
    expect(world.errors).toEqual([]);
  });

  it('refuses a signal addressed to the other mesh of the same identity', () => {
    const world = makeWorld();
    const web = world.add('alice-web', 'alice');
    const share = world.add('alice-share', 'alice', 'share');

    const offerFromBob = (connectionId: string) =>
      ({
        type: 'webrtc.offer',
        roomId: ROOM,
        seq: 1,
        ts: 1,
        payload: {
          targetUserId: uid('alice'),
          connectionId,
          sdp: 'offer:99:1',
          fromUserId: uid('bob'),
        },
      }) as const;

    // The hub delivers both of these to both of alice's sockets. Each must
    // take only its own.
    web.mesh.handleSignal(offerFromBob(`mesh:${ROOM}:alice/share~bob`));
    share.mesh.handleSignal(offerFromBob(`mesh:${ROOM}:alice~bob`));
    expect(web.mesh.peers()).toEqual([]);
    expect(share.mesh.peers()).toEqual([]);
    expect(world.net.pcCount).toBe(0);

    // And each takes its own.
    web.mesh.handleSignal(offerFromBob(`mesh:${ROOM}:alice~bob`));
    share.mesh.handleSignal(offerFromBob(`mesh:${ROOM}:alice/share~bob`));
    expect(web.mesh.peers()).toEqual([uid('bob')]);
    expect(share.mesh.peers()).toEqual([uid('bob')]);
  });

  it('refuses a lane a share mesh has no business answering', () => {
    const world = makeWorld();
    const share = world.add('alice-share', 'alice', 'share');

    // Two offscreen documents have nothing to say to each other, and an
    // auxiliary mesh only ever talks to a primary one.
    share.mesh.handleSignal({
      type: 'webrtc.offer',
      roomId: ROOM,
      seq: 1,
      ts: 1,
      payload: {
        targetUserId: uid('alice'),
        connectionId: `mesh:${ROOM}:alice/share~bob/share`,
        sdp: 'offer:99:1',
        fromUserId: uid('bob'),
      },
    });
    expect(share.mesh.peers()).toEqual([]);
    expect(world.net.pcCount).toBe(0);
  });
});

/**
 * ONE IDENTITY, TWO DEVICES.
 *
 * A lane fixes the case where one identity runs two meshes on PURPOSE. This is
 * the case where it does not mean to: the same account open on a laptop and a
 * phone, or in two tabs — which needs no "join call" at all, because the room
 * shell starts the mesh and the fabric DataChannels make it negotiate with no
 * media on it.
 *
 * Both derived the same connectionId, so the viewer held ONE peer connection
 * for the pair. Each device's offer landed on it, re-pointing its single ICE
 * agent — new ufrag/pwd, new DTLS fingerprint — at the other device, and the
 * abandoned one failed consent about 30s later and restarted ICE, which
 * re-pointed it back. The call flipped between the two for as long as both
 * stayed open.
 *
 * An endpoint token is the fix: it names the DEVICE inside the id, so the two
 * are addressable apart. It is announced over the signalling channel because
 * presence has one entry per person, not per socket.
 */
describe('mesh endpoints — one identity, two devices', () => {
  it('gives each of one person’s two tabs its own link, and neither takes the other’s', async () => {
    const world = makeWorld();
    const tabA = world.add('alice-tab-a', 'alice', undefined, 'tabA');
    const tabB = world.add('alice-tab-b', 'alice', undefined, 'tabB');
    const bob = world.add('bob', 'bob', undefined, 'bob1');

    tabA.mesh.syncPeers([uid('bob')]);
    tabB.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(500);

    expect(tabA.mesh.connectionStates().get(uid('bob'))).toBe('connected');
    expect(tabB.mesh.connectionStates().get(uid('bob'))).toBe('connected');
    expect(livePcs(world.net, 'bob')).toHaveLength(2);
    expect(livePcs(world.net, 'alice-tab-a')).toHaveLength(1);
    expect(livePcs(world.net, 'alice-tab-b')).toHaveLength(1);

    // The flip needed a consent timeout to become visible, so a settled mesh
    // has to be re-read well past one before it can be called settled.
    await world.clock.advance(90_000);
    expect(tabA.mesh.connectionStates().get(uid('bob'))).toBe('connected');
    expect(tabB.mesh.connectionStates().get(uid('bob'))).toBe('connected');
    expect(bob.mesh.connectionStates().get(uid('alice'))).toBe('connected');
    expect(world.errors).toEqual([]);
  });

  it('carries each device’s media on its own link, both under the one person', async () => {
    const world = makeWorld();
    const laptop = world.add('alice-laptop', 'alice', undefined, 'laptop');
    const phone = world.add('alice-phone', 'alice', undefined, 'phone');
    const bob = world.add('bob', 'bob', undefined, 'bob1');

    laptop.mesh.setLocalTrack('mic', track('laptop-mic', 'audio'));
    phone.mesh.setLocalTrack('cam', track('phone-cam', 'video'));
    laptop.mesh.syncPeers([uid('bob')]);
    phone.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(500);

    expect(bob.received.every((r) => r.from === uid('alice'))).toBe(true);
    expect([...new Set(bob.received.map((r) => r.trackId))].sort()).toEqual([
      'laptop-mic',
      'phone-cam',
    ]);
    expect(bob.mesh.peers()).toEqual([uid('alice')]);
    expect(world.errors).toEqual([]);
  });

  it('refuses the person-level id once it addresses that identity per endpoint', async () => {
    const world = makeWorld();
    const tabA = world.add('alice-tab-a', 'alice', undefined, 'tabA');
    const tabB = world.add('alice-tab-b', 'alice', undefined, 'tabB');
    const bob = world.add('bob', 'bob', undefined, 'bob1');

    tabA.mesh.syncPeers([uid('bob')]);
    tabB.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(500);
    // One link per tab, and the person-level link they were dialled on is gone.
    expect(livePcs(world.net, 'bob')).toHaveLength(2);

    // A third tab on the old build — or a forged frame — offering under the id
    // both devices would derive. Taking it would put alice back on one shared
    // connection, which is the whole defect.
    bob.mesh.handleSignal({
      type: 'webrtc.offer',
      roomId: ROOM,
      seq: 99,
      ts: Math.floor(world.clock.now()),
      payload: {
        targetUserId: uid('bob'),
        connectionId: `mesh:${ROOM}:alice~bob`,
        sdp: 'offer:99:1',
        fromUserId: uid('alice'),
      },
    });
    await world.clock.advance(200);

    // Nothing was built for it, and neither tab's link was disturbed.
    expect(livePcs(world.net, 'bob')).toHaveLength(2);
    expect(tabA.mesh.connectionStates().get(uid('bob'))).toBe('connected');
    expect(tabB.mesh.connectionStates().get(uid('bob'))).toBe('connected');
    expect(bob.mesh.connectionStates().get(uid('alice'))).toBe('connected');
  });

  it('still answers an auxiliary share while it addresses that identity per endpoint', async () => {
    const world = makeWorld();
    const tabA = world.add('alice-tab-a', 'alice', undefined, 'tabA');
    const tabB = world.add('alice-tab-b', 'alice', undefined, 'tabB');
    // The extension's offscreen document announces nothing — it is never
    // dialled, so its lane is how it is recognised, exactly as before.
    const share = world.add('alice-share', 'alice', 'share');
    const bob = world.add('bob', 'bob', undefined, 'bob1');

    share.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    tabA.mesh.syncPeers([uid('bob')]);
    tabB.mesh.syncPeers([uid('bob')]);
    share.mesh.syncPeers([uid('bob')]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(500);

    expect(bob.received.map((r) => r.trackId)).toEqual(['alice-screen']);
    expect(bob.mesh.connectionStates().get(uid('alice'))).toBe('connected');
    expect(world.errors).toEqual([]);
  });

  it('meets a client that announces nothing on the id that client derives', async () => {
    const world = makeWorld();
    // Mid-rollout: one side has endpoint tokens, the other does not. They still
    // have to find each other, or an update strands everyone who has not taken
    // it yet.
    const modern = world.add('alice', 'alice', undefined, 'alice1');
    const legacy = world.add('bob', 'bob');

    modern.mesh.syncPeers([uid('bob')]);
    legacy.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(500);

    const pairIds = world.router.sentEvents
      .map((ev) => ev.payload.connectionId)
      .filter((id) => !id.includes(':hello:'));
    expect([...new Set(pairIds)]).toEqual([`mesh:${ROOM}:alice~bob`]);
    expect(modern.mesh.connectionStates().get(uid('bob'))).toBe('connected');
    expect(legacy.mesh.connectionStates().get(uid('alice'))).toBe('connected');
    expect(world.errors).toEqual([]);
  });

  it('bounds how many connections one identity can make it build', async () => {
    const world = makeWorld();
    const bob = world.add('bob', 'bob', undefined, 'bob1');
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(100);

    // A peer announcing endpoint after endpoint — a bug or a flood — must not
    // cost one peer connection each.
    for (let i = 0; i < 40; i += 1) {
      bob.mesh.handleSignal({
        type: 'webrtc.offer',
        roomId: ROOM,
        seq: 100 + i,
        ts: Math.floor(world.clock.now()),
        payload: {
          targetUserId: uid('bob'),
          connectionId: `mesh:${ROOM}:hello::flood${i}`,
          sdp: '',
          fromUserId: uid('alice'),
        },
      });
    }
    await world.clock.advance(500);

    expect(livePcs(world.net, 'bob').length).toBeLessThanOrEqual(4);
  });

  it('takes a token it cannot have derived as no token at all', () => {
    const world = makeWorld();
    const bob = world.add('bob', 'bob', undefined, 'bob1');
    bob.mesh.syncPeers([uid('alice')]);

    // A token carrying the id's own separators could otherwise name a pair it
    // has no business naming.
    bob.mesh.handleSignal({
      type: 'webrtc.offer',
      roomId: ROOM,
      seq: 1,
      ts: 1,
      payload: {
        targetUserId: uid('bob'),
        connectionId: `mesh:${ROOM}:hello::carol~bob1`,
        sdp: '',
        fromUserId: uid('alice'),
      },
    });

    // Nothing was learned, so alice is still addressed as a person.
    bob.mesh.handleSignal({
      type: 'webrtc.offer',
      roomId: ROOM,
      seq: 2,
      ts: 1,
      payload: {
        targetUserId: uid('bob'),
        connectionId: `mesh:${ROOM}:alice~bob`,
        sdp: 'offer:99:1',
        fromUserId: uid('alice'),
      },
    });
    expect(bob.mesh.peers()).toEqual([uid('alice')]);
  });
});
