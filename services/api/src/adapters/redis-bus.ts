/**
 * Redis-backed BusPort for multi-instance deploys. Two connections are
 * required: a Redis connection that has entered subscribe mode cannot issue
 * any other commands (including PUBLISH). Payloads are JSON frames; a frame
 * that fails to parse is skipped, never dispatched.
 */
import { Redis } from 'ioredis';
import type { BusHandler, BusPort } from './ports';

/**
 * Liveness ceiling. `maxRetriesPerRequest: null` (below) means a command
 * issued while the connection is down QUEUES instead of failing, so an
 * unbounded PING would hang /readyz rather than answer it — and a healthcheck
 * that hangs reads as a timeout to some probes and as nothing at all to
 * others. Bound it and report false.
 */
const PING_TIMEOUT_MS = 2_000;

export class RedisBus implements BusPort {
  readonly mode = 'redis' as const;

  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  /**
   * Channel → local handlers. An entry here means "Redis has ACKed the
   * SUBSCRIBE for this channel"; nothing is published into it earlier, so a
   * concurrent subscriber can never read it as live ahead of the server.
   */
  private readonly handlers = new Map<string, Set<BusHandler>>();
  /** Channel → the one in-flight SUBSCRIBE concurrent callers wait on. */
  private readonly subscribing = new Map<string, Promise<void>>();

  constructor(url: string) {
    // lazyConnect: the adapter is constructed at boot but only dials out on
    // first use; maxRetriesPerRequest null keeps pub/sub commands from
    // queue-failing behind ioredis' retry cap.
    const options = { lazyConnect: true, maxRetriesPerRequest: null };
    this.publisher = new Redis(url, options);
    this.subscriber = new Redis(url, options);
    // Connection errors surface through command rejections; without a
    // listener the 'error' event itself would crash the process.
    this.publisher.on('error', () => undefined);
    this.subscriber.on('error', () => undefined);

    this.subscriber.on('message', (channel: string, raw: string) => {
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return; // Not one of our frames — skip it.
      }
      const subscribers = this.handlers.get(channel);
      if (subscribers === undefined) return;
      for (const handler of [...subscribers]) {
        try {
          handler(message);
        } catch {
          // A bad subscriber must not break fanout to the others.
        }
      }
    });
  }

  async publish(channel: string, message: unknown): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string, handler: BusHandler): Promise<() => Promise<void>> {
    // SUBSCRIBE only on the first local handler for the channel — and publish
    // the handler set only once that SUBSCRIBE has really landed. Registering
    // it up front made this method resolve for a SECOND concurrent caller
    // while Redis was still silent: that caller believes the channel is live,
    // starts emitting, and its events go into a channel nobody here is on.
    // Concurrent callers share the one in-flight promise, so no duplicate
    // SUBSCRIBE (which would double-deliver every event) and no deadlock.
    while (!this.handlers.has(channel)) {
      const inflight = this.subscribing.get(channel);
      if (inflight !== undefined) {
        await inflight;
        continue;
      }
      const started = this.subscriber.subscribe(channel).then(() => {
        if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
      });
      this.subscribing.set(channel, started);
      try {
        await started;
      } finally {
        // A rejected SUBSCRIBE caches nothing: the next caller retries it.
        if (this.subscribing.get(channel) === started) this.subscribing.delete(channel);
      }
    }
    const subscribers = this.handlers.get(channel);
    if (subscribers === undefined) {
      // Unreachable: the loop above only exits once the entry exists.
      throw new Error(`bus subscribe lost its handler set for ${channel}`);
    }
    subscribers.add(handler);

    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.handlers.get(channel);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(channel);
        // UNSUBSCRIBE when the last local handler for the channel goes away.
        await this.subscriber.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  /**
   * Both connections must answer. The publisher carries this instance's
   * outbound events and the subscriber carries every other instance's, so
   * either one dying alone already means broken fan-out — a probe that only
   * checked the publisher would call a deaf instance ready. PING is one of the
   * few commands a connection in subscribe mode still accepts.
   */
  async ping(): Promise<boolean> {
    const probe = Promise.all([this.publisher.ping(), this.subscriber.ping()])
      .then((replies) => replies.every((reply) => reply === 'PONG'))
      .catch(() => false);
    const expiry = new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
      // A pending probe must never hold the process open at shutdown.
      timer.unref();
    });
    return Promise.race([probe, expiry]);
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.subscribing.clear();
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }
}
