import { useState } from 'react';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';

export interface AvatarProps {
  /** Image URL; falls back to initials when absent or failing to load. */
  src?: string | null;
  name: string;
  /** Pixel size (hit-target rules do not apply — avatars are not controls). */
  size?: number;
  /** User accent color: paints the orb ring (DESIGN.md presence orbs). */
  accentColor?: string | null;
  speaking?: boolean;
  /**
   * The adjacent text already names this person, so the orb is a picture of a
   * fact the reader has just been told. Mirrors `<Artwork alt=''>` (DESIGN.md
   * §8.1) — the same decision, spelled the same way, for the same reason.
   *
   * The chat log is what this exists for: a message row is named "Message from
   * Robin", the byline under it says "Robin", and an orb announcing "Robin"
   * between them is the third time in one row. A presence orb in the call
   * surface or the people list is the opposite case — there the orb IS the
   * only name — so the default stays labelled.
   */
  decorative?: boolean;
  className?: string;
}

/**
 * Avatar orb with accent ring; `speaking` pulses a ring around it (DESIGN.md
 * §5.2, voice activity).
 *
 * ── Why the pulse is its own layer ────────────────────────────────────────
 * `animate-pulse-ring` used to sit on the orb itself, and that keyframe runs
 * opacity 0.6 → 0 and scale 0.9 → 1.8: a speaking member's avatar faded to
 * nothing and swelled to 1.8× on a 1.6s loop, forever. The ring is supposed to
 * expand; the face it belongs to is not. So the animation moved to a sibling
 * span, which also has to live OUTSIDE the clipped box — the image needs
 * `overflow-hidden` to be round, and a ring scaled past its parent is exactly
 * what that clip would eat.
 */
export function Avatar({
  src,
  name,
  size = 40,
  accentColor,
  speaking = false,
  decorative = false,
  className,
}: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const showImage = typeof src === 'string' && src.length > 0 && !broken;
  // `--accent`, not `--aurora-1`: the accent retints with the artwork in a
  // listen room (DESIGN.md §2.1) and an orb with no user colour should follow
  // the room rather than pin itself to the default violet.
  const ringColor = accentColor ?? 'var(--accent)';
  const ring = `0 0 0 2px ${ringColor}`;
  return (
    <span
      className={cn('relative inline-flex shrink-0 select-none', className)}
      style={{ width: size, height: size }}
      // A spread and not two conditional attributes: `role="img"` with no
      // label is worse than either state, and the pair only ever moves
      // together.
      {...(decorative
        ? ({ 'aria-hidden': true } as const)
        : ({ role: 'img', 'aria-label': name } as const))}
    >
      {speaking && (
        <span
          aria-hidden
          className="absolute inset-0 animate-pulse-ring rounded-full"
          style={{ boxShadow: ring }}
        />
      )}
      <span
        className={cn(
          // `bg-surface-2`, not `glass-raised`: an avatar is not floating over
          // video, and glass here meant the initials' legibility depended on
          // whatever happened to be behind the orb.
          'relative flex h-full w-full items-center justify-center overflow-hidden',
          'rounded-full bg-surface-2 font-display font-medium text-hi',
        )}
        style={{ fontSize: Math.max(11, Math.floor(size * 0.36)), boxShadow: ring }}
      >
        {showImage ? (
          // Plain img element: remote user avatars with explicit dimensions.
          <img
            src={src}
            alt=""
            width={size}
            height={size}
            className="h-full w-full object-cover"
            onError={() => {
              setBroken(true);
            }}
          />
        ) : (
          <span aria-hidden>{initials(name)}</span>
        )}
      </span>
    </span>
  );
}
