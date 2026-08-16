import { describe, expect, it } from 'vitest';
import type { UserId } from '@playin/contracts';
import { classifyLinkStats } from '../src/linkstate';
import { MeshManager } from '../src/mesh';
import type { MediaStreamTrackLike, RtpParametersLike } from '../src/types';
import {
  MockNetwork,
  MockPeerConnection,
  MockRtpSender,
  SignalRouter,
  VirtualClock,
  rid,
  uid,
} from './harness';

const ROOM = rid('room-linkstate');

/** Standard stats shape: transport -> selectedCandidatePairId -> pair -> candidates. */
function transportStats(local: string, remote: string): unknown {
  return new Map<string, unknown>([
    ['T1', { id: 'T1', type: 'transport', selectedCandidatePairId: 'CP1' }],
    ['CP1', { id: 'CP1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1' }],
    ['L1', { id: 'L1', type: 'local-candidate', candidateType: local }],
    ['R1', { id: 'R1', type: 'remote-candidate', candidateType: remote }],
  ]);
}

/** Older shortcut shape: no transport entry, candidate-pair carries .selected. */
function selectedPairStats(local: string, remote: string): unknown {
  return [
    {
      id: 'CP9',
      type: 'candidate-pair',
      selected: true,
      localCandidateId: 'L9',
      remoteCandidateId: 'R9',
    },
    { id: 'L9', type: 'local-candidate', candidateType: local },
    { id: 'R9', type: 'remote-candidate', candidateType: remote },
  ];
}

describe('classifyLinkStats', () => {
  it('classifies via the transport selectedCandidatePairId route', () => {
    expect(classifyLinkStats(transportStats('host', 'host'))).toBe('direct');
    expect(classifyLinkStats(transportStats('srflx', 'prflx'))).toBe('direct');
    expect(classifyLinkStats(transportStats('relay', 'host'))).toBe('relayed');
    expect(classifyLinkStats(transportStats('host', 'relay'))).toBe('relayed');
  });

  it('classifies via the older candidate-pair.selected shortcut', () => {
    expect(classifyLinkStats(selectedPairStats('host', 'srflx'))).toBe('direct');
    expect(classifyLinkStats(selectedPairStats('relay', 'srflx'))).toBe('relayed');
    expect(classifyLinkStats(selectedPairStats('host', 'relay'))).toBe('relayed');
  });

  it('reads a plain object keyed by stat id', () => {
    const stats = {
      T1: { id: 'T1', type: 'transport', selectedCandidatePairId: 'CP1' },
      CP1: { id: 'CP1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1' },
      L1: { id: 'L1', type: 'local-candidate', candidateType: 'relay' },
      R1: { id: 'R1', type: 'remote-candidate', candidateType: 'host' },
    };
    expect(classifyLinkStats(stats)).toBe('relayed');
  });

  it('returns unknown for absent, foreign, or unresolvable stats', () => {
    expect(classifyLinkStats(undefined)).toBe('unknown');
    expect(classifyLinkStats(null)).toBe('unknown');
    expect(classifyLinkStats({})).toBe('unknown');
    expect(classifyLinkStats({ pcId: 3, ownerTag: 'alice' })).toBe('unknown');
    expect(classifyLinkStats('not stats')).toBe('unknown');
    // A transport with no selected pair yet (mid-ICE) is not a classification.
    expect(classifyLinkStats([{ id: 'T1', type: 'transport' }])).toBe('unknown');
    // A selected pair whose candidate entries are missing resolves neither way.
    expect(
      classifyLinkStats([
        {
          id: 'CP1',
          type: 'candidate-pair',
          selected: true,
          localCandidateId: 'L1',
          remoteCandidateId: 'R1',
        },
      ]),
    ).toBe('unknown');
    // One side resolving non-relay cannot rule out relay on the missing side.
    expect(
      classifyLinkStats([
        {
          id: 'CP1',
          type: 'candidate-pair',
          selected: true,
          localCandidateId: 'L1',
          remoteCandidateId: 'R1',
        },
        { id: 'L1', type: 'local-candidate', candidateType: 'host' },
      ]),
    ).toBe('unknown');
  });
});

interface CapWorld {
  clock: VirtualClock;
  net: MockNetwork;
  managers: Map<UserId, MeshManager>;
  errors: Array<{ user: UserId; peer: UserId; context: string }>;
  setStats: (ownerTag: string, stats: unknown) => void;
  clearStats: (ownerTag: string) => void;
}

