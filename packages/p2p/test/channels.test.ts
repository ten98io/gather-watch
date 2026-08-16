import { describe, expect, it } from 'vitest';
import type { UserId } from '@gather/contracts';
import { ChannelFabric } from '../src/channels';
import type { EmoteChannelMessage, FileChannelMessage, SyncBeacon } from '../src/channels';
import { MockNetwork, VirtualClock, uid } from './harness';

const BEACON: SyncBeacon = {
  t: 'beacon',
  positionMs: 1234,
  rate: 1,
  playing: true,
  masterTs: 1_000_000,
  epoch: 7,
};
const FILE_REQ: FileChannelMessage = { t: 'file.req', fileId: 'f1', offset: 65_536, length: 65_536 };
const EMOTE: EmoteChannelMessage = { t: 'emote', emoji: '🎉', xPct: 25, yPct: 75 };

describe('ChannelFabric', () => {
  it('typed roundtrip per label', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock);
    const fabricA = new ChannelFabric();
    const fabricB = new ChannelFabric();
    const [dcSyncA, dcSyncB] = net.createChannelPair();
    const [dcFileA, dcFileB] = net.createChannelPair();
    const [dcEmoteA, dcEmoteB] = net.createChannelPair();
    fabricA.attach(uid('b'), 'sync', dcSyncA);
    fabricA.attach(uid('b'), 'file', dcFileA);
    fabricA.attach(uid('b'), 'emote', dcEmoteA);
    fabricB.attach(uid('a'), 'sync', dcSyncB);
    fabricB.attach(uid('a'), 'file', dcFileB);
    fabricB.attach(uid('a'), 'emote', dcEmoteB);

    const got: Array<{ label: string; peer: UserId; msg: unknown }> = [];
    fabricB.onMessage('sync', (peer, msg) => got.push({ label: 'sync', peer, msg }));
    fabricB.onMessage('file', (peer, msg) => got.push({ label: 'file', peer, msg }));
    fabricB.onMessage('emote', (peer, msg) => got.push({ label: 'emote', peer, msg }));

    expect(fabricA.send(uid('b'), 'sync', BEACON)).toBe(true);
    expect(fabricA.send(uid('b'), 'file', FILE_REQ)).toBe(true);
    expect(fabricA.send(uid('b'), 'emote', EMOTE)).toBe(true);

    await clock.advance(20);
    expect(got).toHaveLength(3);
    expect(got).toContainEqual({ label: 'sync', peer: uid('a'), msg: BEACON });
    expect(got).toContainEqual({ label: 'file', peer: uid('a'), msg: FILE_REQ });
    expect(got).toContainEqual({ label: 'emote', peer: uid('a'), msg: EMOTE });
  });

  it('malformed inbound frames dropped silently', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock);
    const fabricA = new ChannelFabric();
    const [dcA, dcB] = net.createChannelPair();
    fabricA.attach(uid('b'), 'sync', dcA);

    const got: unknown[] = [];
    fabricA.onMessage('sync', (_peer, msg) => got.push(msg));

    dcB.send('not json');
    dcB.send('42');
    dcB.send('{"noT":true}');
    await clock.advance(20);
    expect(got).toHaveLength(0);
  });

  it('backpressure + whenDrained', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock);
    const fabricA = new ChannelFabric({ maxBufferedBytes: 64 });
    const [dcA] = net.createChannelPair();
    fabricA.attach(uid('b'), 'sync', dcA);

    // One JSON beacon frame is already over 64 bytes once buffered.
    expect(fabricA.send(uid('b'), 'sync', BEACON)).toBe(true);
    expect(fabricA.send(uid('b'), 'sync', BEACON)).toBe(false);

    // Over the limit: whenDrained stays pending until the harness drains.
    let drained = false;
    void fabricA.whenDrained(uid('b'), 'sync').then(() => {
      drained = true;
    });
    await clock.flush();
    expect(drained).toBe(false);

    await clock.advance(5); // buffered bytes drain on the 1ms timer
    expect(drained).toBe(true);
    expect(fabricA.send(uid('b'), 'sync', BEACON)).toBe(true);
  });

  it('broadcast returns reached peers only', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock);
    const fabricA = new ChannelFabric();
    const [dcA1, dcB1] = net.createChannelPair();
    const [dcA2, dcB2] = net.createChannelPair();
    fabricA.attach(uid('p1'), 'sync', dcA1);
    fabricA.attach(uid('p2'), 'sync', dcA2);

    let received1 = 0;
    let received2 = 0;
    dcB1.onmessage = () => {
      received1 += 1;
    };
    dcB2.onmessage = () => {
      received2 += 1;
    };

    dcA2.close();
    const reached = fabricA.broadcast('sync', BEACON);
    expect(reached).toEqual([uid('p1')]);

    await clock.advance(20);
    expect(received1).toBe(1);
    expect(received2).toBe(0);
  });

  it('detachPeer closes both ends', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock);
    const fabricA = new ChannelFabric();
    const [dcA, dcB] = net.createChannelPair();
    fabricA.attach(uid('b'), 'sync', dcA);
    expect(fabricA.isOpen(uid('b'), 'sync')).toBe(true);

    let closeSeen = false;
    dcB.onclose = () => {
      closeSeen = true;
    };

    fabricA.detachPeer(uid('b'));
    expect(fabricA.isOpen(uid('b'), 'sync')).toBe(false);
    expect(fabricA.send(uid('b'), 'sync', BEACON)).toBe(false);

    await clock.advance(5);
    expect(closeSeen).toBe(true);
    expect(dcB.readyState).toBe('closed');
  });
});
