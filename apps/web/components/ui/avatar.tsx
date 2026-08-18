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
  className?: string;
}

/** Avatar orb with accent ring; `speaking` pulses the ring (voice activity). */
export function Avatar({ src, name, size = 40, accentColor, speaking = false, className }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const showImage = typeof src === 'string' && src.length > 0 && !broken;
  const ringColor = accentColor ?? 'var(--aurora-1)';
  return (
    <span
      className={cn(
        // `bg-surface-2`, not `glass-raised`: an avatar is not floating over
        // video, and glass here meant the initials' legibility depended on
        // whatever happened to be behind the orb.
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-surface-2 font-display font-medium text-hi',
        speaking === true && 'animate-pulse-ring',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, Math.floor(size * 0.36)),
        boxShadow: `0 0 0 2px ${ringColor}`,
      }}
      role="img"
      aria-label={name}
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
  );
}