function makeCapWorld(userIds: string[], capKbps?: number): CapWorld {
  const clock = new VirtualClock();
  const net = new MockNetwork(clock);
  const router = new SignalRouter(clock, ROOM);
  const managers = new Map<UserId, MeshManager>();
  const errors: CapWorld['errors'] = [];
  const statsByOwner = new Map<string, unknown>();
  for (const raw of userIds) {
    const userId = uid(raw);
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
      statsPollFn: (pc) => Promise.resolve(statsByOwner.get((pc as MockPeerConnection).ownerTag)),
      ...(capKbps !== undefined ? { capRelayedVideoKbps: capKbps } : {}),
      onError: (peer, context) => {
        errors.push({ user: userId, peer, context });
      },
    });
    managers.set(userId, manager);
  }
  return {
    clock,
    net,
    managers,
    errors,
    setStats: (ownerTag, stats) => statsByOwner.set(ownerTag, stats),
    clearStats: (ownerTag) => statsByOwner.delete(ownerTag),
  };
}

async function connectPair(world: CapWorld, a: string, b: string): Promise<void> {
  world.managers.get(uid(a))!.syncPeers([uid(b)]);
  world.managers.get(uid(b))!.syncPeers([uid(a)]);
  await world.clock.advance(300);
}

const track = (id: string, kind: 'audio' | 'video'): MediaStreamTrackLike => ({
  id,
  kind,
  enabled: true,
});

/** The live MockRtpSender publishing trackId for the pcs owned by ownerTag. */
function senderFor(net: MockNetwork, ownerTag: string, trackId: string): MockRtpSender {
  const anyNet = net as unknown as { pcs: Map<number, MockPeerConnection> };
  for (const pc of anyNet.pcs.values()) {
    if (pc.ownerTag !== ownerTag || pc.connectionState === 'closed') continue;
    for (const sender of pc.senders) {
      if (sender.track?.id === trackId) return sender;
    }
  }
  throw new Error(`no live sender for ${ownerTag}/${trackId}`);
}

function maxBitrateOf(parameters: RtpParametersLike): number | undefined {
  return parameters.encodings[0]?.maxBitrate;
}

