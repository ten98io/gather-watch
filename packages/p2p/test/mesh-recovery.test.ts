/**
 * What happens to a link that stops carrying media.
 *
 * Two failures used to live here. The first: recovery fired on 'failed' and
 * nothing else, so a transport wedged in 'disconnected' — the state ICE reports
 * when consent checks start failing — sat there forever with a tile that looked
 * fine and a call nobody could hear. The second: the restart itself was
 * unbounded. An ICE restart against a path that is genuinely gone accomplishes
 * nothing, and repeating it forever is indistinguishable from a working
 * recovery from the outside: the UI says "trying to get it back" at a link that
 * is never coming back, and nobody is ever told to reload.
 *
 * So 'disconnected' gets a grace window (most of them heal untouched — a wifi
 * roam, a few lost consent checks — and restarting on sight would churn every
 * link in a lossy room), and the restart loop gets a budget that ends in an
 * honest failure instead of a spinner.
 */
import { describe, expect, it } from 'vitest';
import type { UserId } from '@gather/contracts';
import { MeshManager } from '../src/mesh';
import { MockNetwork, MockPeerConnection, VirtualClock, rid, uid } from './harness';

const ROOM = rid('room-recovery');
const ME = uid('me');
const PEER = uid('peer');

/** Long enough to outrun the whole backoff schedule several times over. */
const LONG_ENOUGH_MS = 300_000;

interface RecoveryWorld {
  mesh: MeshManager;
  pc: MockPeerConnection;
  clock: VirtualClock;
  errors: Array<{ peer: UserId; context: string }>;
}

/**
 * One mesh, one peer, and NO counterpart: `send` goes nowhere, so nothing ever
 * answers and the link cannot heal behind the assertions. That is the point —
 * these tests are about what the mesh does when recovery does not work.
 */
function meshWithDeadPeer(): RecoveryWorld {
  const clock = new VirtualClock();
  const net = new MockNetwork(clock);
  const errors: RecoveryWorld['errors'] = [];
  let built: MockPeerConnection | null = null;
  const mesh = new MeshManager({
    roomId: ROOM,
    localUserId: ME,
    rtcFactory: (config) => {
      net.setNextOwner('me');
      const pc = net.rtcFactory(config) as MockPeerConnection;
      built = pc;
      return pc;
    },
    send: () => undefined,
    getIceServers: () => [{ urls: ['stun:stun.l.google.com:19302'] }],
    now: () => clock.now(),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onError: (peer, context) => {
      errors.push({ peer, context });
    },
  });
  mesh.syncPeers([PEER]);
  if (built === null) throw new Error('no peer connection was built');
  return { mesh, pc: built, clock, errors };
}

describe('link recovery', () => {
  it('restarts ICE on a link that failed', async () => {
    const world = meshWithDeadPeer();

    world.pc.forceConnectionState('failed');
    await world.clock.advance(1);

    // The first attempt is immediate: most failures are a NAT rebinding away
    // from working, and waiting to try costs the call seconds of silence.
    expect(world.pc.restartCount).toBe(1);
  });

  it('waits out a brief disconnect, and rebuilds one that does not heal', async () => {
    const world = meshWithDeadPeer();

    world.pc.forceConnectionState('disconnected');
    await world.clock.advance(7999);
    // Still inside the grace window. A wifi roam heals on its own, and
    // restarting on sight of 'disconnected' would churn every link in a lossy
    // room for nothing.
    expect(world.pc.restartCount).toBe(0);

    await world.clock.advance(2);
    // It never came back on its own. This is the case that used to sit there
    // forever, because recovery only ever fired on 'failed'.
    expect(world.pc.restartCount).toBe(1);
  });

  it('leaves a disconnect that healed by itself completely alone', async () => {
    const world = meshWithDeadPeer();

    world.pc.forceConnectionState('disconnected');
    await world.clock.advance(2000);
    world.pc.forceConnectionState('connected');
    await world.clock.advance(LONG_ENOUGH_MS);

    // The pending recovery has to be CANCELLED, not merely skipped: a restart
    // fired at a working link is a fresh gathering round and a media gap.
    expect(world.pc.restartCount).toBe(0);
    expect(world.errors).toEqual([]);
  });

  it('stops after a bounded number of restarts and says so exactly once', async () => {
    const world = meshWithDeadPeer();

    world.pc.forceConnectionState('failed');
    await world.clock.advance(LONG_ENOUGH_MS);

    // Bounded, with backoff between attempts — not a restart every tick for
    // as long as the tab stays open.
    expect(world.pc.restartCount).toBe(4);
    expect(world.errors).toEqual([{ peer: PEER, context: 'iceRecoveryExhausted' }]);

    // And it stays quiet afterwards: one honest sentence, not a toast storm.
    await world.clock.advance(LONG_ENOUGH_MS);
    expect(world.pc.restartCount).toBe(4);
    expect(world.errors).toHaveLength(1);
  });

  it('spends its budget over time, not all at once', async () => {
    const world = meshWithDeadPeer();

    world.pc.forceConnectionState('failed');
    await world.clock.advance(1);
    expect(world.pc.restartCount).toBe(1);

    await world.clock.advance(1000);
    // The second attempt is 2s behind the first: back-to-back restarts would
    // spend the whole budget before the network had a chance to come back.
    expect(world.pc.restartCount).toBe(1);

    await world.clock.advance(2000);
    expect(world.pc.restartCount).toBe(2);
  });

  it('takes an explicit restart as permission to try again', async () => {
    const world = meshWithDeadPeer();
    world.pc.forceConnectionState('failed');
    await world.clock.advance(LONG_ENOUGH_MS);
    expect(world.pc.restartCount).toBe(4);

    // A caller asking for a restart is a person saying the link is worth
    // another try — which is exactly the assumption a spent budget dropped.
    world.mesh.restartIce(PEER);
    await world.clock.advance(LONG_ENOUGH_MS);

    // A whole budget over again — and FOLLOWED UP, not one lone attempt that
    // leaves the link wedged again the moment it does not take.
    expect(world.pc.restartCount).toBe(8);
    expect(world.errors).toEqual([
      { peer: PEER, context: 'iceRecoveryExhausted' },
      { peer: PEER, context: 'iceRecoveryExhausted' },
    ]);
  });

  it('gives a link that recovered a full budget for the next outage', async () => {
    const world = meshWithDeadPeer();

    world.pc.forceConnectionState('failed');
    await world.clock.advance(20_000);
    const spentOnFirstOutage = world.pc.restartCount;
    expect(spentOnFirstOutage).toBeGreaterThan(0);

    world.pc.forceConnectionState('connected');
    await world.clock.advance(1);
    world.pc.forceConnectionState('failed');
    await world.clock.advance(LONG_ENOUGH_MS);

    // Whatever it took, it worked: an hour-long call that flaps twice must not
    // arrive at the second flap with nothing left to spend.
    expect(world.pc.restartCount).toBe(spentOnFirstOutage + 4);
  });

  it('stops trying once the mesh is closed', async () => {
    const world = meshWithDeadPeer();

    world.pc.forceConnectionState('disconnected');
    world.mesh.close();
    await world.clock.advance(LONG_ENOUGH_MS);

    expect(world.pc.restartCount).toBe(0);
  });
});
