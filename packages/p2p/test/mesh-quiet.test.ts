/**
 * A SETTLED PAIR GOES QUIET.
 *
 * The field dump this pins against: two people, one call plus one screen
 * share, and the sharer's RTCPeerConnection cycling
 * `stable => have-local-offer => stable` roughly twice a second, forever —
 * an offer/answer round per signalling RTT on a connection that was otherwise
 * healthy. Media flowed at the RTP level while the UI on both sides failed to
 * render video, because every cycle re-negotiated the same m-lines.
 *
 * The property, stated once: after presence, audience, tracks and share have
 * all converged, ZERO further frames cross the signalling hub. Not "few" —
 * zero; a threshold assertion would let the next storm idle just under it.
 * The storm's generator was applyTrackToPeer's old mute path — removeTrack on
 * every audience drop, addTrack on every return (pre-439f7e8), each pair a
 * renegotiation, driven forever by the presence-reassert fight — and Chrome's
 * addTrack reused whatever transceiver was free, which is also what scrambled
 * mid↔role. Reintroduce either half (removeTrack on mute, or a senders-map
 * entry lost while the pc keeps the sender) and these tests go red with the
 * dump's exact frame cycle.
 *
 * The wiring here is deliberately the web client's, not a minimal one: both
 * endpoints carry an endpointId token, a MediaStream factory, a publish
 * audience and both bitrate caps, exactly as apps/web/lib/call-mesh.ts passes
 * them — and the post-convergence phase keeps the app-layer loops running
 * (presence re-applied every second, pollStats every five) because a reconcile
 * loop that is only idempotent while nobody calls it proves nothing.
 */

import { describe, expect, it } from 'vitest';
import type { UserId } from '@gather/contracts';
import { MeshManager } from '../src/mesh';
import type { MediaStreamTrackLike, OutboundSignal, TrackRole } from '../src/types';
import { MockNetwork, MockPeerConnection, SignalRouter, VirtualClock, rid, uid } from './harness';

const ROOM = rid('room-quiet');
const SHARER = uid('user-a');
const VIEWER = uid('user-b');

const track = (id: string, kind: 'audio' | 'video'): MediaStreamTrackLike => ({
  id,
  kind,
  enabled: true,
});

/** One mesh endpoint wired the way CallMesh wires the real one. */
interface Endpoint {
  userId: UserId;
  mesh: MeshManager;
  received: Array<{ from: UserId; trackId: string; role: TrackRole | null }>;
  errors: Array<{ peer: UserId; context: string }>;
}

interface World {
  clock: VirtualClock;
  net: MockNetwork;
  router: SignalRouter;
  endpoints: Endpoint[];
  /** Run the app-layer loops (presence reconcile, stats poll) for `ms`. */
  run: (ms: number) => Promise<void>;
}

