/**
 * WHAT ROLE IS THIS REMOTE TRACK?
 *
 * The field report: a host pressed "Share screen" with their camera on, and on
 * every guest's stage the CAMERA appeared instead of the screen. Both tracks
 * arrive on one peer connection, both are video, and `pc.ontrack` says nothing
 * about which is which — so the share stage took whichever came last and the
 * camera won.
 *
 * The sender has always known (`setLocalTrack(role, track)`). These tests pin
 * the three properties that let the RECEIVER know too:
 *
 *   1. a role, or NULL — never a guess, the rule `classifyLinkStats` already
 *      follows for link paths;
 *   2. interop — a client that announces nothing is answered null, and the
 *      consumer keeps its old behaviour, because "no share at all" is a worse
 *      failure than the one being fixed;
 *   3. isolation — one peer's announcements cannot rename another peer's
 *      tracks.
 */

import { describe, expect, it } from 'vitest';
import type { ServerWebrtcOffer, UserId } from '@gather/contracts';
import { MeshManager } from '../src/mesh';
import type { MeshLane } from '../src/mesh';
import type { MediaStreamTrackLike, TrackRole } from '../src/types';
import { MockNetwork, SignalRouter, VirtualClock, rid, uid } from './harness';

const ROOM = rid('room-roles');

const track = (id: string, kind: 'audio' | 'video'): MediaStreamTrackLike => ({
  id,
  kind,
  enabled: true,
});

/** What a remote track was delivered as. */
interface Delivery {
  from: UserId;
  trackId: string;
  role: TrackRole | null;
}

/** One mesh — i.e. one of a person's sockets. */
interface Endpoint {
  tag: string;
  userId: UserId;
  mesh: MeshManager;
  received: Delivery[];
}

interface AddOptions {
  lane?: MeshLane;
  /** Ids the injected MediaStream factory hands out, in order. Omitted means
   *  NO factory at all: the client that predates role announcements. */
  streamIds?: string[];
}

interface World {
  clock: VirtualClock;
  net: MockNetwork;
  router: SignalRouter;
  add: (tag: string, rawUserId: string, opts?: AddOptions) => Endpoint;
}

function makeWorld(): World {
  const clock = new VirtualClock();
  const net = new MockNetwork(clock);
  const router = new SignalRouter(clock, ROOM);
  return {
    clock,
    net,
    router,
    add: (tag, rawUserId, opts) => {
      const userId = uid(rawUserId);
      const received: Delivery[] = [];
      const ids = opts?.streamIds;
      let minted = 0;
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
        ...(opts?.lane === undefined ? {} : { lane: opts.lane }),
        ...(ids === undefined
          ? {}
          : {
              mediaStreamFactory: () => {
                const id = ids[minted] ?? `${tag}-overflow-${minted}`;
                minted += 1;
                return { id };
              },
            }),
        onError: () => undefined,
      });
      mesh.onRemoteTrack((peerId, t, _streams, role) => {
        received.push({ from: peerId, trackId: t.id, role });
      });
      return { tag, userId, mesh, received };
    },
  };
}

/** The role a viewer was given for one track id, or undefined if never seen. */
function roleOf(viewer: Endpoint, trackId: string): TrackRole | null | undefined {
  return viewer.received.find((d) => d.trackId === trackId)?.role;
}

/** The stream-id→role facts a mesh currently holds, per identity. Read off the
 *  instance because the bound it is under has no public surface — the same
 *  reach-in mesh-lanes.test.ts uses for the network's pc map. */
function announcedRoles(mesh: MeshManager): Map<UserId, Map<string, TrackRole>> {
  const inner = mesh as unknown as { announcedRoles: Map<UserId, Map<string, TrackRole>> };
  return inner.announcedRoles;
}

