/**
 * Adapter factory: picks the backing store/bus from config so the rest of the
 * app only ever sees the ports. Empty MONGO_URL/REDIS_URL ⇒ the in-memory
 * adapters (dev/test); real URLs ⇒ Mongo/Redis (multi-instance prod).
 */
import type { AppConfig } from '../config';
import { MemoryBus } from './memory-bus';
import { MemoryStore } from './memory-store';
import { MongoStore } from './mongo-store';
import { RedisBus } from './redis-bus';
import type { BusPort, StorePort } from './ports';

export function createStore(config: AppConfig): StorePort {
  return config.mongoUrl === null ? new MemoryStore() : new MongoStore(config.mongoUrl);
}

export function createBus(config: AppConfig): BusPort {
  return config.redisUrl === null ? new MemoryBus() : new RedisBus(config.redisUrl);
}

export { MemoryBus } from './memory-bus';
export { MemoryStore } from './memory-store';
export { MongoStore } from './mongo-store';
export { RedisBus } from './redis-bus';
export * from './ports';
