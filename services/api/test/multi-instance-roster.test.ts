/**
 * AN INSTANCE THAT HAS JUST PICKED A ROOM UP KNOWS NOTHING ABOUT IT, AND USED
 * TO ACT AS IF THAT WERE THE ROOM.
 *
 * Presence subscribes a room's control-plane channel on the first LOCAL
 * activity for that room, and before the roster handshake existed there was no
 * reconciliation behind it: the instance heard nothing until somebody else's
 * client happened to beat. Its answer to "who is in this room" was therefore
 * "whoever I own a socket for" — one person, in a room full of them — and
 * three separate things read that answer as the room:
 *
 *   • the JOINER got a roster of one and it never repaired, so they sat alone
 *     in a room full of people until the next heartbeat happened to arrive;
 *   • `sync.advance` concluded that nobody holding playbackControl was
 *     present and waived its clock check, so every advance landed — a queue
 *     walked from the first row to the last in three frames, re-armable at
 *     will by reconnecting until you land on a cold instance;
 *   • a skip vote divided by a denominator of one, so ONE member carried
 *     everybody's track off.
 *
 * And the mirror image, from the other side of the same reconnect: the
 * instance a member LEFT still held their entry as local, so its disconnect
 * grace expired, `removeUser` broadcast a room-wide removal and fired
 * `onDeparture` — evicting a perfectly well connected member from everyone's
 * roster and force-stopping their screen share.
 *
 * These tests build TWO apps over ONE store and ONE bus — the deploy, in a
 * test. Every one of them passes trivially against a single instance, which is
 * exactly why they are written this way.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { PlaybackState, QueueItem, QueueItemId, RoomId, UserId } from '@gather/contracts';
import { buildApp } from '../src/app';
import { MemoryBus } from '../src/adapters/memory-bus';
import { MemoryStore } from '../src/adapters/memory-store';
import type { Deps } from '../src/modules/types';
import { getRoomsRuntime } from '../src/modules/rooms/runtime';
import { newId } from '../src/lib/tokens';
import { addMember, seedRoom, signupUser, testConfig } from './helpers';

interface Frame {
  type: string;
  roomId: string;
  seq: number;
  ts: number;
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const GRACE_MS = 50;
/** A ten-minute film: "just started" and "nearly over" cannot be confused. */
const FILM_MS = 10 * 60 * 1000;
const MEDIA_REF = { kind: 'page', url: 'https://example.com/watch/1' } as const;

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.once('open', () => resolve(sock));
    sock.once('error', (err: Error) => reject(err));
  });
}

/** Everything the socket receives from now on — the only way to assert that
 *  something did NOT arrive. */
function collect(sock: WebSocket): Frame[] {
  const frames: Frame[] = [];
  sock.on('message', (data: RawData) => {
    frames.push(JSON.parse(data.toString()) as Frame);
  });
  return frames;
}

