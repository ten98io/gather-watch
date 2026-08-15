/**
 * Redis-backed BusPort for multi-instance deploys. Two connections are
 * required: a Redis connection that has entered subscribe mode cannot issue
 * any other commands (including PUBLISH). Payloads are JSON frames; a frame
 * that fails to parse is skipped, never dispatched.
 */
import { Redis } from 'ioredis';
import type { BusHandler, BusPort } from './ports';

export class RedisBus implements BusPort {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Map<string, Set<BusHandler>>();

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
    let subscribers = this.handlers.get(channel);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.handlers.set(channel, subscribers);
      // SUBSCRIBE only on the first local handler for the channel.
      await this.subscriber.subscribe(channel);
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

  async close(): Promise<void> {
    this.handlers.clear();
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }
}
