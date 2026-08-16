'use client';

/**
 * <ArtworkBackdrop> — the current artwork, heavily blurred and darkened, behind
 * the whole page (DESIGN.md §4). This one component does most of the work of
 * making a listen room feel like a different product from a watch room.
 *
 * Cross-fade: the outgoing image stays mounted while the incoming one fades in
 * over it, then the stack is pruned to the newest layer. Under reduced motion
 * the swap is instant and nothing animates.
 *
 * Fixed and behind everything (negative z-index, like .void-aurora), never
 * interactive, never in the accessibility tree. Mount it near the page root: an
 * ancestor that both creates a stacking context (transform/filter/opacity) and
 * paints an opaque background would hide it.
 */
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { cn } from '@/lib/cn';

/** Entrance duration for the cross-fade; matches `animate-fade-in`. */
const FADE_MS = 220;

interface Layer {
  id: number;
  src: string;
}

export interface ArtworkBackdropProps {
  /** Artwork URL. Null/empty renders nothing but the veil-free void. */
  src?: string | null;
  /** Blur radius in px. Default 72 — the image must read as light, not detail. */
  blur?: number;
  /** Darkening veil, 0..1. Default 0.7; text sits on top of this. */
  dim?: number;
  className?: string;
}

export function ArtworkBackdrop({ src, blur = 72, dim = 0.7, className }: ArtworkBackdropProps) {
  const reducedMotion = useReducedMotion();
  const [layers, setLayers] = useState<Layer[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    const next = typeof src === 'string' && src.length > 0 ? src : null;
    setLayers((current) => {
      const top = current[current.length - 1];
      if (next === null) return current.length === 0 ? current : [];
      if (top !== undefined && top.src === next) return current;
      nextId.current += 1;
      // Keep at most the outgoing layer plus the incoming one.
      const tail = top === undefined ? [] : [top];
      return [...tail, { id: nextId.current, src: next }];
    });
  }, [src]);

  // Once the fade has landed, drop the outgoing layer so we never keep a stack.
  useEffect(() => {
    if (layers.length < 2) return undefined;
    const timer = window.setTimeout(
      () => setLayers((current) => current.slice(-1)),
      reducedMotion ? 0 : FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [layers, reducedMotion]);

  return (
    <div
      aria-hidden
      className={cn('pointer-events-none fixed inset-0 -z-10 overflow-hidden', className)}
    >
      {layers.map((layer, index) => (
        <div
          key={layer.id}
          className={cn(
            'absolute inset-0 bg-cover bg-center',
            // Only the incoming layer animates; the outgoing one just sits there
            // at full opacity underneath until the prune drops it.
            index === layers.length - 1 && !reducedMotion && 'animate-fade-in',
          )}
          style={{
            // Escape quotes/backslashes only — encodeURI would double-encode an
            // already-escaped artwork URL.
            backgroundImage: `url("${layer.src.replace(/["\\]/g, '\\$&')}")`,
            filter: `blur(${blur}px) saturate(1.4)`,
            // Scale past the blur radius so the edges never show the void.
            transform: 'scale(1.2)',
          }}
        />
      ))}
      <div className="absolute inset-0 bg-void" style={{ opacity: dim }} />
    </div>
  );
}