function nextOfType(sock: WebSocket, type: string, timeoutMs = 2000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off('message', onMessage);
    };
    const onMessage = (data: RawData): void => {
      const frame = JSON.parse(data.toString()) as Frame;
      if (frame.type !== type) return;
      cleanup();
      resolve(frame);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for a "${type}" message`));
    }, timeoutMs);
    sock.on('message', onMessage);
  });
}

function clientFrame(roomId: string, type: string, payload: unknown): string {
  return JSON.stringify({ type, roomId, seq: 0, ts: Date.now(), payload });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedItem(addedBy: string, title: string, durationMs: number | null): QueueItem {
  return {
    id: newId() as QueueItemId,
    mediaRef: MEDIA_REF,
    title,
    durationMs,
    artworkUrl: null,
    addedBy: addedBy as UserId,
    votesToSkip: [],
  };
}

/**
 * A bus that can swallow the roster REQUEST and nothing else.
 *
 * The handshake is the repair, but it rides an AT-MOST-ONCE bus: Redis pub/sub
 * drops the message on a reconnect, a failover, or a subscriber that was not
 * listening yet, and nothing retries it. So the request going missing is not a
 * hypothetical — it is the ordinary bad day, and on it the cold instance is
 * back to a roster of one. What must not happen then is the two things a
 * roster of one used to authorise.
 */
class LossyCtlBus extends MemoryBus {
  dropRosterSync = false;

  override async publish(channel: string, message: unknown): Promise<void> {
    if (this.dropRosterSync && (message as { kind?: string }).kind === 'sync') return;
    return super.publish(channel, message);
  }
}

describe('an instance that has not mirrored the room yet', () => {
  let store: MemoryStore;
  let bus: LossyCtlBus;
  /** [instance 1, instance 2] — one store, one bus, two processes' worth. */
  let apps: FastifyInstance[];
  let deps: Deps[];
  let ports: number[];
  let sockets: WebSocket[];

  beforeEach(async () => {
    store = new MemoryStore();
    bus = new LossyCtlBus();
    apps = [];
    deps = [];
    ports = [];
    sockets = [];
    for (let i = 0; i < 2; i += 1) {
      const built = await buildApp({ config: testConfig(), store, bus });
      await built.app.listen({ port: 0, host: '127.0.0.1' });
      apps.push(built.app);
      deps.push(built.deps);
      ports.push((built.app.server.address() as AddressInfo).port);
      // Sweeps are driven by hand below; the interval must not race them.
      getRoomsRuntime(built.deps).presence.configure({
        ttlMs: 60_000,
        sweepMs: 600_000,
        disconnectGraceMs: GRACE_MS,
      });
    }
  });

  afterEach(async () => {
    for (const sock of sockets) {
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        sock.close();
      }
    }
    for (const d of deps) {
      await getRoomsRuntime(d).close();
    }
    for (const app of apps) {
      await app.close();
    }
  });

  interface Joined {
    userId: UserId;
    accessToken: string;
    sock: WebSocket;
  }

  /** Open a room socket for an existing account on instance `at`. No beat —
   *  the tests decide when (and whether) presence is told anything. */
  async function connect(
    roomId: string,
    at: number,
    account: { userId: UserId; accessToken: string },
  ): Promise<Joined> {
    const sock = await openSocket(
      `ws://127.0.0.1:${String(ports[at])}/ws?roomId=${roomId}&token=${account.accessToken}`,
    );
    sockets.push(sock);
    return { ...account, sock };
  }

  /** Sign up on instance `at`, join the room, open a socket there. */
  async function join(
    email: string,
    roomId: string,
    at: number,
    role: 'host' | 'moderator' | 'member' = 'member',
  ): Promise<Joined> {
    const account = await signupUser(apps[at]!, email);
    await addMember(store, roomId, account.user.id, role);
    return connect(roomId, at, {
      userId: account.user.id,
      accessToken: account.accessToken,
    });
  }

  /** Heartbeat and wait for the roster reply, so the entry definitely exists. */
  async function beat(member: Joined, roomId: string): Promise<Frame> {
    const roster = nextOfType(member.sock, 'presence.state');
    member.sock.send(
      clientFrame(roomId, 'presence.update', { state: 'watching', wantSnapshot: true }),
    );
    return roster;
  }

  function presentOn(instance: number, roomId: string): string[] {
    return getRoomsRuntime(deps[instance]!).presence.presentUserIds(roomId as RoomId);
  }

  /** Put the room on a queue row at a given point in the media. */
  async function playAt(roomId: RoomId, items: QueueItem[], index: number, positionMs: number) {
    const playback: PlaybackState = {
      mediaRef: items[index]!.mediaRef,
      positionMs,
      rate: 1,
      playing: true,
      serverTs: Date.now(),
      seq: await store.nextSeq(`playback:${roomId}`),
      queueIndex: index,
    };
    await store.rooms.updateOne({ id: roomId }, { playback });
  }

  const playbackOf = async (roomId: string): Promise<PlaybackState> =>
    (await store.rooms.findById(roomId))!.playback!;

  // ── the roster repairs, and it repairs on screen ──────────────────────────

  it('gives a joiner the WHOLE room, not just themselves', async () => {
    const { roomId } = await seedRoom(store);
    const a = await join('roster-a@example.com', roomId, 0);
    const b = await join('roster-b@example.com', roomId, 0);
    const c = await join('roster-c@example.com', roomId, 0);
    await beat(a, roomId);
    await beat(b, roomId);
    await beat(c, roomId);
    // Instance 1 has never seen this room: no ctl subscription, no entries.
    expect(presentOn(1, roomId)).toEqual([]);

    const late = await join('roster-late@example.com', roomId, 1);
    const frames = collect(late.sock);
    await beat(late, roomId);
    await sleep(50);

    // The tracker on the cold instance now holds all four, without anybody on
    // instance 0 having beaten again.
    expect(presentOn(1, roomId).sort()).toEqual(
      [a.userId, b.userId, c.userId, late.userId].sort(),
    );
    // And the joiner was TOLD. A roster that repairs only in the tracker is
    // still one person sitting alone in a room full of people: the answer has
    // to reach the client that asked, which is what the roster diff is for.
    const known = new Set<string>();
    for (const frame of frames) {
      if (frame.type === 'presence.state') {
        for (const entry of frame.payload.entries as Array<{ userId: string }>) {
          known.add(entry.userId);
        }
      }
      if (frame.type === 'presence.diff') {
        for (const entry of frame.payload.upserts as Array<{ userId: string }>) {
          known.add(entry.userId);
        }
      }
    }
    for (const userId of [a.userId, b.userId, c.userId, late.userId]) {
      expect([...known]).toContain(userId);
    }
  });

  // ── sync.advance must not be waived by a roster of one ────────────────────

  it('does not waive the advance clock check for a member alone on a cold instance', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('cold-host@example.com', roomId, 0, 'host');
    await beat(host, roomId);

    const items = [
      seedItem(host.userId, 'film one', FILM_MS),
      seedItem(host.userId, 'film two', FILM_MS),
      seedItem(host.userId, 'film three', FILM_MS),
      seedItem(host.userId, 'film four', FILM_MS),
    ];
    await store.rooms.updateOne({ id: roomId }, { queue: { items, version: 1 } });
    await playAt(roomId, items, 0, 5_000); // five seconds into a ten-minute film

    // A plain member lands on the instance that has never mirrored this room.
    const griefer = await join('cold-griefer@example.com', roomId, 1);
    await beat(griefer, roomId);

    // Three advances, each naming whatever row is current — the probe that
    // walked the room from index 0 to index 3 in about a second.
    for (let n = 0; n < 3; n += 1) {
      const at = (await playbackOf(roomId)).queueIndex;
      if (at === null) break;
      griefer.sock.send(
        clientFrame(roomId, 'sync.advance', { endedItemId: items[at]!.id }),
      );
      await sleep(60);
    }

    expect((await playbackOf(roomId)).queueIndex).toBe(0);
    // The host is present the whole time, on the OTHER instance — which is
    // exactly the fact the cold instance could not see.
    expect(presentOn(1, roomId)).toContain(host.userId);
  });

  it('still refuses the advance when the roster request is dropped', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('lossy-host@example.com', roomId, 0, 'host');
    await beat(host, roomId);

    const items = [
      seedItem(host.userId, 'film one', FILM_MS),
      seedItem(host.userId, 'film two', FILM_MS),
    ];
    await store.rooms.updateOne({ id: roomId }, { queue: { items, version: 1 } });
    await playAt(roomId, items, 0, 5_000);

    bus.dropRosterSync = true;
    const griefer = await join('lossy-griefer@example.com', roomId, 1);
    await beat(griefer, roomId);
    // Nobody answered, so this instance's view of the room really is one
    // person — precisely the state the handshake cannot rescue.
    expect(presentOn(1, roomId)).toEqual([griefer.userId]);

    griefer.sock.send(clientFrame(roomId, 'sync.advance', { endedItemId: items[0]!.id }));
    await sleep(300);
    expect((await playbackOf(roomId)).queueIndex).toBe(0);
  });

  // ── a skip quorum needs a room, not a process ─────────────────────────────

  it('does not let one vote on a cold instance carry the room’s track', async () => {
    const { roomId } = await seedRoom(store);
    const a = await join('vote-a@example.com', roomId, 0);
    const b = await join('vote-b@example.com', roomId, 0);
    const c = await join('vote-c@example.com', roomId, 0);
    await beat(a, roomId);
    await beat(b, roomId);
    await beat(c, roomId);

    const item = seedItem(a.userId, 'Current', null);
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [item], version: 1 } });

    // The voter's instance has never mirrored the room: before the roster
    // handshake its whole idea of "who is here" was this one person, so
    // skipVoteThreshold 0.5 needed exactly one vote.
    const voter = await join('vote-cold@example.com', roomId, 1);
    await beat(voter, roomId);

    // Both copies of the FIRST broadcast are claimed before it is provoked. A
    // queue.state goes to the whole room, so a listener attached to the voter's
    // socket after `recorded` resolves races the voter's own copy of that same
    // broadcast and reads it as the answer to the second vote — which is a
    // green test for a room whose track never got skipped.
    const recorded = nextOfType(a.sock, 'queue.state');
    const recordedOnVoter = nextOfType(voter.sock, 'queue.state');
    voter.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    const state = await recorded;
    await recordedOnVoter;
    expect(state.payload.items).toHaveLength(1);
    expect(state.payload.items[0].votesToSkip).toEqual([voter.userId]);

    // And the vote still WORKS: a second one reaches 2 of 4 and removes it.
    const removed = nextOfType(voter.sock, 'queue.state');
    a.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    expect((await removed).payload.items).toHaveLength(0);
  });

  it('still refuses the skip when the roster request is dropped', async () => {
    const { roomId } = await seedRoom(store);
    const a = await join('lossy-vote-a@example.com', roomId, 0);
    const b = await join('lossy-vote-b@example.com', roomId, 0);
    const c = await join('lossy-vote-c@example.com', roomId, 0);
    await beat(a, roomId);
    await beat(b, roomId);
    await beat(c, roomId);

    const item = seedItem(a.userId, 'Current', null);
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [item], version: 1 } });

    bus.dropRosterSync = true;
    const voter = await join('lossy-vote-cold@example.com', roomId, 1);
    await beat(voter, roomId);
    expect(presentOn(1, roomId)).toEqual([voter.userId]);

    const recorded = nextOfType(a.sock, 'queue.state');
    voter.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    const state = await recorded;
    // RECORDED — the vote is a real vote and nothing about it is refused. Not
    // ACTED ON: one member of four is not a quorum, however small this
    // instance happens to believe the room is.
    expect(state.payload.items).toHaveLength(1);
    expect(state.payload.items[0].votesToSkip).toEqual([voter.userId]);
  });

  // ── reconnecting elsewhere is not a departure ─────────────────────────────

  it('does not evict a member who reconnected onto the other instance', async () => {
    const { roomId } = await seedRoom(store);
    const stayer = await join('stay@example.com', roomId, 0);
    const mover = await join('move@example.com', roomId, 0);
    await beat(stayer, roomId);
    await beat(mover, roomId);

    const frames = collect(stayer.sock);
    mover.sock.close();
    const moverAgain = await connect(roomId, 1, mover);
    await beat(moverAgain, roomId);
    await sleep(50);

    // Instance 0 runs its grace to completion for a socket that is gone from
    // it. The member is on instance 1 and has said so over the bus.
    const { presence } = getRoomsRuntime(deps[0]!);
    const t0 = Date.now();
    await presence.sweep(t0);
    await presence.sweep(t0 + GRACE_MS + 10);
    await sleep(50);

    // Nobody was removed from the roster, on either instance.
    const removals = frames
      .filter((f) => f.type === 'presence.diff')
      .flatMap((f) => f.payload.removed as string[]);
    expect(removals).not.toContain(mover.userId);
    expect(presentOn(0, roomId)).toContain(mover.userId);
    expect(presentOn(1, roomId)).toContain(mover.userId);
  });

  it('does not force-stop the share of a host who reconnected onto the other instance', async () => {
    const { roomId } = await seedRoom(store);
    const viewer = await join('share-viewer@example.com', roomId, 0);
    const sharer = await join('share-host@example.com', roomId, 0);
    await beat(viewer, roomId);
    await beat(sharer, roomId);

    const started = nextOfType(viewer.sock, 'restream.state');
    sharer.sock.send(clientFrame(roomId, 'restream.start', {}));
    expect((await started).payload.active).toBe(true);

    // The sharer's tab reconnects onto the other instance — a rolling deploy
    // draining instance 0, a flaky network, a refresh landing elsewhere.
    sharer.sock.close();
    const sharerAgain = await connect(roomId, 1, sharer);
    await beat(sharerAgain, roomId);
    await sleep(50);

    const { presence } = getRoomsRuntime(deps[0]!);
    const t0 = Date.now();
    await presence.sweep(t0);
    await presence.sweep(t0 + GRACE_MS + 10);
    await sleep(50);

    // `restream`'s host-gone reaper keys off presence departure, so a
    // cross-instance reconnect read as a departure took the share down under
    // a host who was still sharing.
    const room = await store.rooms.findById(roomId as RoomId);
    expect(room?.restream?.active).toBe(true);
    expect(room?.restream?.hostUserId).toBe(sharer.userId);
  });
});
