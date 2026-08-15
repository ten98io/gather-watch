'use client';

/**
 * EmoteOverlay — ephemeral emote bursts floating up over the stage
 * (DESIGN.md §5.3): spring scale-in, slight horizontal drift, 2.5 s fade.
 * Reduced-motion: no drift/rise, opacity fade only (§6).
 */
import { AnimatePresence, motion } from 'framer-motion';
import { useRoomConnection } from '@/lib/room-context';
import { useReducedMotion } from '@/hooks/useReducedMotion';

export function EmoteOverlay() {
  const connection = useRoomConnection();
  const emotes = connection.useRoomState((s) => s.emotes);
  const reduced = useReducedMotion();

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      <AnimatePresence>
        {emotes.map((e) => (
          <motion.span
            key={e.id}
            className="absolute text-3xl"
            style={{ left: `${e.xPct}%`, top: `${e.yPct}%` }}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 0, scale: 0.6 }}
            animate={
              reduced
                ? { opacity: 1 }
                : {
                    opacity: [1, 1, 0],
                    y: -120,
                    x: (e.id % 2 === 0 ? 1 : -1) * 16,
                    scale: [1, 1, 0.9],
                    transition: {
                      duration: 2.4,
                      scale: { type: 'spring', stiffness: 260, damping: 30 },
                    },
                  }
            }
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
          >
            {e.emoji}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}
