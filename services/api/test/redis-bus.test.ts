/**
 * RedisBus subscription bookkeeping, against a fake ioredis whose SUBSCRIBE is
 * held open on purpose. The failure these pin: a channel that LOOKS live to a
 * second subscriber while Redis has not acknowledged the SUBSCRIBE yet. The
 * hub hands that second connection a socket and lets its handlers emit into a
 * channel this process is not listening on, so the sender never sees its own
 * events.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  /** Channels handed to SUBSCRIBE, in call order. */
  subscribeCalls: [] as string[],
  unsubscribeCalls: [] as string[],
  /** One resolver per in-flight SUBSCRIBE; the test decides when Redis answers. */
  pending: [] as Array<{ resolve: () => void; reject: (err: Error) => void }>,
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    on(): this {
      return this;
    }
    async publish(): Promise<number> {
      return 0;
    }
    subscribe(channel: string): Promise<number> {
      fake.subscribeCalls.push(channel);
      return new Promise<number>((resolve, reject) => {
        fake.pending.push({ resolve: () => resolve(1), reject });
      });
    }
    async unsubscribe(channel: string): Promise<number> {
      fake.unsubscribeCalls.push(channel);
      return 0;
    }
    async ping(): Promise<string> {
      return 'PONG';
    }
    async quit(): Promise<string> {
      return 'OK';
    }
  }
  return { Redis: FakeRedis };
});

const { RedisBus } = await import('../src/adapters/redis-bus');

/** One real macrotask: enough for any already-resolvable promise to settle. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  fake.subscribeCalls.length = 0;
  fake.unsubscribeCalls.length = 0;
  fake.pending.length = 0;
});

describe('RedisBus.subscribe', () => {
  it('does not report a channel live until the SUBSCRIBE has landed', async () => {
    const bus = new RedisBus('redis://fake:6379');
    const settled: string[] = [];
    const first = bus.subscribe('room:r1', () => undefined).then(() => {
      settled.push('first');
    });
    await tick();
    const second = bus.subscribe('room:r1', () => undefined).then(() => {
      settled.push('second');
    });
    await tick();

    // Redis has not acknowledged anything yet. A second subscriber that
    // resolves here believes it is listening to a channel it is not on.
    expect(settled).toEqual([]);
    // ...and it must not paper over that by issuing a duplicate SUBSCRIBE,
    // which would deliver every event to this instance's sockets twice.
    expect(fake.subscribeCalls).toEqual(['room:r1']);

    fake.pending[0]?.resolve();
    await Promise.all([first, second]);
    expect(settled.sort()).toEqual(['first', 'second']);
    expect(fake.subscribeCalls).toEqual(['room:r1']);
  });

  it('propagates a failed SUBSCRIBE to every waiter and stays retryable', async () => {
    const bus = new RedisBus('redis://fake:6379');
    const first = bus.subscribe('room:r2', () => undefined);
    await tick();
    const second = bus.subscribe('room:r2', () => undefined);
    await tick();

    fake.pending[0]?.reject(new Error('redis unreachable'));
    await expect(first).rejects.toThrow(/redis unreachable/);
    await expect(second).rejects.toThrow(/redis unreachable/);

    // Nothing is cached from a failure: the next connection retries the
    // SUBSCRIBE rather than inheriting a channel that was never established.
    const third = bus.subscribe('room:r2', () => undefined);
    await tick();
    expect(fake.subscribeCalls).toEqual(['room:r2', 'room:r2']);
    fake.pending[1]?.resolve();
    await expect(third).resolves.toBeTypeOf('function');
  });

  it('UNSUBSCRIBEs only once the last local handler for the channel is gone', async () => {
    const bus = new RedisBus('redis://fake:6379');
    const first = bus.subscribe('room:r3', () => undefined);
    await tick();
    fake.pending[0]?.resolve();
    const undoFirst = await first;
    const undoSecond = await bus.subscribe('room:r3', () => undefined);
    expect(fake.subscribeCalls).toEqual(['room:r3']);

    await undoFirst();
    expect(fake.unsubscribeCalls).toEqual([]);
    await undoSecond();
    expect(fake.unsubscribeCalls).toEqual(['room:r3']);
    // Idempotent: a second call must not unsubscribe a channel someone else
    // has since re-subscribed.
    await undoSecond();
    expect(fake.unsubscribeCalls).toEqual(['room:r3']);
  });
});
