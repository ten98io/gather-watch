/**
 * In-memory BusPort for single-instance dev/test. Mirrors Redis pub/sub
 * semantics exactly (see the BusPort doc): delivery is asynchronous and the
 * PUBLISHING caller's own subscribers receive the message too, so behavior
 * does not change when RedisBus replaces this in multi-instance deploys.
 */
import type { BusHandler, BusPort } from './ports';

export class MemoryBus implements BusPort {
  private readonly handlers = new Map<string, Set<BusHandler>>();

  async publish(channel: string, message: unknown): Promise<void> {
    const subscribers = this.handlers.get(channel);
    if (subscribers === undefined) return;
    // Snapshot: a handler may unsubscribe synchronously during fanout.
    for (const handler of [...subscribers]) {
      queueMicrotask(() => {
        try {
          handler(message);
        } catch {
          // A bad subscriber must not break fanout to the others.
        }
      });
    }
  }

  async subscribe(channel: string, handler: BusHandler): Promise<() => Promise<void>> {
    let subscribers = this.handlers.get(channel);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.handlers.set(channel, subscribers);
    }
    subscribers.add(handler);

    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.handlers.get(channel);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(channel);
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
