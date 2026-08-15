/**
 * Per-app-instance realtime runtime for the rooms module. Memoized on the
 * Deps object (one per app instance / test harness) so REST routes, ws
 * handlers, and tests all reach the SAME PresenceTracker through `deps`, and
 * the runtime is GC'd with its deps.
 */
import type { Deps } from '../types';
import { PresenceTracker } from './presence';

export interface RoomsRuntime {
  presence: PresenceTracker;
  close(): Promise<void>;
}

const runtimes = new WeakMap<Deps, RoomsRuntime>();

export function getRoomsRuntime(deps: Deps): RoomsRuntime {
  const existing = runtimes.get(deps);
  if (existing !== undefined) {
    return existing;
  }
  const presence = new PresenceTracker(deps);
  const runtime: RoomsRuntime = {
    presence,
    close: () => presence.close(),
  };
  runtimes.set(deps, runtime);
  return runtime;
}
