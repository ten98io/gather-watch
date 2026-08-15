'use client';

import type { RoomId } from '@playin/contracts';

/**
 * WAVE-2 PLACEHOLDER — replaced wholesale by the people worker.
 * Contract (binding): (props: { roomId: RoomId }) => JSX.Element.
 * Members: api.rooms.listMembers(roomId); live state: presence.state/diff.
 */
export function PeoplePane({ roomId }: { roomId: RoomId }) {
  return (
    <section aria-label="People" data-room={roomId} className="flex h-full flex-col p-4">
      <p className="text-sm text-low">The member list lands in wave 2 — roles, presence, kick/ban.</p>
    </section>
  );
}
