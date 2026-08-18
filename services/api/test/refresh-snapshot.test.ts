/**
 * Refreshing a room page must give the room back — and must not evict anyone.
 *
 * The owner's most-reported bug: "when the host refreshed, the guests got
 * kicked silently but the host doesn't know that, and then when the guest
 * joined the queue came back". Both halves are here.
 *
 * A refresh is NOT a leave. Nothing evicts the refreshing client: the presence
 * entry outlives a 1-5s reload (15s disconnect grace, 45s TTL), so the server
 * sees an ordinary heartbeat, `created` is false, and the old gate replied
 * with NOTHING. The reloaded tab then kept its initial state forever — empty
 * queue, null playback, EMPTY roster — and an empty roster is what makes the
 * web client tear down every call peer, i.e. the guests really do disappear.
 * "When the guest joined the queue came back" was the tell: a genuinely new
 * entry made `created` true and the same snapshot finally arrived.
 *
 * The fix is an explicit `wantSnapshot` on presence.update. It has to be
 * explicit: a bare/empty heartbeat cannot be told apart from a no-op keepalive
 * beat, which is the exact ambiguity that caused this.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { MediaRef, QueueItem, QueueItemId, RoomId, ServerEvent, UserId } from '@gather/contracts';
import type { Deps } from '../src/modules/types';
import type { StorePort } from '../src/adapters/ports';
import { roomChannel } from '../src/adapters/ports';
import type { RoomBusMessage } from '../src/adapters/ports';
import { getRoomsRuntime } from '../src/modules/rooms/runtime';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';
import type { SignedUpUser } from './helpers';

const YT: MediaRef = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' };

interface Frame {
  type: string;
  roomId: string;
  seq: number;
  ts: number;
  payload: Record<string, unknown>;
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    const cleanup = (): void => {
      sock.off('open', onOpen);
      sock.off('close', onClose);
      sock.off('error', onError);
    };
    const onOpen = (): void => {
      cleanup();
      resolve(sock);
    };
    const onClose = (code: number): void => {
      cleanup();
      reject(new Error(`socket closed before open (code ${code})`));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    sock.once('open', onOpen);
    sock.once('close', onClose);
    sock.once('error', onError);
  });
}

/** Resolves with everything the socket says in `windowMs`. */
function collectFor(sock: WebSocket, windowMs: number): Promise<Frame[]> {
  return new Promise((resolve) => {
    const seen: Frame[] = [];
    const onMessage = (data: RawData): void => {
      seen.push(JSON.parse(data.toString()) as Frame);
    };
    sock.on('message', onMessage);
    setTimeout(() => {
      sock.off('message', onMessage);
      resolve(seen);
    }, windowMs);
  });
}

function clientFrame(roomId: string, type: string, payload: unknown): string {
  return JSON.stringify({ type, roomId, seq: 0, ts: Date.now(), payload });
}

