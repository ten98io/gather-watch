/**
 * TURN credential lifecycle: short-lived TURN credentials must be refreshed
 * before they expire or every new peer connection silently degrades to
 * host/srflx candidates only. This manager fetches on start, refreshes at a
 * fraction of the TTL, and backs off (with doubling) on fetch failures.
 */

import type { TurnCredentialsResponse } from '@playin/contracts';
import type { ClearTimeoutFn, IceServerLike, NowFn, SetTimeoutFn, TimeoutHandle } from './types';

/** Options for {@link TurnCredentialManager}. */
export interface TurnCredentialManagerOptions {
  /** Usually api-client's REST call, injected so this package stays dependency-free. */
  getTurnCredentials: () => Promise<TurnCredentialsResponse>;
  now: NowFn;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  /** Refresh at this fraction of the TTL. Default 0.8. */
  refreshFraction?: number;
  /** Fired after every successful (re)fetch with the fresh server list. */
  onUpdate?: (iceServers: IceServerLike[]) => void;
  /** Fetch failures land here; the manager retries on a backoff. */
  onError?: (err: unknown) => void;
  /** Retry delay after a failed refresh. Default 5000, doubling to max 60000. */
  retryBaseMs?: number;
}

/** Hard cap for the failure backoff. */
const MAX_RETRY_MS = 60_000;

/** Keeps short-lived TURN credentials fresh: fetches on start, refreshes at 80% of
 *  TTL, and exposes the current iceServers for splicing into NEW peer connections
 *  (existing connections keep their config — WebRTC does not rotate mid-flight). */
export class TurnCredentialManager {
  private readonly getTurnCredentials: () => Promise<TurnCredentialsResponse>;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly refreshFraction: number;
  private readonly retryBaseMs: number;
  private readonly onUpdate: ((iceServers: IceServerLike[]) => void) | undefined;
  private readonly onError: ((err: unknown) => void) | undefined;

  private servers: IceServerLike[] = [];
  private ttl: number | null = null;
  private fairUse: number | null = null;
  private timer: TimeoutHandle | null = null;
  private retryDelayMs: number;
  private stopped = false;
  /** Bumped on every refresh/stop so stale in-flight results become no-ops. */
  private generation = 0;

  constructor(opts: TurnCredentialManagerOptions) {
    this.getTurnCredentials = opts.getTurnCredentials;
    this.setTimeoutFn = opts.setTimeoutFn;
    this.clearTimeoutFn = opts.clearTimeoutFn;
    this.refreshFraction = opts.refreshFraction ?? 0.8;
    this.retryBaseMs = opts.retryBaseMs ?? 5000;
    this.retryDelayMs = this.retryBaseMs;
    this.onUpdate = opts.onUpdate;
    this.onError = opts.onError;
  }

  /** Fetch once and begin the refresh cycle. Resolves after the first fetch attempt
   *  (successful or not — a failure schedules a retry and reports onError). */
  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
  }

  /** Cancel any pending timer and make in-flight results no-ops. */
  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearTimer();
  }

  /** Latest credentials; [] until the first successful fetch. */
  iceServers(): IceServerLike[] {
    return this.servers;
  }

  /** Remaining monthly TURN relay quota in GB; null when unmetered/unknown. */
  fairUseRemainingGb(): number | null {
    return this.fairUse;
  }

  /** TTL of the current credentials in seconds; null before the first success. */
  ttlSeconds(): number | null {
    return this.ttl;
  }

  private async refresh(): Promise<void> {
    const gen = ++this.generation;
    try {
      const res = await this.getTurnCredentials();
      if (this.stopped || gen !== this.generation) return;
      this.servers = res.iceServers;
      this.ttl = res.ttlSeconds;
      this.fairUse = res.fairUseRemainingGb;
      this.retryDelayMs = this.retryBaseMs;
      this.onUpdate?.(this.servers);
      // A ttl of 0 means "no expiry-driven refresh"; the credentials stay
      // usable and the cycle only resumes via a manual start().
      if (res.ttlSeconds > 0) {
        this.schedule(res.ttlSeconds * 1000 * this.refreshFraction);
      }
    } catch (err) {
      if (this.stopped || gen !== this.generation) return;
      this.onError?.(err);
      this.schedule(this.retryDelayMs);
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_MS);
    }
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.refresh();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }
}
