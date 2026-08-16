import { describe, expect, it } from 'vitest';
import type { UserId } from '@gather/contracts';
import { BeaconSender } from '../src/beacon';
import { MasterElection } from '../src/election';
import type { ElectionPeer } from '../src/election';
import { VirtualClock, uid } from './harness';

/** One simulated participant: election + optional beacon sender + event log. */
interface Node {
  userId: UserId;
  joinOrder: number;
  election: MasterElection;
  sender: BeaconSender;
  claims: number[];
  masterLog: Array<{ master: UserId; epoch: number }>;
  /** Delivery gate: userIds this node currently receives beacons FROM. */
  hears: Set<UserId>;
}

interface Cluster {
  clock: VirtualClock;
  nodes: Map<UserId, Node>;
  stopTicking: () => void;
}

function makeCluster(clock: VirtualClock, spec: Array<[string, number]>): Cluster {
  const nodes = new Map<UserId, Node>();
  for (const [raw, joinOrder] of spec) {
    const userId = uid(raw);
    const claims: number[] = [];
    const masterLog: Array<{ master: UserId; epoch: number }> = [];
    /** Late-bound so masterChanged can stop the sender synchronously. */
    let senderRef: BeaconSender | null = null;
    const election = new MasterElection({
      localUserId: userId,
      localJoinOrder: joinOrder,
      now: () => clock.now(),
      events: {
        claimMaster: (epoch) => {
          claims.push(epoch);
        },
        masterChanged: (master, epoch) => {
          masterLog.push({ master, epoch });
          // A real app must stop beaconing the INSTANT it loses mastership:
          // one more beacon would carry the freshly adopted higher epoch under
          // the old master's id and resurrect the split-brain via tie-break.
          if (master !== userId) senderRef?.stop();
        },
      },
    });
    const node: Node = {
      userId,
      joinOrder,
      election,
      claims,
      masterLog,
      hears: new Set(spec.map(([r]) => uid(r)).filter((u) => u !== userId)),
      sender: null as unknown as BeaconSender,
    };
    node.sender = new BeaconSender({
      broadcast: (msg) => {
        if (msg.t !== 'beacon') return;
        for (const other of nodes.values()) {
          if (other.userId === userId) continue;
          if (!other.hears.has(userId)) continue;
          clock.setTimeoutFn(() => {
            other.election.noteBeacon(userId, msg.epoch);
          }, 5);
        }
      },
      getState: () => ({ positionMs: 0, rate: 1, playing: true }),
      // Beacon OUR claim's epoch, never the global maxEpoch: after adopting a
      // higher-epoch master this node must not launder that epoch as its own.
      getEpoch: () => {
        const master = election.currentMaster();
        return master !== null && master.userId === userId ? master.epoch : election.epoch();
      },
      now: () => clock.now(),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    senderRef = node.sender;
    nodes.set(userId, node);
  }

  // Full-mesh connected sets by default.
  syncPeersFull(nodes);

  // 500ms evaluate cadence per node; the master (and only the master) beacons.
  let ticking = true;
  const tick = (): void => {
    if (!ticking) return;
    for (const node of nodes.values()) {
      node.election.evaluate();
      if (node.election.isMaster()) {
        if (!node.sender.running()) node.sender.start();
      } else if (node.sender.running()) {
        node.sender.stop();
      }
    }
    clock.setTimeoutFn(tick, 500);
  };
  clock.setTimeoutFn(tick, 0);

  return {
    clock,
    nodes,
    stopTicking: () => {
      ticking = false;
    },
  };
}

function syncPeersFull(nodes: Map<UserId, Node>): void {
  for (const node of nodes.values()) {
    const peers: ElectionPeer[] = [];
    for (const other of nodes.values()) {
      if (other.userId !== node.userId && node.hears.has(other.userId)) {
        peers.push({ userId: other.userId, joinOrder: other.joinOrder });
      }
    }
    node.election.setPeers(peers);
  }
}

/** Remove `dead` from every survivor's connected set and stop its beacons. */
function killNode(cluster: Cluster, dead: UserId): void {
  const node = cluster.nodes.get(dead);
  if (node !== undefined) node.sender.stop();
  for (const other of cluster.nodes.values()) {
    other.hears.delete(dead);
  }
  if (node !== undefined) node.hears.clear();
  syncPeersFull(cluster.nodes);
}

describe('MasterElection cluster behavior', () => {
  it('converges on the lowest joinOrder at startup, single claim', async () => {
    const clock = new VirtualClock();
    const cluster = makeCluster(clock, [
      ['u-a', 1],
      ['u-b', 2],
      ['u-c', 3],
    ]);
    await clock.advance(1000);

    const a = cluster.nodes.get(uid('u-a'))!;
    const b = cluster.nodes.get(uid('u-b'))!;
    const c = cluster.nodes.get(uid('u-c'))!;
    expect(a.claims).toEqual([1]);
    expect(b.claims).toEqual([]);
    expect(c.claims).toEqual([]);
    for (const node of [a, b, c]) {
      expect(node.election.currentMaster()).toEqual({ userId: uid('u-a'), epoch: 1 });
    }
    expect(a.election.isMaster()).toBe(true);
  });

  it('re-elects within 2 beacon periods after the 3s liveness timeout', async () => {
    const clock = new VirtualClock();
    const cluster = makeCluster(clock, [
      ['u-a', 1],
      ['u-b', 2],
      ['u-c', 3],
    ]);
    await clock.advance(2000); // A established and beaconing.

    killNode(cluster, uid('u-a'));
    // Liveness timeout (3000ms) + 2 beacon periods (2000ms) of margin.
    await clock.advance(5000);

    const b = cluster.nodes.get(uid('u-b'))!;
    const c = cluster.nodes.get(uid('u-c'))!;
    expect(b.claims).toEqual([2]);
    expect(c.claims).toEqual([]);
    expect(b.election.isMaster()).toBe(true);
    expect(c.election.currentMaster()).toEqual({ userId: uid('u-b'), epoch: 2 });

    // Epochs are monotonic across every claim any node ever made.
    const allClaims = [...cluster.nodes.values()].flatMap((n) => n.claims);
    const sorted = [...allClaims].sort((x, y) => x - y);
    expect(new Set(allClaims).size).toBe(allClaims.length);
    expect(allClaims.length).toBeGreaterThan(0);
    expect(sorted).toEqual([1, 2]);
  });

  it('heals split-brain: higher epoch wins, old master steps down', async () => {
    const clock = new VirtualClock();
    const cluster = makeCluster(clock, [
      ['u-a', 1],
      ['u-b', 2],
      ['u-c', 3],
    ]);
    await clock.advance(2000); // A is master at epoch 1.

    // Partition: {A} | {B, C}. A keeps believing it is master.
    const a = cluster.nodes.get(uid('u-a'))!;
    const b = cluster.nodes.get(uid('u-b'))!;
    const c = cluster.nodes.get(uid('u-c'))!;
    a.hears.clear();
    b.hears.delete(uid('u-a'));
    c.hears.delete(uid('u-a'));
    for (const other of [b, c]) other.hears.add(other === b ? uid('u-c') : uid('u-b'));
    syncPeersFull(cluster.nodes);

    await clock.advance(6000); // B times A out and claims epoch 2.
    expect(a.election.isMaster()).toBe(true); // dual master while partitioned
    expect(b.election.isMaster()).toBe(true);
    expect(b.claims).toEqual([2]);

    // Heal: everyone hears everyone again.
    for (const node of [a, b, c]) {
      node.hears = new Set(
        [uid('u-a'), uid('u-b'), uid('u-c')].filter((u) => u !== node.userId),
      );
    }
    syncPeersFull(cluster.nodes);
    await clock.advance(2500); // B's next beacons reach A.

    expect(a.election.isMaster()).toBe(false);
    expect(a.election.currentMaster()?.userId).toBe(uid('u-b'));
    expect(b.election.isMaster()).toBe(true);
    expect(c.election.currentMaster()).toEqual({ userId: uid('u-b'), epoch: 2 });

    // No node ever claimed a non-monotonic epoch.
    for (const node of [a, b, c]) {
      for (let i = 1; i < node.claims.length; i += 1) {
        expect(node.claims[i]!).toBeGreaterThan(node.claims[i - 1]!);
      }
    }
    // Exactly one master after heal.
    const masters = [a, b, c].filter((n) => n.election.isMaster());
    expect(masters.map((m) => m.userId)).toEqual([uid('u-b')]);
  });

  it('breaks equal-epoch ties by lexicographically lower userId', async () => {
    const clock = new VirtualClock();
    const x = new MasterElection({
      localUserId: uid('u-x'),
      localJoinOrder: 1,
      now: () => clock.now(),
    });
    const y = new MasterElection({
      localUserId: uid('u-y'),
      localJoinOrder: 1,
      now: () => clock.now(),
    });
    // Isolated startup: both claim epoch 1 in their own partition.
    x.setPeers([]);
    y.setPeers([]);
    x.evaluate();
    y.evaluate();
    expect(x.isMaster()).toBe(true);
    expect(y.isMaster()).toBe(true);
    expect(x.epoch()).toBe(1);
    expect(y.epoch()).toBe(1);

    // Heal: each hears the other's epoch-1 beacon.
    x.noteBeacon(uid('u-y'), 1);
    y.noteBeacon(uid('u-x'), 1);
    expect(x.currentMaster()?.userId).toBe(uid('u-x'));
    expect(y.currentMaster()?.userId).toBe(uid('u-x'));
    expect(x.isMaster()).toBe(true);
    expect(y.isMaster()).toBe(false);
  });

  it('adopts the server verdict even over local optimism', () => {
    const clock = new VirtualClock();
    const a = new MasterElection({
      localUserId: uid('u-a'),
      localJoinOrder: 1,
      now: () => clock.now(),
    });
    a.setPeers([]);
    a.evaluate();
    expect(a.isMaster()).toBe(true);

    a.applyServerMasterChanged(uid('u-b'), 1);
    expect(a.isMaster()).toBe(false);
    expect(a.currentMaster()).toEqual({ userId: uid('u-b'), epoch: 1 });
  });
});