function makeWorld(): World {
  const clock = new VirtualClock();
  const net = new MockNetwork(clock);
  const router = new SignalRouter(clock, ROOM);
  const endpoints: Endpoint[] = [];
  const users = [
    { tag: 'a', userId: SHARER },
    { tag: 'b', userId: VIEWER },
  ];
  for (const { tag, userId } of users) {
    let minted = 0;
    const received: Endpoint['received'] = [];
    const errors: Endpoint['errors'] = [];
    const mesh = new MeshManager({
      roomId: ROOM,
      localUserId: userId,
      // The web client always announces a per-tab token (call-mesh.ts
      // ENDPOINT_TOKEN), so the reproduction must run the announced-endpoint
      // machinery too, not the bare person-level ids.
      endpointId: `tok-${tag}`,
      rtcFactory: (config) => {
        net.setNextOwner(tag);
        return net.rtcFactory(config);
      },
      mediaStreamFactory: () => ({ id: `${tag}-stream-${minted++}` }),
      send: router.attach(userId, (ev) => {
        mesh.handleSignal(ev);
      }),
      getIceServers: () => [{ urls: ['stun:stun.example:3478'] }],
      now: () => clock.now(),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      // The defaults the web client passes (DEFAULT_CAP_RELAYED_VIDEO_KBPS,
      // DEFAULT_CAP_CAM_KBPS) — the cap reconcile has to be part of the loop
      // being proven quiet.
      capRelayedVideoKbps: 400,
      capCamKbps: 1200,
      onError: (peer, context) => {
        errors.push({ peer, context });
      },
    });
    mesh.onRemoteTrack((from, t, _streams, role) => {
      received.push({ from, trackId: t.id, role });
    });
    endpoints.push({ userId, mesh, received, errors });
  }
  const run = async (ms: number): Promise<void> => {
    // The app layer never goes quiet even when the mesh should: room-context
    // rewrites presence for its own reasons (CallMesh.reconcilePeers runs on
    // every write) and CallMesh polls link stats on an interval. A mesh only
    // counts as settled if THESE keep running and still nothing hits the wire.
    const step = 1000;
    for (let done = 0; done < ms; done += step) {
      for (const ep of endpoints) {
        ep.mesh.syncPeers(endpoints.filter((o) => o !== ep).map((o) => o.userId));
        ep.mesh.setPublishAudience(endpoints.filter((o) => o !== ep).map((o) => o.userId));
        void ep.mesh.pollStats();
      }
      await clock.advance(step);
    }
  };
  return { clock, net, router, endpoints, run };
}

/** Frames that crossed the hub after `from`, described tersely for failure
 *  output: a storm should FAIL LOUD with the frame types it kept sending. */
function framesSince(router: SignalRouter, from: number): string[] {
  return router.sentEvents.slice(from).map((ev: OutboundSignal) => ev.type);
}

/** All live pcs an owner tag holds (the same reach-in mesh-convergence.test.ts
 *  uses — the pc map has no public surface, deliberately). */
function livePcs(net: MockNetwork, ownerTag: string): MockPeerConnection[] {
  const anyNet = net as unknown as { pcs: Map<number, MockPeerConnection> };
  const out: MockPeerConnection[] = [];
  for (const pc of anyNet.pcs.values()) {
    if (pc.ownerTag === ownerTag && pc.connectionState !== 'closed') out.push(pc);
  }
  return out;
}

/** The one live pc a single-peer mesh holds. */
function pcOf(net: MockNetwork, ownerTag: string): MockPeerConnection {
  const pcs = livePcs(net, ownerTag);
  const pc = pcs[0];
  if (pc === undefined || pcs.length !== 1) {
    throw new Error(`expected exactly one live pc for ${ownerTag}, found ${pcs.length}`);
  }
  return pc;
}

/** Bring a world to the dump's shape: both on the call with mic+cam, endpoint
 *  a sharing with sound, everything delivered and both sides connected. */
async function converge(world: World): Promise<{ sharer: Endpoint; viewer: Endpoint }> {
  const [sharer, viewer] = world.endpoints as [Endpoint, Endpoint];
  await world.run(1000);
  sharer.mesh.setLocalTrack('mic', track('a-mic', 'audio'));
  sharer.mesh.setLocalTrack('cam', track('a-cam', 'video'));
  viewer.mesh.setLocalTrack('mic', track('b-mic', 'audio'));
  viewer.mesh.setLocalTrack('cam', track('b-cam', 'video'));
  await world.run(3000);
  // The sharer starts a screen share with sound (ScreenShareStage's path).
  sharer.mesh.setLocalTrack('share', track('a-share', 'video'));
  sharer.mesh.setLocalTrack('share-audio', track('a-share-audio', 'audio'));
  await world.run(5000);
  expect(sharer.mesh.connectionStates().get(VIEWER)).toBe('connected');
  expect(viewer.mesh.connectionStates().get(SHARER)).toBe('connected');
  return { sharer, viewer };
}

