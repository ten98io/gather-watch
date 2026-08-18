/**
 * Share audio is a role of its own.
 *
 * The blocker this file guards: a screen capture's AUDIO was published on the
 * 'mic' role. One role means one sender, so starting a share REPLACED the
 * host's live microphone with the tab's soundtrack for the whole room, and
 * stopping the share nulled that same sender and left the host silent with
 * their mic button still reading "on". 'share-audio' makes the two physically
 * different senders, so neither can stand on the other — and a viewer can be
 * given the share's sound without being handed somebody's microphone.
 */
import { describe, expect, it } from 'vitest';
import { MeshManager } from '../src/mesh';
import type { MediaStreamTrackLike } from '../src/types';
import { MockNetwork, MockPeerConnection, VirtualClock, rid, uid } from './harness';

const ROOM = rid('room-share-audio');
const ME = uid('me');
const PEER = uid('peer');

function track(id: string, kind: 'audio' | 'video'): MediaStreamTrackLike {
  return { id, kind, enabled: true, stop: () => undefined } as MediaStreamTrackLike;
}

/** A mesh with one peer, plus the pc it was built on. */
function meshWithPeer(): { mesh: MeshManager; pc: MockPeerConnection } {
  const clock = new VirtualClock();
  const net = new MockNetwork(clock);
  let built: MockPeerConnection | null = null;
  const mesh = new MeshManager({
    roomId: ROOM,
    localUserId: ME,
    rtcFactory: (config) => {
      net.setNextOwner('me');
      const pc = net.rtcFactory(config);
      built = pc as MockPeerConnection;
      return pc;
    },
    send: () => undefined,
    getIceServers: () => [{ urls: ['stun:stun.l.google.com:19302'] }],
    now: () => clock.now(),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onError: () => undefined,
  });
  mesh.syncPeers([PEER]);
  if (built === null) throw new Error('no peer connection was built');
  return { mesh, pc: built };
}

describe('share audio role', () => {
  it('publishes share audio on a sender of its own, leaving the microphone armed', () => {
    const { mesh, pc } = meshWithPeer();
    const mic = track('mic-1', 'audio');
    mesh.setLocalTrack('mic', mic);
    expect(pc.senders).toHaveLength(1);

    mesh.setLocalTrack('share-audio', track('tab-1', 'audio'));

    // Two audio senders, not one re-pointed: the room still hears the host.
    expect(pc.senders).toHaveLength(2);
    expect(pc.senders.map((s) => s.track?.id)).toEqual(['mic-1', 'tab-1']);
  });

  it('leaves the microphone publishing when the share stops', () => {
    const { mesh, pc } = meshWithPeer();
    const mic = track('mic-1', 'audio');
    mesh.setLocalTrack('mic', mic);
    mesh.setLocalTrack('share', track('tab-v', 'video'));
    mesh.setLocalTrack('share-audio', track('tab-a', 'audio'));

    // Stopping the share withdraws exactly what the share published.
    mesh.setLocalTrack('share', null);
    mesh.setLocalTrack('share-audio', null);

    const micSender = pc.senders.find((s) => s.track?.id === 'mic-1');
    expect(micSender).toBeDefined();
    // The mic button says "on", and this is what makes that true.
    expect(micSender?.track).toBe(mic);
  });
});
