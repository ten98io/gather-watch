'use client';

import type { RoomId } from '@playin/contracts';

/**
 * WAVE-2 PLACEHOLDER — replaced wholesale by the queue worker.
 * Contract (binding): (props: { roomId: RoomId }) => JSX.Element.
 * Server events: queue.state; client events: queue.add/remove/reorder/voteSkip.
 */
export function QueuePane({ roomId }: { roomId: RoomId }) {
  return (
    <section aria-label="Queue" data-room={roomId} className="flex h-full flex-col p-4">
      <p className="text-sm text-low">The shared queue lands in wave 2 — add, reorder, vote-to-skip.</p>
    </section>
  );
}
