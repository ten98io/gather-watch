/**
 * Roster liveness: every membership mutation has to reach the people who
 * stayed. The owner's #1 symptom was "kicking someone requires a physical
 * refresh" — kick/leave deleted the row and broadcast nothing, and a guest
 * arriving through an invite link never appeared at all.
 *
 * Departures ride removeFromRoom (the one chokepoint for kick, non-host
 * leave, ban and room-delete) as an EPHEMERAL member.removed: seq 0, because
 * a client that predates the type fails ServerEvent.safeParse and returns
 * without advancing its SeqTracker — a persisted seq would read as a gap
 * forever after. Arrivals are member.updated, which every client already
 * handles.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Member, Room, RoomId, ServerEvent, User } from '@gather/contracts';
import { makeApp, signupUser } from './helpers';
import type { TestApp } from './helpers';
import { roomChannel } from '../src/adapters/ports';
import type { RoomBusMessage } from '../src/adapters/ports';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function newApp(): Promise<TestApp> {
  const app = await makeApp();
  apps.push(app.app);
  return app;
}

/** MemoryBus fans out on queueMicrotask and emitEphemeral does not await the
 *  publish, so give both a real turn before asserting. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Everything broadcast on the room's client channel, in arrival order. */
async function watchRoom(
  app: TestApp,
  roomId: string,
): Promise<{ events: ServerEvent[]; stop: () => Promise<void> }> {
  const events: ServerEvent[] = [];
  const stop = await app.deps.bus.subscribe(roomChannel(roomId as RoomId), (raw) => {
    events.push((raw as RoomBusMessage).event as ServerEvent);
  });
  return { events, stop };
}

async function createRoom(fastify: FastifyInstance, token: string): Promise<Room> {
  const res = await fastify.inject({
    method: 'POST',
    url: '/rooms',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Roster Room' },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { room: Room }).room;
}

async function joinRoom(fastify: FastifyInstance, token: string, inviteCode: string): Promise<void> {
  const res = await fastify.inject({
    method: 'POST',
    url: '/rooms/join',
    headers: { authorization: `Bearer ${token}` },
    payload: { inviteCode },
  });
  expect(res.statusCode).toBe(200);
}

/** Host + one plain member, both joined, nothing watched yet. */
async function roomWithMember(app: TestApp): Promise<{
  room: Room;
  hostToken: string;
  memberToken: string;
  memberId: string;
}> {
  const { accessToken: hostToken } = await signupUser(app.app, `host-${Date.now()}@example.com`);
  const room = await createRoom(app.app, hostToken);
  const { accessToken: memberToken, user } = await signupUser(
    app.app,
    `member-${Date.now()}@example.com`,
  );
  await joinRoom(app.app, memberToken, room.inviteCode);
  return { room, hostToken, memberToken, memberId: user.id };
}

function removals(events: ServerEvent[]): Array<Extract<ServerEvent, { type: 'member.removed' }>> {
  return events.filter(
    (ev): ev is Extract<ServerEvent, { type: 'member.removed' }> => ev.type === 'member.removed',
  );
}

describe('departures reach the room', () => {
  it('kick broadcasts member.removed for the kicked user', async () => {
    const app = await newApp();
    const { room, hostToken, memberId } = await roomWithMember(app);
    const watch = await watchRoom(app, room.id);

    const res = await app.app.inject({
      method: 'POST',
      url: `/rooms/${room.id}/kick`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { userId: memberId },
    });
    expect(res.statusCode).toBe(200);
    await flush();
    await watch.stop();

    const removed = removals(watch.events);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.payload).toEqual({ userId: memberId, reason: 'kicked' });
  });

  it('a NON-HOST leaving broadcasts member.removed (the host branch is not what publishes)', async () => {
    const app = await newApp();
    const { room, memberToken, memberId } = await roomWithMember(app);
    const watch = await watchRoom(app, room.id);

    const res = await app.app.inject({
      method: 'POST',
      url: `/rooms/${room.id}/leave`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(200);
    await flush();
    await watch.stop();

    const removed = removals(watch.events);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.payload).toEqual({ userId: memberId, reason: 'left' });
    // No successor promotion happened, so member.removed is the ONLY thing
    // that could have told the room. (Before the fix a departing host
    // self-healed by accident — the successor's member.updated bumped the
    // client's membersVersion — and a plain member vanished silently.)
    expect(watch.events.some((ev) => ev.type === 'member.updated')).toBe(false);
  });

  it('banning broadcasts member.removed as well as the persisted member.updated', async () => {
    const app = await newApp();
    const { room, hostToken, memberId } = await roomWithMember(app);
    const watch = await watchRoom(app, room.id);

    const res = await app.app.inject({
      method: 'POST',
      url: `/rooms/${room.id}/ban`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { userId: memberId, banned: true },
    });
    expect(res.statusCode).toBe(200);
    await flush();
    await watch.stop();

    const removed = removals(watch.events);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.payload).toEqual({ userId: memberId, reason: 'banned' });
  });

  it('member.removed is ephemeral: seq 0 and never persisted', async () => {
    const app = await newApp();
    const { room, hostToken, memberId } = await roomWithMember(app);
    const watch = await watchRoom(app, room.id);

    await app.app.inject({
      method: 'POST',
      url: `/rooms/${room.id}/kick`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { userId: memberId },
    });
    await flush();
    await watch.stop();

    // Seq 0 keeps an older client — which cannot parse this type and bails
    // before advancing its SeqTracker — out of permanent gap/replay.
    expect(removals(watch.events).map((ev) => ev.seq)).toEqual([0]);
    const persisted = await app.store.events.findMany({ roomId: room.id });
    expect(persisted.some((ev) => ev.type === 'member.removed')).toBe(false);
  });
});

describe('guest arrivals reach the room', () => {
  it('a guest joining by invite broadcasts member.updated', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'guesthost@example.com');
    const room = await createRoom(app.app, hostToken);
    const watch = await watchRoom(app, room.id);

    const res = await app.app.inject({
      method: 'POST',
      url: '/auth/guest',
      payload: { inviteCode: room.inviteCode, displayName: 'Drop-in' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: User; member: Member; lastEventSeq: number };
    await flush();
    await watch.stop();

    const updates = watch.events.filter((ev) => ev.type === 'member.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toEqual({
      roomId: room.id,
      userId: body.user.id,
      role: 'guest',
      joinedAt: body.member.joinedAt,
      banned: false,
    });
  });

  it("the guest's own lastEventSeq includes their arrival (no replay on connect)", async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'seqhost@example.com');
    const room = await createRoom(app.app, hostToken);

    const res = await app.app.inject({
      method: 'POST',
      url: '/auth/guest',
      payload: { inviteCode: room.inviteCode, displayName: 'Drop-in' },
    });
    expect(res.statusCode).toBe(200);
    const { user, lastEventSeq } = res.json() as { user: User; lastEventSeq: number };

    // The arrival must be emitted BEFORE the tip read. Emitted after, the
    // returned tip predates the event and the guest's socket opens behind
    // the stream — a replay on every guest connect.
    const persisted = await app.store.events.findMany({ roomId: room.id });
    const arrival = persisted.find(
      (ev) => ev.type === 'member.updated' && (ev.payload as Member).userId === user.id,
    );
    expect(arrival).toBeDefined();
    expect(lastEventSeq).toBeGreaterThanOrEqual(arrival?.seq ?? Number.POSITIVE_INFINITY);
  });
});
