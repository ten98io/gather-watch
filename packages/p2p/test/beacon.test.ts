import { describe, expect, it } from 'vitest';
import { BeaconFollower, BeaconSender } from '../src/beacon';
import type { SyncBeacon } from '../src/channels';
import { ChannelFabric } from '../src/channels';
import { MockNetwork, VirtualClock, mulberry32, uid } from './harness';

function makeBeacon(over: Partial<SyncBeacon>): SyncBeacon {
  return {
    t: 'beacon',
    positionMs: 0,
    rate: 1,
    playing: true,
    masterTs: 0,
    epoch: 1,
    ...over,
  };
}

describe('BeaconSender', () => {
  it('sender cadence: immediate, periodic, mutation restarts cadence, stop halts', async () => {
    const clock = new VirtualClock();
    const beacons: SyncBeacon[] = [];
    const sender = new BeaconSender({
      broadcast: (msg) => {
        beacons.push(msg);
      },
      getState: () => ({ positionMs: 0, rate: 1, playing: true }),
      getEpoch: () => 1,
      now: () => clock.now(),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      intervalMs: 1000,
    });

    sender.start();
    expect(beacons).toHaveLength(1); // one beacon immediately

    await clock.advance(3500);
    expect(beacons).toHaveLength(4); // t = 0, 1000, 2000, 3000

    sender.mutate();
    expect(beacons).toHaveLength(5); // mutation beacons immediately

    // The cadence restarted at the mutation: nothing 999ms later...
    await clock.advance(999);
    expect(beacons).toHaveLength(5);
    // ...and the next periodic beacon lands a full 1000ms after the mutation.
    await clock.advance(1);
    expect(beacons).toHaveLength(6);
    const mutated = beacons[4]!;
    const next = beacons[5]!;
    expect(next.masterTs - mutated.masterTs).toBe(1000);

    sender.stop();
    await clock.advance(5000);
    expect(beacons).toHaveLength(6);
  });
});

describe('BeaconFollower', () => {
  it('beacon → ClockEstimator pipeline yields expectedPosition within tolerance', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock, mulberry32(7));
    const [dcA, dcB] = net.createChannelPair({ delayMs: 20, jitterMs: 10 });

    const fabricA = new ChannelFabric();
    const fabricB = new ChannelFabric();
    fabricA.attach(uid('b'), 'sync', dcA);
    fabricB.attach(uid('a'), 'sync', dcB);

    // Master and follower share the VirtualClock, but the master's clock is skewed.
    const masterNow = (): number => clock.now() + 40_000;
    const t0 = masterNow();

    const sender = new BeaconSender({
      broadcast: (msg) => {
        fabricA.broadcast('sync', msg);
      },
      getState: () => ({ positionMs: masterNow() - t0, rate: 1, playing: true }),
      getEpoch: () => 1,
      now: masterNow,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      intervalMs: 1000,
    });

    const follower = new BeaconFollower({ now: () => clock.now() });
    fabricB.onMessage('sync', (_peer, msg) => {
      follower.onBeacon(msg);
    });

    sender.start();
    await clock.advance(10_000); // ~10 periodic beacons flow through

    // Sample the expected position at instants BETWEEN beacons; the follower's
    // drift-corrected playhead must track the true master position.
    for (const step of [300, 400, 300]) {
      await clock.advance(step);
      const expected = follower.expectedPositionMs();
      expect(expected).not.toBeNull();
      const truth = masterNow() - t0;
      expect(Math.abs((expected as number) - truth)).toBeLessThanOrEqual(60);
    }

    // The estimated clock offset recovers the 40s skew (minus the small,
    // stable one-way channel latency the zero-RTT samples absorb).
    expect(follower.offsetMs()).toBeGreaterThanOrEqual(39_900);
    expect(follower.offsetMs()).toBeLessThanOrEqual(40_100);
  });

  it('stale-epoch beacons are ignored', () => {
    const clock = new VirtualClock();
    const follower = new BeaconFollower({ now: () => clock.now() });

    const fresh = makeBeacon({
      epoch: 3,
      positionMs: 1000,
      playing: false,
      masterTs: clock.now(),
    });
    follower.onBeacon(fresh);
    expect(follower.expectedPositionMs()).toBe(1000);

    const stale = makeBeacon({
      epoch: 2,
      positionMs: 9999,
      playing: false,
      masterTs: clock.now() + 5000,
    });
    follower.onBeacon(stale);

    expect(follower.lastBeacon()).toBe(fresh);
    expect(follower.lastBeacon()?.epoch).toBe(3);
    expect(follower.expectedPositionMs()).toBe(1000);
  });

  it('paused beacons freeze the expected position', async () => {
    const clock = new VirtualClock();
    const follower = new BeaconFollower({ now: () => clock.now() });

    follower.onBeacon(
      makeBeacon({ playing: false, positionMs: 5000, masterTs: clock.now(), epoch: 1 }),
    );
    await clock.advance(3000);
    expect(follower.expectedPositionMs()).toBe(5000);
  });
});
