import type { AppConfig } from '../config';
import type { AssetStore } from './ports';
import { MemoryAssetStore } from './memory';
import { MongoAssetStore } from './mongo';

/** Mongo when MONGO_URL is set, memory otherwise (tests, storage-less dev). */
export function createAssetStore(config: AppConfig): AssetStore {
  return config.mongoUrl === null ? new MemoryAssetStore() : new MongoAssetStore(config.mongoUrl);
}
