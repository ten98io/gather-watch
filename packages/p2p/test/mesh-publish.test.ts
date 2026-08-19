/**
 * The mesh connects the ROOM; the camera and the microphone belong to the CALL.
 *
 * Every person in the room gets a peer connection, because that is what carries
 * the DataChannel fabric — sync, file transfer, emotes — and a lurker's fabric
 * is as real as a caller's. The camera used to ride that same reasoning: a
 * track was fanned to every non-auxiliary link there was. In a room of twelve
 * where four are calling, each of those four encoded and uploaded ELEVEN copies
 * of their camera, eight of them to people who never pressed Join. That is a
 * privacy failure first and a bandwidth failure second.
 *
 * So the AUDIENCE gates the track and never the connection, and the camera —
 * the one role whose cost multiplies with the room, one encode per receiver —
 * carries a ceiling that is divided among the people actually receiving it.
 */
import { describe, expect, it } from 'vitest';
import type { UserId } from '@gather/contracts';
import { MeshManager } from '../src/mesh';
import type { MediaStreamTrackLike, RtpParametersLike } from '../src/types';
import { MockNetwork, MockPeerConnection, MockRtpSender, VirtualClock, rid, uid } from './harness';

const ROOM = rid('room-publish');
const ME = uid('me');
const CALLER = uid('caller');
const LURKER = uid('lurker');

const track = (id: string, kind: 'audio' | 'video'): MediaStreamTrackLike =>
  ({ id, kind, enabled: true, stop: () => undefined }) as MediaStreamTrackLike;

interface PublishWorld {
  mesh: MeshManager;
  /** The pc built for one peer. Peers are built in the order given. */
  pcOf: (peerId: UserId) => MockPeerConnection;
  errors: Array<{ peer: UserId; context: string }>;
}

function meshWithPeers(peerIds: UserId[], capCamKbps?: number): PublishWorld {
  const clock = new VirtualClock();
  const net = new MockNetwork(clock);
  const built: MockPeerConnection[] = [];
  const errors: PublishWorld['errors'] = [];
  const mesh = new MeshManager({
    roomId: ROOM,
    localUserId: ME,
    rtcFactory: (config) => {
      net.setNextOwner('me');
      const pc = net.rtcFactory(config) as MockPeerConnection;
      built.push(pc);
      return pc;
    },
    send: () => undefined,
    getIceServers: () => [{ urls: ['stun:stun.l.google.com:19302'] }],
    now: () => clock.now(),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    ...(capCamKbps === undefined ? {} : { capCamKbps }),
    onError: (peer, context) => {
      errors.push({ peer, context });
    },
  });
  mesh.syncPeers(peerIds);
  return {
    mesh,
    pcOf: (peerId) => {
      const pc = built[peerIds.indexOf(peerId)];
      if (pc === undefined) throw new Error(`no peer connection for ${peerId}`);
      return pc;
    },
    errors,
  };
}

/** Track ids currently ARMED on a pc — a muted sender publishes nothing. */
function publishedOn(pc: MockPeerConnection): string[] {
  return pc.senders.flatMap((s) => (s.track === null ? [] : [s.track.id])).sort();
}

function senderFor(pc: MockPeerConnection, trackId: string): MockRtpSender {
  const sender = pc.senders.find((s) => s.track?.id === trackId);
  if (sender === undefined) throw new Error(`no sender for ${trackId}`);
  return sender;
}

function maxBitrateOf(parameters: RtpParametersLike): number | undefined {
  return parameters.encodings[0]?.maxBitrate;
}

