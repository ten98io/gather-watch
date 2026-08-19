/**
 * "The thing on the stage has no timeline" — published by the sync engine,
 * consumed by whatever chrome wants to say so.
 *
 * WHY A BUS AND NOT A RETURN VALUE. Liveness is DISCOVERED, not declared: a
 * YouTube live id parses like any other video and an `.m3u8` says nothing about
 * its own playlist, so the fact only exists once a player has the source open
 * (lib/player/adapter.ts `adapterIsLive`). The one place that already polls the
 * mounted adapter is useSyncEngine, and it is a hook that returns nothing on
 * purpose — the stage must not re-render because a correction pass ran. Same
 * shape and the same reasoning as lib/player/room-audio.ts.
 *
 * THE SIGNAL IS ONLY EVER TRUE WHILE SOMETHING IS DRIVING IT. The engine
 * republishes false whenever the player or the item changes and when it stops
 * driving at all, so a badge cannot outlive the stream it described.
 */
import { useSyncExternalStore } from 'react';

let live = false;
const listeners = new Set<() => void>();

/** Producer: lib/player/useSyncEngine.ts, once per correction pass. */
export function publishStageLive(value: boolean): void {
  if (live === value) return;
  live = value;
  // Copied: a subscriber that unsubscribes from its own callback must not make
  // the next one miss the edge.
  for (const listener of [...listeners]) {
    listener();
  }
}

export function getStageLive(): boolean {
  return live;
}

export function subscribeStageLive(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Nothing is live on the server: liveness is a fact about a mounted player,
 *  and there is none during a render that produces HTML. */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * Is the stage showing a live stream? For chrome that has to tell the two
 * apart — a badge instead of a position, since nobody in the room is at a
 * shared offset and the transport has no length to scrub within.
 */
export function useStageIsLive(): boolean {
  return useSyncExternalStore(subscribeStageLive, getStageLive, getServerSnapshot);
}

/** Test seam: drop the signal and every subscriber. */
export function resetStageLive(): void {
  live = false;
  listeners.clear();
}
