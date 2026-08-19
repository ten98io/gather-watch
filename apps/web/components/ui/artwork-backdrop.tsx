'use client';

/**
 * <ArtworkBackdrop> — the playing artwork, heavily blurred and veiled, behind
 * the listen composition (DESIGN.md §5.1, the first signature moment). This is
 * what "the room breathes with the media" is made of.
 *
 * Cross-fade: the outgoing image stays mounted while the incoming one fades in
 * over it, then the stack is pruned to the newest layer. Under reduced motion
 * the swap is instant and nothing animates.
 *
 * ── Why it is positioned in flow and not `fixed` at a negative z-index ────
 * It was `fixed inset-0 -z-10`, and on the only screen that mounts it it drew
 * NOTHING. A negative-z child paints above its stacking context's own
 * background and below every in-flow block background inside it — and the
 * stage section paints an opaque `bg-void`. So the first of the five signature
 * moments was written, correct, mounted, and invisible. Positioned in flow it
 * sits behind its own siblings and in front of the stage's ground, which is
 * where ambient light belongs.
 *
 * Contract for callers: mount it as the first child of a `relative` box and
 * give the content above it `z-10`. Never interactive, never in the a11y tree.
 */
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { cn } from '@/lib/cn';

/** Entrance duration for the cross-fade; matches `animate-fade-in`. */
const FADE_MS = 220;

/**
 * The veil, MEASURED rather than chosen — the same discipline `--scrim` is
 * held to, and for the mirror-image reason.
 *
 * Artwork is arbitrary: a cover can be pure white and a poster can be pure
 * black, and the listen composition sets its title, its provider line and its
 * up-next list straight on top of whichever one arrived. Composited against
 * both extremes in both themes, `--text-low` — the floor of the whole system —
 * holds 5.42:1 on dark and 4.77:1 on light at this value. At the 0.7 that
 * shipped it was 2.49:1 and 2.71:1: under AA against roughly half the album
 * covers in the world, on the one surface a listen room is mostly made of.
 * test/stage-artwork-veil.test.ts re-measures it and fails the build.
 *
 * 8% of an image through a 72px blur is still a great deal of hue. It sits in
 * the same band as the aurora drift (5%) and the grain (3.5%) on purpose: this
 * is ambient light, not a picture.
 */
export const BACKDROP_DIM = 0.92;

interface Layer {
  id: number;
  src: string;
}

export interface ArtworkBackdropProps {
  /** Artwork URL. Null/empty renders nothing but the veil-free void. */
  src?: string | null;
  /** Blur radius in px. Default 72 — the image must read as light, not detail. */
  blur?: number;
  /** Darkening veil, 0..1. Default `BACKDROP_DIM`; text sits on top of this. */
  dim?: number;
  className?: string;
}

export function ArtworkBackdrop({
  src,
  blur = 72,
  dim = BACKDROP_DIM,
  className,
}: ArtworkBackdropProps) {
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
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
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
