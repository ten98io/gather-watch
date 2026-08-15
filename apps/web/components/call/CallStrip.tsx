'use client';

import type { RoomId } from '@playin/contracts';

/**
 * WAVE-2 PLACEHOLDER — replaced wholesale by the call worker.
 * Contract (binding): (props: { roomId: RoomId }) => JSX.Element.
 * Docked above the right rail (desktop) / above the bottom sheet (mobile):
 * PiP presence orbs + mic/cam toggles. TURN: GET /rtc/turn-credentials.
 */
export function CallStrip({ roomId }: { roomId: RoomId }) {
  return (
    <section aria-label="Call" data-room={roomId} className="flex items-center gap-2 p-3">
      <p className="text-xs text-low">Calls land in wave 2 — E2E mesh, PiP orbs.</p>
    </section>
  );
}