describe('publish audience — the call is not the room', () => {
  it('sends the camera and the microphone only to the people on the call', () => {
    const world = meshWithPeers([CALLER, LURKER]);
    world.mesh.setPublishAudience([CALLER]);

    world.mesh.setLocalTrack('mic', track('my-mic', 'audio'));
    world.mesh.setLocalTrack('cam', track('my-cam', 'video'));

    expect(publishedOn(world.pcOf(CALLER))).toEqual(['my-cam', 'my-mic']);
    // The whole defect: this used to be the same two tracks.
    expect(publishedOn(world.pcOf(LURKER))).toEqual([]);
    expect(world.errors).toEqual([]);
  });

  it('keeps the lurker’s connection — the fabric is the room’s, not the call’s', () => {
    const world = meshWithPeers([CALLER, LURKER]);
    world.mesh.setPublishAudience([CALLER]);
    world.mesh.setLocalTrack('cam', track('my-cam', 'video'));

    // Gating the TRACK, never the connection: sync, file transfer and emotes
    // all ride the lurker's link and must not notice the call at all.
    expect(world.mesh.peers().sort()).toEqual([CALLER, LURKER].sort());
    expect(world.pcOf(LURKER).connectionState).not.toBe('closed');
    expect(world.pcOf(LURKER).channels.size).toBeGreaterThan(0);
  });

  it('leaves the screen share room-wide', () => {
    const world = meshWithPeers([CALLER, LURKER]);
    world.mesh.setPublishAudience([CALLER]);

    world.mesh.setLocalTrack('share', track('my-screen', 'video'));
    world.mesh.setLocalTrack('share-audio', track('my-tab-audio', 'audio'));

    // Watching a share is not joining a call, and Mode B viewers who never
    // pressed Join are most of its audience.
    expect(publishedOn(world.pcOf(LURKER))).toEqual(['my-screen', 'my-tab-audio']);
    expect(publishedOn(world.pcOf(CALLER))).toEqual(['my-screen', 'my-tab-audio']);
  });

  it('arms a peer when they join the call and mutes them when they leave', () => {
    const world = meshWithPeers([CALLER, LURKER]);
    world.mesh.setPublishAudience([CALLER]);
    world.mesh.setLocalTrack('cam', track('my-cam', 'video'));
    expect(publishedOn(world.pcOf(LURKER))).toEqual([]);

    world.mesh.setPublishAudience([CALLER, LURKER]);
    expect(publishedOn(world.pcOf(LURKER))).toEqual(['my-cam']);

    world.mesh.setPublishAudience([CALLER]);
    // Muted, not demolished: removing the sender would retire the transceiver
    // and disturb the m-line's receive direction (see camera-toggle.test.ts).
    expect(publishedOn(world.pcOf(LURKER))).toEqual([]);
    expect(world.pcOf(LURKER).senders).toHaveLength(1);
    expect(world.errors).toEqual([]);
  });

  it('publishes to a peer who joins the call after the camera was already on', () => {
    const world = meshWithPeers([CALLER], 1200);
    world.mesh.setPublishAudience([CALLER]);
    world.mesh.setLocalTrack('cam', track('my-cam', 'video'));

    world.mesh.syncPeers([CALLER, LURKER]);
    world.mesh.setPublishAudience([CALLER, LURKER]);

    // A peer built while an audience is in force gets the track at build time,
    // not at the next toggle.
    expect(world.mesh.peers().sort()).toEqual([CALLER, LURKER].sort());
  });

  it('publishes to everyone when no audience was ever set', () => {
    const world = meshWithPeers([CALLER, LURKER]);

    world.mesh.setLocalTrack('cam', track('my-cam', 'video'));

    // The default is the behaviour every caller that only shares a screen
    // wants, and what the extension's share-only mesh relies on.
    expect(publishedOn(world.pcOf(LURKER))).toEqual(['my-cam']);
    expect(publishedOn(world.pcOf(CALLER))).toEqual(['my-cam']);
  });
});

describe('camera ceiling — one encode per receiver', () => {
  it('divides the configured ceiling among the people receiving it', () => {
    const world = meshWithPeers([CALLER], 1200);
    world.mesh.setLocalTrack('cam', track('my-cam', 'video'));

    // Alone with one receiver, the camera gets the whole budget.
    expect(maxBitrateOf(senderFor(world.pcOf(CALLER), 'my-cam').getParameters())).toBe(1_200_000);

    const others = [uid('b'), uid('c'), uid('d')];
    world.mesh.syncPeers([CALLER, ...others]);

    // Four receivers, four encodes off one uplink: the TOTAL stays flat.
    expect(maxBitrateOf(senderFor(world.pcOf(CALLER), 'my-cam').getParameters())).toBe(300_000);
  });

  it('widens the ceiling again when receivers leave', () => {
    const world = meshWithPeers([CALLER, uid('b'), uid('c'), uid('d')], 1200);
    world.mesh.setLocalTrack('cam', track('my-cam', 'video'));
    expect(maxBitrateOf(senderFor(world.pcOf(CALLER), 'my-cam').getParameters())).toBe(300_000);

    world.mesh.syncPeers([CALLER]);

    // A cap that only ever tightened would leave the last person in the room
    // on a quarter of the bitrate for no reason.
    expect(maxBitrateOf(senderFor(world.pcOf(CALLER), 'my-cam').getParameters())).toBe(1_200_000);
  });

  it('counts the call, not the room, when it divides the ceiling', () => {
    const world = meshWithPeers([CALLER, LURKER, uid('c'), uid('d')], 1200);
    world.mesh.setPublishAudience([CALLER]);
    world.mesh.setLocalTrack('cam', track('my-cam', 'video'));

    // Three of the four never receive it, so they must not shrink it either.
    expect(maxBitrateOf(senderFor(world.pcOf(CALLER), 'my-cam').getParameters())).toBe(1_200_000);
  });

  it('stops dividing at a floor worth sending', () => {
    const peers = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => uid(n));
    const world = meshWithPeers(peers, 400);
    world.mesh.setLocalTrack('cam', track('my-cam', 'video'));

    // 400/8 is 50kbps, which buys an unwatchable slideshow. The honest answer
    // below the floor is to stop sending video, not to keep dividing.
    const first = peers[0];
    if (first === undefined) throw new Error('no peers');
    expect(maxBitrateOf(senderFor(world.pcOf(first), 'my-cam').getParameters())).toBe(120_000);
  });

  it('never caps audio, and leaves the camera alone when no ceiling is set', () => {
    const capped = meshWithPeers([CALLER], 1200);
    capped.mesh.setLocalTrack('mic', track('my-mic', 'audio'));
    capped.mesh.setLocalTrack('share-audio', track('my-tab-audio', 'audio'));
    capped.mesh.setLocalTrack('cam', track('my-cam', 'video'));

    // Audio is cheap and it is the half people notice going missing.
    expect(senderFor(capped.pcOf(CALLER), 'my-mic').appliedParameters).toHaveLength(0);
    expect(senderFor(capped.pcOf(CALLER), 'my-tab-audio').appliedParameters).toHaveLength(0);

    const uncapped = meshWithPeers([CALLER]);
    uncapped.mesh.setLocalTrack('cam', track('my-cam', 'video'));
    expect(senderFor(uncapped.pcOf(CALLER), 'my-cam').appliedParameters).toHaveLength(0);
  });
});
