'use client';

import type { RoomId } from '@playin/contracts';
import { useRoomConnection } from '@/lib/room-context';

/**
 * WAVE-2 PLACEHOLDER — replaced wholesale by the stage worker.
 * Contract (binding): (props: { roomId: RoomId }) => JSX.Element.
 * Consume the shared socket via useRoomConnection() from '@/lib/room-context'.
 */
export function StagePane({ roomId }: { roomId: RoomId }) {
  const connection = useRoomConnection();
  const status = connection.useStatus();
  return (
    <section
      aria-label="Stage"
      data-room={roomId}
      className="flex h-full w-full items-center justify-center"
    >
      <div className="glass-panel flex flex-col items-center gap-2 p-8 text-center">
        <p className="font-display text-lg font-semibold text-hi">The stage floats here</p>
        <p className="text-sm text-mid">
          Synced playback lands in wave 2. Socket: <span className="font-mono text-xs">{status}</span>
        </p>
      </div>
    </section>
  );
}
