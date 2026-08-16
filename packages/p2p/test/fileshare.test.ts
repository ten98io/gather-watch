import { describe, expect, it } from 'vitest';
import type { UserId } from '@gather/contracts';
import { ChannelFabric } from '../src/channels';
import type { FileChannelMessage } from '../src/channels';
import { FileShareClient, FileShareServer } from '../src/fileshare';
import type { FileSource, HashFn } from '../src/fileshare';
import { MockNetwork, VirtualClock, mulberry32, uid } from './harness';
import type { LinkFaults } from './harness';

const CHUNK = 65_536;

/** Deterministic file content: bytes[i] = (i * 31 + 7) % 251. */
function makeBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) bytes[i] = (i * 31 + 7) % 251;
  return bytes;
}

function sourceOf(bytes: Uint8Array): FileSource {
  return {
    sizeBytes: bytes.length,
    read: (offset, length) => Promise.resolve(bytes.slice(offset, offset + length)),
  };
}

/** Cheap deterministic stand-in for a content hash. */
const checksum: HashFn = (data) => {
  let h = 0;
  for (const byte of data) h = (h * 31 + byte) >>> 0;
  return Promise.resolve(h.toString(16));
};

interface WireOptions {
  faults?: LinkFaults;
  seed?: number;
  serverWindowChunks?: number;
  clientWindowChunks?: number;
  requestTimeoutMs?: number;
  hash?: HashFn;
  onServerSend?: (msg: FileChannelMessage) => void;
  onClientSend?: (msg: FileChannelMessage) => void;
  onServerRecv?: (msg: FileChannelMessage) => void;
}

interface Wire {
  clock: VirtualClock;
  server: FileShareServer;
  client: FileShareClient;
}