describe('MeshManager link state and relay share cap', () => {
  it('reports link state changes once (not every poll) and caps only the share sender', async () => {
    const world = makeCapWorld(['alice', 'bob'], 400);
    const alice = world.managers.get(uid('alice'))!;
    await connectPair(world, 'alice', 'bob');

    const events: Array<{ peer: UserId; state: string }> = [];
    alice.onLinkState((peer, state) => {
      events.push({ peer, state });
    });
    alice.setLocalTrack('mic', track('mic-1', 'audio'));
    alice.setLocalTrack('cam', track('cam-1', 'video'));
    alice.setLocalTrack('share', track('share-1', 'video'));
    await world.clock.advance(50);

    // No poll has landed: the link is unclassified and the share is uncapped.
    expect(alice.linkState(uid('bob'))).toBe('unknown');
    const share = senderFor(world.net, 'alice', 'share-1');
    expect(share.appliedParameters).toHaveLength(0);

    world.setStats('alice', transportStats('host', 'relay'));
    await alice.pollStats();
    expect(events).toEqual([{ peer: uid('bob'), state: 'relayed' }]);
    expect(alice.linkState(uid('bob'))).toBe('relayed');
    expect(alice.linkStates().get(uid('bob'))).toBe('relayed');
    expect(maxBitrateOf(share.getParameters())).toBe(400_000);
    expect(share.appliedParameters).toHaveLength(1);

    // Same classification again: no new event, no re-apply.
    await alice.pollStats();
    expect(events).toHaveLength(1);
    expect(share.appliedParameters).toHaveLength(1);

    // Voice and cam are never touched by the relay cap.
    expect(senderFor(world.net, 'alice', 'mic-1').appliedParameters).toHaveLength(0);
    expect(senderFor(world.net, 'alice', 'cam-1').appliedParameters).toHaveLength(0);
    expect(world.errors).toEqual([]);
  });

  it('removes the cap when an ICE restart lands the link on a direct path', async () => {
    const world = makeCapWorld(['alice', 'bob'], 400);
    const alice = world.managers.get(uid('alice'))!;
    await connectPair(world, 'alice', 'bob');
    alice.setLocalTrack('share', track('share-1', 'video'));
    await world.clock.advance(50);

    world.setStats('alice', transportStats('relay', 'host'));
    await alice.pollStats();
    const share = senderFor(world.net, 'alice', 'share-1');
    expect(maxBitrateOf(share.getParameters())).toBe(400_000);

    const events: Array<{ peer: UserId; state: string }> = [];
    alice.onLinkState((peer, state) => {
      events.push({ peer, state });
    });
    world.setStats('alice', transportStats('host', 'srflx'));
    await alice.pollStats();
    expect(events).toEqual([{ peer: uid('bob'), state: 'direct' }]);
    expect(maxBitrateOf(share.getParameters())).toBeUndefined();
    expect(share.appliedParameters).toHaveLength(2);
    expect(world.errors).toEqual([]);
  });

  it('preflight: a share started on a known-relayed voice link is capped immediately', async () => {
    const world = makeCapWorld(['alice', 'bob'], 400);
    const alice = world.managers.get(uid('alice'))!;
    await connectPair(world, 'alice', 'bob');
    alice.setLocalTrack('mic', track('mic-1', 'audio'));
    await world.clock.advance(50);

    // Voice-only link, already classified from routine polling (older shape).
    world.setStats('alice', selectedPairStats('relay', 'host'));
    await alice.pollStats();
    expect(alice.linkState(uid('bob'))).toBe('relayed');

    // Mode B start: the answer preceded the track, so the cap does too.
    alice.setLocalTrack('share', track('share-1', 'video'));
    const share = senderFor(world.net, 'alice', 'share-1');
    await world.clock.advance(1);
    expect(maxBitrateOf(share.getParameters())).toBe(400_000);
    expect(senderFor(world.net, 'alice', 'mic-1').appliedParameters).toHaveLength(0);
    expect(world.errors).toEqual([]);
  });

  it('survives a setParameters rejection without killing the share', async () => {
    const world = makeCapWorld(['alice', 'bob'], 400);
    const alice = world.managers.get(uid('alice'))!;
    await connectPair(world, 'alice', 'bob');
    alice.setLocalTrack('share', track('share-1', 'video'));
    await world.clock.advance(50);

    const share = senderFor(world.net, 'alice', 'share-1');
    let attempts = 0;
    share.setParameters = () => {
      attempts += 1;
      return Promise.reject(new Error('InvalidModificationError'));
    };

    world.setStats('alice', transportStats('relay', 'host'));
    await alice.pollStats();
    await world.clock.advance(10);

    expect(attempts).toBe(1);
    expect(world.errors).toContainEqual({ user: uid('alice'), peer: uid('bob'), context: 'shareCap' });
    // The share keeps publishing and the state sticks; no retry storm.
    expect(share.track?.id).toBe('share-1');
    expect(alice.linkState(uid('bob'))).toBe('relayed');
    await alice.pollStats();
    expect(attempts).toBe(1);
  });

  it('demotes a known state to unknown only after two silent polls, keeping the cap', async () => {
    const world = makeCapWorld(['alice', 'bob'], 400);
    const alice = world.managers.get(uid('alice'))!;
    await connectPair(world, 'alice', 'bob');
    alice.setLocalTrack('share', track('share-1', 'video'));
    await world.clock.advance(50);

    const events: Array<{ peer: UserId; state: string }> = [];
    alice.onLinkState((peer, state) => {
      events.push({ peer, state });
    });
    world.setStats('alice', transportStats('relay', 'host'));
    await alice.pollStats();
    expect(events).toEqual([{ peer: uid('bob'), state: 'relayed' }]);

    // One stats gap (mid ICE restart): the reported state must not flap.
    world.clearStats('alice');
    await alice.pollStats();
    expect(alice.linkState(uid('bob'))).toBe('relayed');
    expect(events).toHaveLength(1);

    // The pair comes back relayed: the gap leaves no trace.
    world.setStats('alice', transportStats('relay', 'host'));
    await alice.pollStats();
    expect(events).toHaveLength(1);

    // Two consecutive gaps: honesty wins, but the cap stays (cost-safe).
    world.clearStats('alice');
    await alice.pollStats();
    await alice.pollStats();
    expect(events).toEqual([
      { peer: uid('bob'), state: 'relayed' },
      { peer: uid('bob'), state: 'unknown' },
    ]);
    const share = senderFor(world.net, 'alice', 'share-1');
    expect(maxBitrateOf(share.getParameters())).toBe(400_000);
    expect(world.errors).toEqual([]);
  });

  it('reports link state without a cap option and never touches senders', async () => {
    const world = makeCapWorld(['alice', 'bob']);
    const alice = world.managers.get(uid('alice'))!;
    await connectPair(world, 'alice', 'bob');
    alice.setLocalTrack('share', track('share-1', 'video'));
    await world.clock.advance(50);

    const events: Array<{ peer: UserId; state: string }> = [];
    alice.onLinkState((peer, state) => {
      events.push({ peer, state });
    });
    world.setStats('alice', transportStats('relay', 'host'));
    await alice.pollStats();
    expect(events).toEqual([{ peer: uid('bob'), state: 'relayed' }]);
    expect(senderFor(world.net, 'alice', 'share-1').appliedParameters).toHaveLength(0);
  });
});
