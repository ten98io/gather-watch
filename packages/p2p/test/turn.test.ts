import { describe, expect, it } from 'vitest';
import type { TurnCredentialsResponse } from '@playin/contracts';
import { TurnCredentialManager } from '../src/turn';
import { VirtualClock } from './harness';

const CREDS: TurnCredentialsResponse = {
  iceServers: [{ urls: ['turn:x'], username: 'u', credential: 'c' }],
  ttlSeconds: 100,
  fairUseRemainingGb: 12,
};

describe('TurnCredentialManager', () => {
  it('start fetches and refreshes at 80% of TTL', async () => {
    const clock = new VirtualClock();
    let calls = 0;
    let updates = 0;
    const mgr = new TurnCredentialManager({
      getTurnCredentials: () => {
        calls += 1;
        return Promise.resolve(CREDS);
      },
      now: () => clock.now(),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onUpdate: () => {
        updates += 1;
      },
    });

    await mgr.start();
    expect(calls).toBe(1);
    expect(mgr.iceServers()).toEqual(CREDS.iceServers);
    expect(mgr.ttlSeconds()).toBe(100);
    expect(mgr.fairUseRemainingGb()).toBe(12);
    expect(updates).toBe(1);

    // Refresh fires at 80_000ms (0.8 * 100s TTL).
    await clock.advance(79_999);
    expect(calls).toBe(1);
    await clock.advance(2);
    expect(calls).toBe(2);
    expect(updates).toBe(2);
  });

  it('failure backoff doubles then success resets', async () => {
    const clock = new VirtualClock();
    let calls = 0;
    let errors = 0;
    let updates = 0;
    const mgr = new TurnCredentialManager({
      getTurnCredentials: () => {
        calls += 1;
        return calls <= 2 ? Promise.reject(new Error('boom')) : Promise.resolve(CREDS);
      },
      now: () => clock.now(),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      retryBaseMs: 5000,
      onError: () => {
        errors += 1;
      },
      onUpdate: () => {
        updates += 1;
      },
    });

    await mgr.start();
    expect(calls).toBe(1);
    expect(errors).toBe(1);
    expect(mgr.iceServers()).toEqual([]);

    await clock.advance(5000); // first retry after retryBaseMs
    expect(calls).toBe(2);
    expect(errors).toBe(2);
    expect(mgr.iceServers()).toEqual([]);

    // Backoff doubled: the next attempt is 10_000ms after the previous one.
    await clock.advance(9999);
    expect(calls).toBe(2);
    await clock.advance(1);
    expect(calls).toBe(3);
    expect(mgr.iceServers()).toEqual(CREDS.iceServers);
    expect(updates).toBe(1);

    // Success reset the cycle: normal refresh at 80% of TTL.
    await clock.advance(80_000);
    expect(calls).toBe(4);
    expect(errors).toBe(2);
    expect(updates).toBe(2);
  });

  it('stop voids in-flight results', async () => {
    const clock = new VirtualClock();
    const resolvers: Array<(res: TurnCredentialsResponse) => void> = [];
    let updates = 0;
    const mgr = new TurnCredentialManager({
      getTurnCredentials: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
      now: () => clock.now(),
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onUpdate: () => {
        updates += 1;
      },
    });

    void mgr.start(); // fetch now in flight
    expect(resolvers).toHaveLength(1);

    mgr.stop();
    resolvers[0]!(CREDS);
    await clock.flush();

    expect(mgr.iceServers()).toEqual([]);
    expect(mgr.ttlSeconds()).toBeNull();
    expect(updates).toBe(0);
  });
});
