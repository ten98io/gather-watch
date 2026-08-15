'use client';

import type { RoomId } from '@playin/contracts';

/**
 * WAVE-2 PLACEHOLDER — replaced wholesale by the chat worker.
 * Contract (binding): (props: { roomId: RoomId }) => JSX.Element.
 * Shared socket: useRoomConnection() from '@/lib/room-context';
 * history: api.messages.listMessages(roomId, { beforeSeq, limit }).
 */
export function ChatPane({ roomId }: { roomId: RoomId }) {
  return (
    <section aria-label="Chat" data-room={roomId} className="flex h-full flex-col p-4">
      <p className="text-sm text-low">Full chat lands in wave 2 — text, GIFs, voice notes, receipts, emotes.</p>
    </section>
  );
}
