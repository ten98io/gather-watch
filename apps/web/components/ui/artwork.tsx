'use client';

/**
 * <Artwork> — the poster/thumbnail primitive (DESIGN.md §4).
 *
 * It never renders an empty box. With no `src`, a broken `src`, or an image
 * still in flight, it shows a deterministic gradient derived from a hash of the
 * `alt` text plus the provider glyph — so a queue of un-enriched items still
 * reads as a wall of content instead of a wall of grey squares.
 *
 * Plain <img>, not next/image: artwork comes from arbitrary remote hosts
 * (YouTube, SoundCloud, Vimeo, user uploads) which next/image would require to
 * be allow-listed in next.config, and the optimizer buys us nothing for a 48px
 * thumbnail we already size exactly.
 */
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { artworkGradient } from '@/lib/artwork-color';
import { cn } from '@/lib/cn';
import { FilmIcon, MusicIcon } from '@/components/ui/icons';

export type ArtworkKind = 'video' | 'music';
export type ArtworkSize = 40 | 48 | 64 | 96 | 'full';
export type ArtworkShape = 'square' | 'video';
export type ArtworkRadius = 'sm' | 'ctl' | 'card' | 'panel' | 'full';

export interface ArtworkProps {
  /** Poster/thumbnail URL. Null, empty or broken → deterministic placeholder. */
  src?: string | null;
  /** Describes the item; also the placeholder gradient's seed. '' = decorative. */
  alt: string;
  kind: ArtworkKind;
  /** Fixed height in px, or 'full' to fill the container width. Default 48. */
  size?: ArtworkSize;
  /** Aspect. Defaults to 'square' for music and 16:9 'video' for video. */
  shape?: ArtworkShape;
  /** Corner radius token. Default 'ctl' (12px). */
  rounded?: ArtworkRadius;
  className?: string;
}

/** Glyph size per artwork size — the icon reads as a watermark, not a control. */
const GLYPH_SIZE: Record<'40' | '48' | '64' | '96' | 'full', number> = {
  '40': 16,
  '48': 20,
  '64': 24,
  '96': 32,
  full: 40,
};

const RADIUS_CLASS: Record<ArtworkRadius, string> = {
  sm: 'rounded-sm',
  ctl: 'rounded-ctl',
  card: 'rounded-card',
  panel: 'rounded-panel',
  full: 'rounded-full',
};

export function Artwork({
  src,
  alt,
  kind,
  size = 48,
  shape,
  rounded = 'ctl',
  className,
}: ArtworkProps) {
  // Tracking the failed URL (rather than a boolean) resets the fallback for
  // free when the item's artwork changes — no effect, no stale error state.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const isSquare = (shape ?? (kind === 'music' ? 'square' : 'video')) === 'square';
  const hasImage = typeof src === 'string' && src.length > 0 && src !== failedSrc;
  const Glyph = kind === 'music' ? MusicIcon : FilmIcon;
  const decorative = alt.length === 0;
  const gradient = artworkGradient(decorative ? (src ?? 'gather') : alt);

  // Fixed sizes get explicit dimensions so the row never reflows while the
  // image loads; 'full' fills its container and takes height from the aspect.
  const style: CSSProperties =
    size === 'full'
      ? { backgroundImage: gradient.css }
      : {
          backgroundImage: gradient.css,
          height: size,
          width: isSquare ? size : Math.round((size * 16) / 9),
        };

  // Announce the item once: the <img> carries `alt`, the placeholder carries a
  // role, and a decorative artwork (alt='') is hidden from the tree entirely.
  const a11y =
    decorative
      ? ({ 'aria-hidden': true } as const)
      : hasImage
        ? {}
        : ({ role: 'img', 'aria-label': alt } as const);

  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden',
        isSquare ? 'aspect-square' : 'aspect-video',
        size === 'full' && 'w-full',
        RADIUS_CLASS[rounded],
        className,
      )}
      style={style}
      {...a11y}
    >
      {hasImage ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedSrc(src)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-white/55">
          <Glyph size={GLYPH_SIZE[size === 'full' ? 'full' : (String(size) as '40' | '48' | '64' | '96')]} />
        </span>
      )}
    </div>
  );
}