/** A crafted inbound frame, as the hub would stamp it. */
function inbound(fromUserId: UserId, connectionId: string): ServerWebrtcOffer {
  return {
    type: 'webrtc.offer',
    roomId: ROOM,
    seq: 1,
    ts: 0,
    payload: { fromUserId, targetUserId: uid('bob'), connectionId, sdp: '' },
  };
}

describe('remote track roles', () => {
  it('names the share and the camera apart on one connection', async () => {
    const world = makeWorld();
    const alice = world.add('alice', 'alice', { streamIds: ['s-cam', 's-share'] });
    const bob = world.add('bob', 'bob', { streamIds: ['b-1'] });

    // The exact sequence from the report: camera first, then share, one peer.
    alice.mesh.setLocalTrack('cam', track('alice-cam', 'video'));
    alice.mesh.syncPeers([bob.userId]);
    bob.mesh.syncPeers([alice.userId]);
    await world.clock.advance(500);
    alice.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    await world.clock.advance(500);

    expect(roleOf(bob, 'alice-cam')).toBe('cam');
    expect(roleOf(bob, 'alice-screen')).toBe('share');
  });

  it('names every role, including the two that sound alike', async () => {
    const world = makeWorld();
    const alice = world.add('alice', 'alice', {
      streamIds: ['s-mic', 's-share-audio', 's-share'],
    });
    const bob = world.add('bob', 'bob', { streamIds: ['b-1'] });

    alice.mesh.setLocalTrack('mic', track('alice-mic', 'audio'));
    alice.mesh.setLocalTrack('share-audio', track('alice-tab-audio', 'audio'));
    alice.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    alice.mesh.syncPeers([bob.userId]);
    bob.mesh.syncPeers([alice.userId]);
    await world.clock.advance(500);

    // A viewer that cannot tell these two apart plays somebody's microphone
    // on the share stage, which is what shipped.
    expect(roleOf(bob, 'alice-mic')).toBe('mic');
    expect(roleOf(bob, 'alice-tab-audio')).toBe('share-audio');
    expect(roleOf(bob, 'alice-screen')).toBe('share');
  });

  it('answers null for a client that announces nothing, and still delivers', async () => {
    const world = makeWorld();
    // No streamIds: an older extension build, or any mesh with no factory.
    const alice = world.add('alice', 'alice');
    const bob = world.add('bob', 'bob', { streamIds: ['b-1'] });

    alice.mesh.setLocalTrack('cam', track('alice-cam', 'video'));
    alice.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    alice.mesh.syncPeers([bob.userId]);
    bob.mesh.syncPeers([alice.userId]);
    await world.clock.advance(500);

    // Both tracks arrive — a regression to "no share at all" would be worse
    // than the bug — and neither is guessed at.
    expect(bob.received.map((d) => d.trackId).sort()).toEqual(['alice-cam', 'alice-screen']);
    expect(roleOf(bob, 'alice-cam')).toBeNull();
    expect(roleOf(bob, 'alice-screen')).toBeNull();
  });

  it('keeps one identity’s announcements off another identity’s tracks', async () => {
    const world = makeWorld();
    // Both mint the SAME stream id, for different roles. Stream ids are
    // browser-assigned, so nothing stops two of them colliding.
    const alice = world.add('alice', 'alice', { streamIds: ['stream-1'] });
    const carol = world.add('carol', 'carol', { streamIds: ['stream-1'] });
    const bob = world.add('bob', 'bob', { streamIds: ['b-1'] });

    alice.mesh.setLocalTrack('cam', track('alice-cam', 'video'));
    carol.mesh.setLocalTrack('share', track('carol-screen', 'video'));
    alice.mesh.syncPeers([bob.userId]);
    carol.mesh.syncPeers([bob.userId]);
    bob.mesh.syncPeers([alice.userId, carol.userId]);
    await world.clock.advance(500);

    expect(roleOf(bob, 'alice-cam')).toBe('cam');
    expect(roleOf(bob, 'carol-screen')).toBe('share');
  });

  it('names an auxiliary share lane, which announces nothing at all', async () => {
    const world = makeWorld();
    const web = world.add('alice-web', 'alice', { streamIds: ['w-cam'] });
    const share = world.add('alice-share', 'alice', { lane: 'share' });
    const bob = world.add('bob', 'bob', { streamIds: ['b-1'] });

    // The extension's offscreen document: same identity, second mesh, no
    // factory injected — the lane is the only thing that names its tracks.
    web.mesh.setLocalTrack('cam', track('alice-cam', 'video'));
    share.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    share.mesh.setLocalTrack('share-audio', track('alice-tab-audio', 'audio'));
    web.mesh.syncPeers([bob.userId]);
    share.mesh.syncPeers([bob.userId]);
    bob.mesh.syncPeers([uid('alice')]);
    await world.clock.advance(1000);

    expect(roleOf(bob, 'alice-cam')).toBe('cam');
    expect(roleOf(bob, 'alice-screen')).toBe('share');
    expect(roleOf(bob, 'alice-tab-audio')).toBe('share-audio');
  });

  it('writes the announcement before any negotiation traffic for that track', async () => {
    const world = makeWorld();
    const alice = world.add('alice', 'alice', { streamIds: ['s-share'] });
    const bob = world.add('bob', 'bob', { streamIds: ['b-1'] });

    alice.mesh.syncPeers([bob.userId]);
    bob.mesh.syncPeers([alice.userId]);
    await world.clock.advance(500);

    // The ordering IS the guarantee: an offer that reached bob first would
    // fire his ontrack before he held the mapping.
    const before = world.router.sentEvents.length;
    alice.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    const first = world.router.sentEvents[before];
    expect(first?.payload.connectionId).toBe(`mesh:${ROOM}:role:share:s-share`);
    await world.clock.advance(500);
    expect(roleOf(bob, 'alice-screen')).toBe('share');
  });

  it('refuses a forged role name and an oversized stream id', async () => {
    const world = makeWorld();
    const bob = world.add('bob', 'bob', { streamIds: ['b-1'] });
    const mallory = uid('mallory');

    bob.mesh.handleSignal(inbound(mallory, `mesh:${ROOM}:role:screen:s-1`));
    bob.mesh.handleSignal(inbound(mallory, `mesh:${ROOM}:role:share:${'x'.repeat(65)}`));
    bob.mesh.handleSignal(inbound(mallory, `mesh:${ROOM}:role:share`));

    // Nothing was recorded, so nothing can be answered from it.
    expect(announcedRoles(bob.mesh).get(mallory)).toBeUndefined();
  });

  it('bounds what one identity may announce', async () => {
    const world = makeWorld();
    const bob = world.add('bob', 'bob', { streamIds: ['b-1'] });
    const mallory = uid('mallory');

    for (let i = 0; i < 500; i += 1) {
      bob.mesh.handleSignal(inbound(mallory, `mesh:${ROOM}:role:share:flood-${i}`));
    }

    // A peer announcing in a loop must not be able to grow this without end.
    expect(announcedRoles(bob.mesh).get(mallory)?.size).toBeLessThanOrEqual(16);
  });

  it('forgets what a departed person announced', async () => {
    const world = makeWorld();
    const alice = world.add('alice', 'alice', { streamIds: ['s-share'] });
    const bob = world.add('bob', 'bob', { streamIds: ['b-1'] });

    alice.mesh.setLocalTrack('share', track('alice-screen', 'video'));
    alice.mesh.syncPeers([bob.userId]);
    bob.mesh.syncPeers([alice.userId]);
    await world.clock.advance(500);

    expect(announcedRoles(bob.mesh).get(alice.userId)?.size).toBe(1);

    // Their stream ids are per-socket; the ones they come back with are new.
    bob.mesh.syncPeers([]);
    expect(announcedRoles(bob.mesh).get(alice.userId)).toBeUndefined();
  });
});