/** Standard server↔client wiring over one harness channel pair. */
function wire(opts: WireOptions = {}): Wire {
  const clock = new VirtualClock();
  const net = new MockNetwork(clock, mulberry32(opts.seed ?? 1));
  const [dcServer, dcClient] = net.createChannelPair(opts.faults);
  const fabricS = new ChannelFabric();
  const fabricC = new ChannelFabric();
  fabricS.attach(uid('client'), 'file', dcServer);
  fabricC.attach(uid('owner'), 'file', dcClient);

  const server = new FileShareServer({
    send: (peerId, msg) => {
      opts.onServerSend?.(msg);
      return fabricS.send(peerId, 'file', msg);
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    ...(opts.serverWindowChunks !== undefined ? { windowChunks: opts.serverWindowChunks } : {}),
    ...(opts.hash !== undefined ? { hash: opts.hash } : {}),
  });
  fabricS.onMessage('file', (peer, msg) => {
    opts.onServerRecv?.(msg);
    server.handleMessage(peer, msg);
  });

  const client = new FileShareClient({
    send: (msg) => {
      opts.onClientSend?.(msg);
      return fabricC.send(uid('owner'), 'file', msg);
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    ...(opts.clientWindowChunks !== undefined ? { windowChunks: opts.clientWindowChunks } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    ...(opts.hash !== undefined ? { hash: opts.hash } : {}),
  });
  fabricC.onMessage('file', (_peer, msg) => client.handleMessage(msg));

  return { clock, server, client };
}

/** Advance virtual time until the download settles; assert it resolved. */
async function driveDownload(clock: VirtualClock, promise: Promise<Uint8Array>): Promise<Uint8Array> {
  const resolved: Uint8Array[] = [];
  const failures: unknown[] = [];
  void promise.then(
    (bytes) => {
      resolved.push(bytes);
    },
    (err) => {
      failures.push(err);
    },
  );
  for (let i = 0; i < 400 && resolved.length === 0 && failures.length === 0; i += 1) {
    await clock.advance(50);
  }
  expect(failures).toEqual([]);
  expect(resolved).toHaveLength(1);
  return resolved[0]!;
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  let mismatch = -1;
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) {
      mismatch = i;
      break;
    }
  }
  expect(mismatch).toBe(-1);
}

describe('FileShare', () => {
  it('1 MiB transfers correctly under 5% channel drop/stall', async () => {
    const bytes = makeBytes(1_048_576);
    let reqCount = 0;
    const { clock, server, client } = wire({
      faults: { dropRate: 0.05, delayMs: 5 },
      seed: 42,
      requestTimeoutMs: 300,
      onServerRecv: (msg) => {
        if (msg.t === 'file.req') reqCount += 1;
      },
    });
    server.register('f1', sourceOf(bytes));

    const done = await driveDownload(clock, client.download('f1', bytes.length));

    expectBytesEqual(done, bytes);
    // 16 chunks; drops force re-requests, so the server saw at least 16 reqs.
    expect(reqCount).toBeGreaterThanOrEqual(16);
  });

  it('seek-window prioritization', async () => {
    const bytes = makeBytes(16 * CHUNK);
    const reqOffsets: number[] = [];
    const { clock, server, client } = wire({
      clientWindowChunks: 4,
      onServerRecv: (msg) => {
        if (msg.t === 'file.req') reqOffsets.push(msg.offset);
      },
    });
    server.register('f1', sourceOf(bytes));

    const resolved: Uint8Array[] = [];
    void client.download('f1', bytes.length).then((b) => {
      resolved.push(b);
    });

    // Let exactly the first wave of 4 requests land (5ms channel delay);
    // their chunks are still in flight back to the client.
    await clock.advance(6);
    expect(reqOffsets).toEqual([0, CHUNK, 2 * CHUNK, 3 * CHUNK]);

    client.setPlayhead('f1', 10 * CHUNK);
    const afterMark = reqOffsets.length;

    for (let i = 0; i < 400 && resolved.length === 0; i += 1) await clock.advance(50);
    expect(resolved).toHaveLength(1);
    expectBytesEqual(resolved[0]!, bytes);

    // Requests issued after the playhead change: everything at or beyond the
    // playhead comes before anything behind it.
    const after = reqOffsets.slice(afterMark);
    expect(after.some((o) => o >= 10 * CHUNK)).toBe(true);
    expect(after.some((o) => o < 10 * CHUNK)).toBe(true);
    const firstBehind = after.findIndex((o) => o < 10 * CHUNK);
    expect(firstBehind).toBeGreaterThan(0);
    expect(after.slice(0, firstBehind).every((o) => o >= 10 * CHUNK)).toBe(true);
  });

  it('multi-consumer round-robin fairness', async () => {
    const clock = new VirtualClock();
    const net = new MockNetwork(clock, mulberry32(9));
    const bytes = makeBytes(512 * 1024);

    const chunkPeers: UserId[] = [];
    const fabricS = new ChannelFabric();
    const server = new FileShareServer({
      send: (peerId, msg) => {
        if (msg.t === 'file.chunk') chunkPeers.push(peerId);
        return fabricS.send(peerId, 'file', msg);
      },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    fabricS.onMessage('file', (peer, msg) => server.handleMessage(peer, msg));

    // Reads resolve after 10ms of virtual time so the pump takes real virtual
    // time per chunk — the two transfers genuinely overlap instead of the
    // first consumer draining before the second's requests arrive.
    server.register('f1', {
      sizeBytes: bytes.length,
      read: (offset, length) =>
        new Promise((resolve) => {
          clock.setTimeoutFn(() => resolve(bytes.slice(offset, offset + length)), 10);
        }),
    });

    const clients: FileShareClient[] = [];
    for (const name of ['c1', 'c2']) {
      const [dcServer, dcClient] = net.createChannelPair();
      fabricS.attach(uid(name), 'file', dcServer);
      const fabricC = new ChannelFabric();
      fabricC.attach(uid('owner'), 'file', dcClient);
      const client = new FileShareClient({
        send: (msg) => fabricC.send(uid('owner'), 'file', msg),
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
      });
      fabricC.onMessage('file', (_peer, msg) => client.handleMessage(msg));
      clients.push(client);
    }

    const resolved1: Uint8Array[] = [];
    const resolved2: Uint8Array[] = [];
    void clients[0]!.download('f1', bytes.length).then((b) => {
      resolved1.push(b);
    });
    void clients[1]!.download('f1', bytes.length).then((b) => {
      resolved2.push(b);
    });
    for (let i = 0; i < 400 && (resolved1.length === 0 || resolved2.length === 0); i += 1) {
      await clock.advance(50);
    }

    expect(resolved1).toHaveLength(1);
    expect(resolved2).toHaveLength(1);
    expectBytesEqual(resolved1[0]!, bytes);
    expectBytesEqual(resolved2[0]!, bytes);

    // 8 chunks to each consumer.
    expect(chunkPeers.filter((p) => p === uid('c1'))).toHaveLength(8);
    expect(chunkPeers.filter((p) => p === uid('c2'))).toHaveLength(8);

    // Genuine overlap: c2's first chunk is sent before c1's last chunk.
    const firstC2 = chunkPeers.indexOf(uid('c2'));
    const lastC1 = chunkPeers.lastIndexOf(uid('c1'));
    expect(firstC2).toBeGreaterThanOrEqual(0);
    expect(firstC2).toBeLessThan(lastC1);

    // No run of 3+ consecutive chunks to one consumer.
    let run = 1;
    for (let i = 1; i < chunkPeers.length; i += 1) {
      run = chunkPeers[i] === chunkPeers[i - 1] ? run + 1 : 1;
      expect(run).toBeLessThan(3);
    }
  });

  it('credit window respected', async () => {
    const bytes = makeBytes(512 * 1024);
    let chunksSent = 0;
    let creditsGranted = 0;
    let maxInflight = 0;
    const track = (): void => {
      const inflight = chunksSent - creditsGranted;
      if (inflight > maxInflight) maxInflight = inflight;
    };
    const { clock, server, client } = wire({
      serverWindowChunks: 4,
      clientWindowChunks: 4,
      onServerSend: (msg) => {
        if (msg.t === 'file.chunk') {
          chunksSent += 1;
          track();
        }
      },
      onClientSend: (msg) => {
        if (msg.t === 'file.credit') {
          creditsGranted += msg.credits;
          track();
        }
      },
    });
    server.register('f1', sourceOf(bytes));

    const done = await driveDownload(clock, client.download('f1', bytes.length));

    expectBytesEqual(done, bytes);
    expect(chunksSent).toBe(8);
    expect(maxInflight).toBeLessThanOrEqual(4);
    expect(maxInflight).toBe(4); // the window really was exercised
  });

  it('corrupted chunk is re-requested (integrity)', async () => {
    const bytes = makeBytes(4 * CHUNK);
    let corrupted = false;
    const reqOffsets: number[] = [];
    const { clock, server, client } = wire({
      hash: checksum,
      onServerSend: (msg) => {
        if (msg.t === 'file.chunk' && msg.offset === CHUNK && !corrupted) {
          corrupted = true;
          msg.dataB64 = (msg.dataB64.startsWith('A') ? 'B' : 'A') + msg.dataB64.slice(1);
        }
      },
      onServerRecv: (msg) => {
        if (msg.t === 'file.req') reqOffsets.push(msg.offset);
      },
    });
    server.register('f1', sourceOf(bytes));

    const done = await driveDownload(clock, client.download('f1', bytes.length));

    expect(corrupted).toBe(true);
    expectBytesEqual(done, bytes);
    expect(reqOffsets.filter((o) => o === CHUNK).length).toBeGreaterThanOrEqual(2);
  });

  it('unknown fileId rejects with NOT_FOUND', async () => {
    const { clock, server, client } = wire();
    server.register('f1', sourceOf(makeBytes(CHUNK)));

    let failure: unknown = null;
    void client.download('nope', CHUNK).catch((err) => {
      failure = err;
    });
    for (let i = 0; i < 40 && failure === null; i += 1) await clock.advance(50);

    expect(failure).not.toBeNull();
    expect((failure as Error).message).toContain('NOT_FOUND');
  });
});