describe('mesh quiet after convergence', () => {
  it('a settled call+share pair sends nothing more — no offers, no answers, no ice', async () => {
    const world = makeWorld();
    const { sharer, viewer } = await converge(world);

    // Everything got where it was going, with the role it was published under.
    const viewerGot = viewer.received.map((d) => `${d.trackId}:${d.role}`).sort();
    expect(viewerGot).toEqual(
      ['a-mic:mic', 'a-cam:cam', 'a-share:share', 'a-share-audio:share-audio'].sort(),
    );
    const sharerGot = sharer.received.map((d) => `${d.trackId}:${d.role}`).sort();
    expect(sharerGot).toEqual(['b-mic:mic', 'b-cam:cam'].sort());

    // THE PROPERTY. A full minute of app-layer churn — presence reconciles,
    // audience re-applied, stats polls — and the wire stays silent.
    const settledAt = world.router.sentEvents.length;
    await world.run(60_000);
    expect(framesSince(world.router, settledAt)).toEqual([]);
    expect(sharer.errors).toEqual([]);
    expect(viewer.errors).toEqual([]);
  });

  it('audience and camera flaps ride replaceTrack: zero frames, zero new m-lines', async () => {
    const world = makeWorld();
    const { sharer, viewer } = await converge(world);
    const sharerPc = pcOf(world.net, 'a');
    const viewerPc = pcOf(world.net, 'b');

    // The dump's `transceiverModified(kind=audio)` was the mic sender being
    // torn down and re-added per audience flap — a renegotiation each time the
    // presence echo blinked, ~2/s, forever. A flap must be replaceTrack on the
    // sender each role already owns: same sender objects, same count (each
    // sender is one m-line — a grown count is a scrambled mid waiting to
    // happen), and NOTHING on the wire.
    const sharerSenders = [...sharerPc.senders];
    const viewerSenders = [...viewerPc.senders];
    const settledAt = world.router.sentEvents.length;

    for (let i = 0; i < 6; i += 1) {
      // Presence blinks the viewer out of the call and back (the reassert
      // fight the extension's presence timer used to cause).
      sharer.mesh.setPublishAudience([]);
      await world.run(1000);
      sharer.mesh.setPublishAudience([VIEWER]);
      await world.run(1000);
      // Meanwhile the viewer toggles their camera off and on.
      viewer.mesh.setLocalTrack('cam', null);
      await world.run(1000);
      viewer.mesh.setLocalTrack('cam', track(`b-cam-${i}`, 'video'));
      await world.run(1000);
    }

    expect(framesSince(world.router, settledAt)).toEqual([]);
    // Same senders, same order: the transceiver a role got at first publish is
    // the transceiver it keeps for the life of the connection.
    expect(sharerPc.senders).toEqual(sharerSenders);
    expect(viewerPc.senders).toEqual(viewerSenders);
    // And the flaps genuinely took effect on those senders.
    expect(sharerPc.senders.map((s) => s.track?.id ?? null)).toContain('a-cam');
    expect(viewerPc.senders.map((s) => s.track?.id ?? null)).toContain('b-cam-5');
    expect(sharer.errors).toEqual([]);
    expect(viewer.errors).toEqual([]);
  });

  it('a share stopped and restarted reuses its senders: zero frames, same m-lines', async () => {
    const world = makeWorld();
    const { sharer, viewer } = await converge(world);
    const sharerPc = pcOf(world.net, 'a');
    const before = [...sharerPc.senders];
    const settledAt = world.router.sentEvents.length;

    // Stop sharing (ScreenShareStage teardown), then share something else.
    sharer.mesh.setLocalTrack('share', null);
    sharer.mesh.setLocalTrack('share-audio', null);
    await world.run(2000);
    sharer.mesh.setLocalTrack('share', track('a-share-2', 'video'));
    sharer.mesh.setLocalTrack('share-audio', track('a-share-audio-2', 'audio'));
    await world.run(2000);

    expect(framesSince(world.router, settledAt)).toEqual([]);
    expect(sharerPc.senders).toEqual(before);
    expect(sharerPc.senders.map((s) => s.track?.id ?? null)).toContain('a-share-2');
    expect(sharer.errors).toEqual([]);
    expect(viewer.errors).toEqual([]);
  });
});
