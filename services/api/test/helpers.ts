/**
 * Shared test helpers: a deterministic config, an app factory wired to the
 * memory adapters, and seeding/signup utilities. No external services — every
 * app built here runs on MemoryStore + MemoryBus.
 */
import type { FastifyInstance } from 'fastify';
import type { InviteCode, Member, RoomId, User, UserId } from '@playin/contracts';
import { buildApp } from '../src/app';
import type { BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { AppConfig } from '../src/config';
import { MemoryBus } from '../src/adapters/memory-bus';
import { MemoryStore } from '../src/adapters/memory-store';
import { memberDocId } from '../src/adapters/ports';
import type { MemberDoc, RoomDoc, StorePort, UserDoc } from '../src/adapters/ports';
import { newId } from '../src/lib/tokens';

/**
 * Development config (dev magic links are echoed back as `devLink`) with rate
 * limits effectively disabled so no test flakes on a 429.
 */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({});
  return {
    ...base,
    nodeEnv: 'development',
    rateLimit: { max: 100000, windowMs: 60000, authMax: 100000 },
    ...overrides,
  };
}

export interface TestApp extends BuiltApp {
  store: StorePort;
}

/** Build an app backed by fresh in-memory adapters. Callers close the app. */
export async function makeApp(config: AppConfig = testConfig()): Promise<TestApp> {
  const store = new MemoryStore();
  const bus = new MemoryBus();
  const built = await buildApp({ config, store, bus });
  return { ...built, store };
}

let roomCounter = 0;

export interface SeededRoom {
  ownerId: UserId;
  roomId: RoomId;
  inviteCode: string;
}

/** Insert an owner user, a watch room, and the owner's host membership. */
export async function seedRoom(store: StorePort, ownerId?: string): Promise<SeededRoom> {
  const now = Date.now();
  roomCounter += 1;
  const inviteCode = `inv${roomCounter.toString().padStart(4, '0')}`;

  const owner: UserDoc = {
    id: (ownerId ?? newId()) as UserId,
    email: null,
    displayName: 'Room Owner',
    avatarUrl: null,
    accentColor: '#8b5cf6',
    createdAt: now,
  };
  await store.users.insertOne(owner);

  const room: RoomDoc = {
    id: newId() as RoomId,
    kind: 'watch',
    name: 'Test Room',
    inviteCode: inviteCode as InviteCode,
    ownerId: owner.id,
    policies: {
      playbackControl: 'host',
      queueControl: 'everyone',
      chat: 'everyone',
      maxPublishers: 6,
      waitForAll: false,
      voteSkipThreshold: 0.5,
      skipVoteThreshold: 0.5,
    },
    relayMode: 'mesh',
    theater: false,
    createdAt: now,
    playback: null,
    queue: { items: [], version: 0 },
    restream: null,
    master: null,
  };
  await store.rooms.insertOne(room);

  await addMember(store, room.id, owner.id, 'host');

  return { ownerId: owner.id, roomId: room.id, inviteCode };
}

/** Add a membership row (banned: false, muted: false). */
export async function addMember(
  store: StorePort,
  roomId: string,
  userId: string,
  role: Member['role'],
): Promise<MemberDoc> {
  return store.members.insertOne({
    id: memberDocId(roomId, userId),
    roomId: roomId as RoomId,
    userId: userId as UserId,
    role,
    joinedAt: Date.now(),
    banned: false,
    muted: false,
  });
}

export interface SignedUpUser {
  user: User;
  accessToken: string;
  /** Raw playin_rt refresh-cookie value. */
  cookie: string;
}

/** Full magic-link signup through HTTP: returns the verified user, its
 *  access token, and the refresh-cookie value. */
export async function signupUser(app: FastifyInstance, email: string): Promise<SignedUpUser> {
  const linkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  if (linkRes.statusCode !== 200) {
    throw new Error(`magic-link failed: ${linkRes.statusCode} ${linkRes.body}`);
  }
  const devLink = (linkRes.json() as { devLink?: string }).devLink;
  if (devLink === undefined) {
    throw new Error('devLink missing from magic-link response');
  }
  const token = new URL(devLink).searchParams.get('token');
  if (token === null) {
    throw new Error(`devLink has no token param: ${devLink}`);
  }
  const verifyRes = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } });
  if (verifyRes.statusCode !== 200) {
    throw new Error(`verify failed: ${verifyRes.statusCode} ${verifyRes.body}`);
  }
  const body = verifyRes.json() as { user: User; accessToken: string };
  const cookie = verifyRes.cookies.find((c) => c.name === 'playin_rt');
  if (cookie === undefined) {
    throw new Error('playin_rt cookie missing from verify response');
  }
  return { user: body.user, accessToken: body.accessToken, cookie: cookie.value };
}
