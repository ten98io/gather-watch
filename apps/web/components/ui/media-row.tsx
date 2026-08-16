'use client';

/**
 * <MediaRow> — the single row primitive for the queue, history, search results
 * and playlist import (DESIGN.md §4). Artwork + title + meta line + hover
 * actions, 56px tall, with the drag/keyboard passthroughs the queue needs.
 *
 * Everything about a row is a slot: `leading` is the grabber, `actions` is the
 * hover-revealed right side, `meta` is whatever the caller wants to show under
 * the title. The row owns layout, the active treatment and the hover-reveal
 * cascade; it owns none of the behaviour.
 */
import { isValidElement } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { Artwork } from '@/components/ui/artwork';
import type { ArtworkKind } from '@/components/ui/artwork';
import { cn } from '@/lib/cn';

/**
 * Row affordances are revealed on hover, but hover does not exist on touch —
 * so they stay visible by default and only hide behind hover on pointers that
 * actually have it. Focus (keyboard) reveals them in both worlds.
 *
 * The two `group-focus-within:opacity-100` entries are NOT a duplicate to be
 * tidied away: the unprefixed one wins on touch, and the `[@media(hover:hover)]`
 * one has to come after `[@media(hover:hover)]:opacity-0` in source order to
 * beat it inside the media query. Removing either breaks a real device class.
 * Exported so every row-like surface uses the same cascade.
 */
export const HOVER_REVEAL =
  'opacity-100 transition-opacity duration-150 group-focus-within:opacity-100 ' +
  '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 ' +
  '[@media(hover:hover)]:group-focus-within:opacity-100';

/** Shorthand artwork: pass this instead of a node and MediaRow renders it. */
export interface MediaRowArtwork {
  src?: string | null;
  alt: string;
  kind: ArtworkKind;
}

export interface MediaRowProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Row element. Use 'li' inside a <ul>. Default 'div'. */
  as?: 'div' | 'li';
  /** `{src, alt, kind}` for the default 48px thumbnail, or any node. */
  artwork?: ReactNode | MediaRowArtwork;
  /** Primary line — `text-hi`, truncated to `titleLines`. */
  title: ReactNode;
  /** 1 (default) or 2 lines before truncation. */
  titleLines?: 1 | 2;
  /** Secondary line — `text-low`. Provider · duration · who added. */
  meta?: ReactNode;
  /** Left of the artwork: the drag grabber, an index, a checkbox. */
  leading?: ReactNode;
  /** Right side, hidden until hover/focus on pointer devices. */
  actions?: ReactNode;
  /** Playing / selected: surface-3 plus a 3px accent left edge. */
  active?: boolean;
  /** Click/Enter on the row body. Omit for a non-interactive row. */
  onActivate?: (() => void) | undefined;
  /** aria-label for the row body button — say what activating it does. */
  activateLabel?: string;
}

function isArtworkSpec(value: ReactNode | MediaRowArtwork): value is MediaRowArtwork {
  return (
    typeof value === 'object' &&
    value !== null &&
    !isValidElement(value) &&
    'kind' in value &&
    'alt' in value
  );
}

export function MediaRow({
  as = 'div',
  artwork,
  title,
  titleLines = 1,
  meta,
  leading,
  actions,
  active = false,
  onActivate,
  activateLabel,
  className,
  ...rest
}: MediaRowProps) {
  const Root = as;
  const art = isArtworkSpec(artwork) ? (
    <Artwork src={artwork.src ?? null} alt={artwork.alt} kind={artwork.kind} size={48} />
  ) : (
    artwork
  );

  const body = (
    <>
      {art}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={cn(
            'text-body text-hi',
            titleLines === 2 ? 'line-clamp-2' : 'truncate',
          )}
        >
          {title}
        </span>
        {meta !== undefined && meta !== null && (
          <span className="truncate text-label text-low">{meta}</span>
        )}
      </span>
    </>
  );

  const bodyClass = 'flex min-w-0 flex-1 items-center gap-3 rounded-ctl text-left';

  return (
    <Root
      className={cn(
        'group relative flex min-h-row items-center gap-3 rounded-card px-2 py-2',
        'transition-colors duration-150',
        // Elevation, not borders: rows sit on the ground and step up on
        // hover/active. Hover only lifts where hover actually exists.
        active ? 'bg-surface-3' : '[@media(hover:hover)]:hover:bg-surface-2',
        className,
      )}
      {...(active ? { 'aria-current': true } : {})}
      {...rest}
    >
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-2 left-0 w-edge rounded-r-full bg-accent"
        />
      )}

      {leading !== undefined && leading !== null && (
        <span className="flex shrink-0 items-center">{leading}</span>
      )}

      {onActivate !== undefined ? (
        <button
          type="button"
          onClick={onActivate}
          className={bodyClass}
          {...(activateLabel !== undefined ? { 'aria-label': activateLabel } : {})}
        >
          {body}
        </button>
      ) : (
        <div className={bodyClass}>{body}</div>
      )}

      {actions !== undefined && actions !== null && (
        <span className={cn('flex shrink-0 items-center gap-1', HOVER_REVEAL)}>{actions}</span>
      )}
    </Root>
  );
}
