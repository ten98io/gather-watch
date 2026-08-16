/**
 * Shared dependencies + Fastify augmentation. Mirrors the api's Deps seam,
 * narrowed to what this service owns.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { RoomId, UserId } from '@gather/contracts';
import type { AppConfig } from './config';
import type { AssetStore } from './store/ports';
import type { ObjectStorage } from './storage/ports';
import type { MediaPipeline } from './pipeline/pipeline';

/** Verified identity attached to a request by the auth plugin. */
export interface AuthContext {
  userId: UserId;
  sessionId: string;
  /** True for guest (invite-link) identities. */
  guest: boolean;
  /** Guests are room-scoped; null for full accounts. */
  guestRoomId: RoomId | null;
}

export interface Deps {
  config: AppConfig;
  log: FastifyBaseLogger;
  store: AssetStore;
  storage: ObjectStorage;
  pipeline: MediaPipeline;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
  }
  interface FastifyRequest {
    /** Set by the auth plugin; null when unauthenticated. */
    auth: AuthContext | null;
  }
}
