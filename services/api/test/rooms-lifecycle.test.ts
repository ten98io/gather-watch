/**
 * Room lifecycle: 12-char invite codes (hyphen/case-insensitive join),
 * rename/delete CRUD with role gates, endless rooms (nothing expires on a
 * clock), the lastActivityAt bump, and the idle sweep that reclaims rooms
 * nobody is in any more.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { formatInviteCode, normalizeInviteCode } from '@gather/contracts';
import type { Room, RoomId } from '@gather/contracts';
import { makeApp, signupUser } from './helpers';
import type { TestApp } from './helpers';
import { IDLE_ROOM_TTL_MS, sweepIdleRooms } from '../src/modules/rooms/service';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function newApp(): Promise<TestApp> {
  const app = await makeApp();
  apps.push(app.app);
  return app;
}

async function createRoom(fastify: FastifyInstance, token: string, name = 'Room'): Promise<Room> {
  const res = await fastify.inject({
    method: 'POST',
    url: '/rooms',
    headers: { authorization: `Bearer ${token}` },
    payload: { kind: 'watch', name },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { room: Room }).room;
}

describe('invite codes', () => {
  it('generates 12-char codes, displayed XXXX-XXXX-XXXX', async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'a@example.com');
    const room = await createRoom(app.app, accessToken);
    expect(room.inviteCode).toMatch(/^[a-z2-9]{12}$/);
    expect(formatInviteCode(room.inviteCode)).toMatch(/^....-....-....$/);
  });

  it('joins with the hyphenated, uppercased display form', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    const { accessToken: guestToken } = await signupUser(app.app, 'guest@example.com');

    const pretty = formatInviteCode(room.inviteCode).toUpperCase();
    expect(normalizeInviteCode(pretty)).toBe(room.inviteCode);
    const res = await app.app.inject({
      method: 'POST',
      url: '/rooms/join',
      headers: { authorization: `Bearer ${guestToken}` },
      payload: { inviteCode: pretty },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { room: Room }).room.id).toBe(room.id);
  });
});

describe('room CRUD', () => {
  it('host renames, members cannot', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    const { accessToken: memberToken } = await signupUser(app.app, 'm@example.com');
    await app.app.inject({
      method: 'POST',
      url: '/rooms/join',
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { inviteCode: room.inviteCode },
    });

    const forbidden = await app.app.inject({
      method: 'PATCH',
      url: `/rooms/${room.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { name: 'Hijacked' },
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.app.inject({
      method: 'PATCH',
      url: `/rooms/${room.id}`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { name: 'Renamed' },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { room: Room }).room.name).toBe('Renamed');
  });

  it('host deletes; the room, members and messages are gone', async () => {
    const app = await newApp();
    const { accessToken: hostToken, user } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);

    const asMember = await app.app.inject({
      method: 'DELETE',
      url: `/rooms/${room.id}`,
      headers: { authorization: `Bearer ${(await signupUser(app.app, 'm2@example.com')).accessToken}` },
    });
    expect(asMember.statusCode).toBe(403); // not even a member → forbidden either way

    const ok = await app.app.inject({
      method: 'DELETE',
      url: `/rooms/${room.id}`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(await app.store.rooms.findById(room.id)).toBeNull();
    expect(await app.store.members.count({ roomId: room.id })).toBe(0);
    void user;
  });
});

describe('room kind (vestigial)', () => {
  it("create WITHOUT kind succeeds; the doc and response default to 'watch'", async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'nokind@example.com');
    const res = await app.app.inject({
      method: 'POST',
      url: '/rooms',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Kindless' },
    });
    expect(res.statusCode).toBe(200);
    const room = (res.json() as { room: Room }).room;
    expect(room.kind).toBe('watch');
    expect((await app.store.rooms.findById(room.id))?.kind).toBe('watch');
  });

  it("create WITH kind 'listen' still succeeds and serializes it back (old clients)", async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'oldclient@example.com');
    const res = await app.app.inject({
      method: 'POST',
      url: '/rooms',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { kind: 'listen', name: 'Legacy listen' },
    });
    expect(res.statusCode).toBe(200);
    const room = (res.json() as { room: Room }).room;
    expect(room.kind).toBe('listen');
    // Serialized rooms keep carrying kind on every read path.
    const get = await app.app.inject({
      method: 'GET',
      url: `/rooms/${room.id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { room: Room }).room.kind).toBe('listen');
  });
});

describe('endless rooms', () => {
  it('rooms are created with no expiry at all', async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'endless@example.com');
    const room = await createRoom(app.app, accessToken);

    expect(room.expiresAt).toBeNull();
    const doc = await app.store.rooms.findById(room.id);
    expect(doc?.expiresAt).toBeNull();
    // Stamped so the idle sweeper has a floor from the first moment.
    expect(doc?.lastActivityAt).toBeGreaterThan(0);
  });

  it('persisted room events stamp lastActivityAt and never set an expiry', async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'act@example.com');
    const room = await createRoom(app.app, accessToken);

    // Backdate past the once-a-minute bump throttle so the next emit writes.
    const stale = Date.now() - 10 * 60_000;
    await app.store.rooms.updateOne({ id: room.id }, { lastActivityAt: stale });
    await app.deps.events.emit(room.id, 'room.updated', room);

    const after = await app.store.rooms.findById(room.id);
    expect(after?.lastActivityAt ?? 0).toBeGreaterThan(stale);
    expect(after?.expiresAt).toBeNull();
  });
});

describe('idle-room sweep', () => {
  /** Age a room's activity stamp past the idle window. */
  async function makeIdle(app: TestApp, roomId: string): Promise<void> {
    const longAgo = Date.now() - IDLE_ROOM_TTL_MS - 60_000;
    await app.store.rooms.updateOne(
      { id: roomId as RoomId },
      { lastActivityAt: longAgo, createdAt: longAgo },
    );
  }

  it('NEVER reaps a room that still has members, however long it has been quiet', async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'quiet@example.com');
    const room = await createRoom(app.app, accessToken);
    await makeIdle(app, room.id);

    // The host is still a member — a session that has been idle for a year is
    // still someone's room, and the sweep must not touch it.
    expect(await app.store.members.count({ roomId: room.id })).toBe(1);

    const deleted = await sweepIdleRooms(app.deps, Date.now());
    expect(deleted).not.toContain(room.id);
    expect(await app.store.rooms.findById(room.id)).not.toBeNull();
  });

  it('reaps an EMPTY room past the idle window, with its members, history and invites', async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'abandoned@example.com');
    const room = await createRoom(app.app, accessToken);
    await app.deps.events.emit(room.id, 'room.updated', room);
    // Everyone walked out (the host's departure leaves the room ownerless).
    await app.store.members.deleteMany({ roomId: room.id });
    await makeIdle(app, room.id);

    const deleted = await sweepIdleRooms(app.deps, Date.now());
    expect(deleted).toContain(room.id);
    expect(await app.store.rooms.findById(room.id)).toBeNull();
    expect(await app.store.members.count({ roomId: room.id })).toBe(0);
    expect(await app.store.events.count({ roomId: room.id })).toBe(0);
    expect(await app.store.invites.count({ roomId: room.id })).toBe(0);
  });

  it('leaves an empty room alone until the idle window has actually passed', async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'recent@example.com');
    const room = await createRoom(app.app, accessToken);
    await app.store.members.deleteMany({ roomId: room.id });
    // Old enough to be a candidate, but active yesterday.
    const yesterday = Date.now() - 24 * 3600_000;
    await app.store.rooms.updateOne(
      { id: room.id },
      { createdAt: Date.now() - IDLE_ROOM_TTL_MS - 60_000, lastActivityAt: yesterday },
    );

    const deleted = await sweepIdleRooms(app.deps, Date.now());
    expect(deleted).not.toContain(room.id);
    expect(await app.store.rooms.findById(room.id)).not.toBeNull();
  });

  it('falls back to createdAt for rooms stored before lastActivityAt existed', async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'legacy@example.com');
    const room = await createRoom(app.app, accessToken);
    await app.store.members.deleteMany({ roomId: room.id });
    // A legacy doc: no lastActivityAt field at all.
    const longAgo = Date.now() - IDLE_ROOM_TTL_MS - 60_000;
    const doc = await app.store.rooms.findById(room.id);
    if (doc === null) throw new Error('room missing');
    const { lastActivityAt: _dropped, ...legacy } = doc;
    await app.store.rooms.deleteOne({ id: room.id });
    await app.store.rooms.insertOne({ ...legacy, createdAt: longAgo });

    const deleted = await sweepIdleRooms(app.deps, Date.now());
    expect(deleted).toContain(room.id);
  });
});
