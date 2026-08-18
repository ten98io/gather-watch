/**
 * The bus liveness probe must accept BOTH shapes of a Redis PING reply.
 *
 * This shipped broken and took production with it. A connection in SUBSCRIBER
 * mode does not answer `+PONG` — it answers a two-element array,
 * `["pong", ""]`. The probe compared against the string only, so `/readyz`
 * served 200 at boot and 503 forty-five seconds later, the moment the first
 * WebSocket subscribed a channel. Railway gates deploys on that endpoint, so a
 * healthy bus read as a dead one and the service was marked unhealthy.
 *
 * No test caught it because nothing in this repo talks to a real Redis, and
 * the subscriber-mode reply only exists on a connection that has actually
 * subscribed — which is every connection, in every room that is in use.
 */
import { describe, expect, it, vi } from 'vitest';
import { RedisBus } from '../src/adapters/redis-bus';

/** Build a bus whose two connections answer PING with the given replies. */
function busAnswering(publisherReply: unknown, subscriberReply: unknown): RedisBus {
  const bus = new RedisBus('redis://127.0.0.1:6379');
  const internals = bus as unknown as {
    publisher: { ping: () => Promise<unknown>; quit: () => Promise<unknown> };
    subscriber: { ping: () => Promise<unknown>; quit: () => Promise<unknown> };
  };
  internals.publisher.ping = vi.fn().mockResolvedValue(publisherReply);
  internals.subscriber.ping = vi.fn().mockResolvedValue(subscriberReply);
  return bus;
}

describe('RedisBus.ping accepts every real PING reply shape', () => {
  it('the ordinary case: both connections answer +PONG', async () => {
    await expect(busAnswering('PONG', 'PONG').ping()).resolves.toBe(true);
  });

  it('SUBSCRIBER MODE: the subscriber answers ["pong", ""] — the production case', async () => {
    // Once any room exists, the subscriber connection is permanently in this
    // mode. Rejecting it means /readyz fails for every room that is in use.
    await expect(busAnswering('PONG', ['pong', '']).ping()).resolves.toBe(true);
  });

  it('accepts the array form on either connection, and mixed case', async () => {
    await expect(busAnswering(['PONG', ''], ['pong', 'chan']).ping()).resolves.toBe(true);
  });

  it('still reports a genuinely dead connection', async () => {
    await expect(busAnswering('PONG', 'LOADING').ping()).resolves.toBe(false);
    await expect(busAnswering(null, 'PONG').ping()).resolves.toBe(false);
    await expect(busAnswering('PONG', []).ping()).resolves.toBe(false);
  });

  it('a rejected ping is not a pong', async () => {
    const bus = new RedisBus('redis://127.0.0.1:6379');
    const internals = bus as unknown as {
      publisher: { ping: () => Promise<unknown> };
      subscriber: { ping: () => Promise<unknown> };
    };
    internals.publisher.ping = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    internals.subscriber.ping = vi.fn().mockResolvedValue('PONG');
    await expect(bus.ping()).resolves.toBe(false);
  });
});
