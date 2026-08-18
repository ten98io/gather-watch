/**
 * Turning a camera off must MUTE the sender, not demolish the transceiver.
 *
 * The reported symptom: turning your own camera off stopped the REMOTE
 * camera too, and turning it back on did nothing until you toggled a second
 * time. Both follow from `removeTrack`: it retires the transceiver and forces
 * a renegotiation, and on a sendrecv m-line that disturbs the receive
 * direction as well; turning the camera back on then queued a second
 * renegotiation immediately behind the first, and whichever one glare
 * handling discarded, the camera stayed dark until the next toggle won the
 * race. `replaceTrack(null)` keeps the sender and needs no renegotiation at
 * all, so neither failure can occur.
 */
import { describe, expect, it } from 'vitest';
import { MeshManager } from '../src/mesh';
import type { MediaStreamTrackLike } from '../src/types';
import { MockNetwork, MockPeerConnection, VirtualClock, rid, uid } from './harness';

const ROOM = rid('room-cam');
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

describe('camera toggle', () => {
  it('mutes the sender instead of removing it', () => {
    const { mesh, pc } = meshWithPeer();
    const cam = track('cam-1', 'video');
    mesh.setLocalTrack('cam', cam);
    expect(pc.senders).toHaveLength(1);

    mesh.setLocalTrack('cam', null);

    // The sender — and therefore the transceiver and the m-line — survives.
    // Removing it is what disturbed the receive direction and dropped the
    // remote camera along with the local one.
    expect(pc.senders).toHaveLength(1);
    expect(pc.senders[0]?.track).toBeNull();
  });

  it('re-arms the SAME sender when the camera comes back', () => {
    const { mesh, pc } = meshWithPeer();
    const first = track('cam-1', 'video');
    mesh.setLocalTrack('cam', first);
    const sender = pc.senders[0];

    mesh.setLocalTrack('cam', null);
    const second = track('cam-2', 'video');
    mesh.setLocalTrack('cam', second);

    // Same sender object, new track: no addTrack, so no second renegotiation
    // racing the first. This is the half that made the camera need two toggles.
    expect(pc.senders).toHaveLength(1);
    expect(pc.senders[0]).toBe(sender);
    expect(pc.senders[0]?.track).toBe(second);
  });

  it('survives repeated toggling without growing m-lines', () => {
    const { mesh, pc } = meshWithPeer();
    for (let i = 0; i < 8; i += 1) {
      mesh.setLocalTrack('cam', track(`cam-${i}`, 'video'));
      mesh.setLocalTrack('cam', null);
    }
    // Eight off/on cycles used to mean eight addTrack calls and a steadily
    // growing SDP; now it is one sender for the life of the connection.
    expect(pc.senders).toHaveLength(1);
    expect(pc.senders[0]?.track).toBeNull();
  });

  it('leaves the microphone alone when only the camera toggles', () => {
    const { mesh, pc } = meshWithPeer();
    const mic = track('mic-1', 'audio');
    const cam = track('cam-1', 'video');
    mesh.setLocalTrack('mic', mic);
    mesh.setLocalTrack('cam', cam);
    expect(pc.senders).toHaveLength(2);

    mesh.setLocalTrack('cam', null);

    expect(pc.senders).toHaveLength(2);
    // The mic must still be publishing — a camera toggle that silences the
    // microphone is the same class of cross-contamination.
    expect(pc.senders.find((s) => s.track === mic)).toBeDefined();
  });
});