/** MemoryBus fans out on queueMicrotask and emitEphemeral does not await the
 *  publish, so give both a real turn before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function queueItemFor(id: string, title: string): QueueItem {
  return {
    id: id as QueueItemId,
    mediaRef: YT,
    title,
    durationMs: 212_000,
    artworkUrl: null,
    addedBy: 'seed-user' as UserId,
    votesToSkip: [],
  };
}

describe('a refresh gets the room back', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let port: number;
  let sockets: WebSocket[];

  beforeEach(async () => {
    ({ app, store } = await makeApp());
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    sockets = [];
  });

  afterEach(async () => {
    for (const sock of sockets) {
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        sock.close();
      }
    }
    await app.close();
  });

  async function connect(roomId: string, token: string): Promise<WebSocket> {
    const sock = await openSocket(`ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${token}`);
    sockets.push(sock);
    return sock;
  }

  /** A room mid-session: two items queued and the first one playing. */
  async function seedLiveRoom(): Promise<{ roomId: RoomId; host: SignedUpUser }> {
    const { roomId } = await seedRoom(store);
    const host = await signupUser(app, `refresh-${Date.now()}@example.com`);
    await addMember(store, roomId, host.user.id, 'host');
    await store.rooms.updateOne(
      { id: roomId },
      {
        queue: {
          items: [queueItemFor('qi-1', 'First up'), queueItemFor('qi-2', 'Then this')],
          version: 7,
        },
        playback: {
          mediaRef: YT,
          positionMs: 91_000,
          rate: 1,
          playing: true,
          serverTs: Date.now(),
          seq: 3,
          queueIndex: 0,
        },
      },
    );
    return { roomId, host };
  }

  it('a fast refresh replies the roster, the playback position and the queue', async () => {
    const { roomId, host } = await seedLiveRoom();

    // The original tab: a first heartbeat CREATES the entry, so this one gets
    // its snapshot from the `created` branch — the path that always worked.
    const first = await connect(roomId, host.accessToken);
    const joined = collectFor(first, 150);
    first.send(clientFrame(roomId, 'presence.update', { state: 'watching' }));
    expect((await joined).map((f) => f.type)).toContain('presence.state');

    // …and then the user hits reload. The entry survives (grace 15s, TTL 45s),
    // so nothing about the room changes — this is the whole bug.
    first.close();
    await flush();

    const reloaded = await connect(roomId, host.accessToken);
    const afterReload = collectFor(reloaded, 250);
    reloaded.send(
      clientFrame(roomId, 'presence.update', { state: 'watching', wantSnapshot: true }),
    );
    const frames = await afterReload;
    const types = frames.map((f) => f.type);

    expect(types).toContain('presence.state');
    expect(types).toContain('sync.state');
    expect(types).toContain('queue.state');

    // Not just present — carrying the room as it actually stands.
    const roster = frames.find((f) => f.type === 'presence.state');
    const entries = roster?.payload.entries as Array<{ userId: string }> | undefined;
    expect(entries?.map((e) => e.userId)).toContain(host.user.id);

    const playback = frames.find((f) => f.type === 'sync.state');
    expect(playback?.payload.positionMs).toBe(91_000);
    expect(playback?.payload.playing).toBe(true);

    const queue = frames.find((f) => f.type === 'queue.state');
    expect((queue?.payload.items as QueueItem[]).map((i) => i.title)).toEqual([
      'First up',
      'Then this',
    ]);
    expect(queue?.payload.version).toBe(7);
  });

  it('replies a share that STOPPED, so a reconnect leaves the dead stage', async () => {
    const { roomId, host } = await seedLiveRoom();
    // The share ended while this client was away. The stop broadcast is a
    // seq'd event, but replay is ascending-from-`since` and capped — the very
    // reason this snapshot exists — so it cannot be the thing relied on to
    // take the stage down. Only sending restream when `active` left a
    // reconnecting client watching a share that is no longer running.
    await store.rooms.updateOne(
      { id: roomId },
      {
        restream: {
          active: false,
          hostUserId: null,
          startedAt: null,
          viewerCount: 0,
          uplinkQuality: null,
        },
      },
    );

    const sock = await connect(roomId, host.accessToken);
    const frames = collectFor(sock, 250);
    sock.send(clientFrame(roomId, 'presence.update', { state: 'watching', wantSnapshot: true }));

    const restream = (await frames).find((f) => f.type === 'restream.state');
    expect(restream).toBeDefined();
    expect(restream?.payload.active).toBe(false);
  });

  it('an ordinary keepalive beat gets nothing back — the flag is what asks', async () => {
    const { roomId, host } = await seedLiveRoom();

    const first = await connect(roomId, host.accessToken);
    const joined = collectFor(first, 150);
    first.send(clientFrame(roomId, 'presence.update', { state: 'watching' }));
    await joined;
    first.close();
    await flush();

    // Same frame as the refresh above, minus the flag. Nothing comes back —
    // which is why the reloaded tab used to sit on an empty room, and why
    // paying for a full snapshot on every 15s beat is not the alternative.
    const reloaded = await connect(roomId, host.accessToken);
    const afterReload = collectFor(reloaded, 250);
    reloaded.send(clientFrame(roomId, 'presence.update', { state: 'watching' }));
    expect(await afterReload).toEqual([]);
  });
});

describe('closing a socket evicts nobody', () => {
  let app: FastifyInstance;
  let deps: Deps;
  let store: StorePort;
  let port: number;
  let sockets: WebSocket[];

  beforeEach(async () => {
    ({ app, deps, store } = await makeApp());
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    sockets = [];
  });

  afterEach(async () => {
    for (const sock of sockets) {
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        sock.close();
      }
    }
    await app.close();
  });

  async function connect(roomId: string, token: string): Promise<WebSocket> {
    const sock = await openSocket(`ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${token}`);
    sockets.push(sock);
    return sock;
  }

  it('a member whose socket went away keeps their seat: no member.removed, no 4403', async () => {
    const { roomId } = await seedRoom(store);
    const host = await signupUser(app, `stay-host-${Date.now()}@example.com`);
    await addMember(store, roomId, host.user.id, 'host');
    const guest = await signupUser(app, `stay-guest-${Date.now()}@example.com`);
    await addMember(store, roomId, guest.user.id, 'member');

    // Everything broadcast to the room, in arrival order.
    const events: ServerEvent[] = [];
    const stopWatching = await deps.bus.subscribe(roomChannel(roomId), (raw) => {
      events.push((raw as RoomBusMessage).event as ServerEvent);
    });

    const hostSock = await connect(roomId, host.accessToken);
    const guestSock = await connect(roomId, guest.accessToken);
    hostSock.send(clientFrame(roomId, 'presence.update', { state: 'watching' }));
    guestSock.send(clientFrame(roomId, 'presence.update', { state: 'watching' }));
    await flush();

    let hostClosedWith: number | null = null;
    hostSock.on('close', (code: number) => {
      hostClosedWith = code;
    });

    // The guest reloads: their socket goes away for longer than the grace.
    guestSock.close();
    await flush();
    const { presence } = getRoomsRuntime(deps);
    const base = Date.now();
    await presence.sweep(base + 1_000); // notices the socket is gone
    await presence.sweep(base + 20_000); // …and the 15s grace has elapsed
    await flush();

    // Presence expiry is not membership removal. The row, and therefore the
    // People list and every permission that keys off it, is untouched.
    expect(events.filter((ev) => ev.type === 'member.removed')).toEqual([]);
    expect(await store.members.findOne({ roomId, userId: guest.user.id })).not.toBeNull();

    // Nobody else was disconnected either — the host is still sitting there.
    expect(hostClosedWith).toBeNull();
    expect(hostSock.readyState).toBe(WebSocket.OPEN);

    // And the guest can walk straight back in: still a member, no 4403.
    const rejoined = await connect(roomId, guest.accessToken);
    expect(rejoined.readyState).toBe(WebSocket.OPEN);

    await stopWatching();
  });
});
