/**
 * Regression: the chat module MUST be registered in src/modules/index.ts.
 * It shipped once fully built but never wired into the registry, leaving the
 * whole chat REST surface (messages, pins, unfurl, gif search) dead 404s and
 * every chat.* WS handler unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { modules } from '../src/modules/index';
import type { StorePort } from '../src/adapters/ports';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';

describe('chat module wiring', () => {
  let app: FastifyInstance;
  let store: StorePort;

  beforeAll(async () => {
    ({ app, store } = await makeApp());
  });
  afterAll(async () => {
    await app.close();
  });

  it('is present in the module registry with its WS handlers', () => {
    const chat = modules.find((m) => m.name === 'chat');
    expect(chat).toBeDefined();
    expect(Object.keys(chat?.wsHandlers ?? {})).toEqual(
      expect.arrayContaining(['chat.send', 'chat.react', 'chat.read', 'emote.burst']),
    );
  });

  it('serves the chat REST surface (no 404s)', async () => {
    const account = await signupUser(app, 'chat-wiring@example.com');
    const seeded = await seedRoom(store);
    await addMember(store, seeded.roomId, account.user.id, 'member');
    const headers = { authorization: `Bearer ${account.accessToken}` };

    const messages = await app.inject({
      method: 'GET',
      url: `/rooms/${seeded.roomId}/messages`,
      headers,
    });
    expect(messages.statusCode).toBe(200);

    const pins = await app.inject({
      method: 'GET',
      url: `/rooms/${seeded.roomId}/pins`,
      headers,
    });
    expect(pins.statusCode).toBe(200);

    const gifs = await app.inject({ method: 'GET', url: '/gifs/search?q=cat', headers });
    expect(gifs.statusCode).toBe(200);
  });
});
