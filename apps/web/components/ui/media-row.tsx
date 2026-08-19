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
 *
 * A row that can be activated says so on its ARTWORK: the poster is what a
 * reader points at when they mean "play this", so that is where the play mark
 * goes. It is the only thing separating a list of media from a list of links,
 * and it costs no step — the click was already on the row body.
 */
import { isValidElement } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { Artwork } from '@/components/ui/artwork';
import type { ArtworkKind, ArtworkShape } from '@/components/ui/artwork';
import { PlayIcon } from '@/components/ui/icons';
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

/**
 * The play wash over the artwork — deliberately NOT `HOVER_REVEAL`.
 *
 * They look like the same problem and are opposites. `HOVER_REVEAL` is for
 * CONTROLS, which is why it stays visible where hover does not exist: a delete
 * button that only appears under a cursor does not exist on a phone (§10). This
 * is decoration over a picture — the row body is already the control and the
 * glyph is `aria-hidden` — so on touch it would simply sit on the artwork
 * forever, hiding the one thing the row is a picture of. Hover/focus only, and
 * that is correct here and nowhere near `actions`.
 */
const ARTWORK_PLAY_REVEAL =
  'opacity-0 transition-opacity duration-150 ' +
  'group-hover:opacity-100 group-focus-within:opacity-100';

/** Shorthand artwork: pass this instead of a node and MediaRow renders it. */
export interface MediaRowArtwork {
  src?: string | null;
  alt: string;
  kind: ArtworkKind;
  /**
   * Overrides the shape <Artwork> picks from `kind`. A 16:9 thumbnail is the
   * truer poster for a video, and in the 380px rail it is also 85px of a row
   * that has a title, a duration and two controls to fit — so the rail rows
   * ask for 'square' and let the provider word name the medium instead.
   */
  shape?: ArtworkShape;
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
  /** Secondary line — `text-low`. Provider · who added · a state chip. */
  meta?: ReactNode;
  /** Left of the artwork: the drag grabber, an index, a checkbox. */
  leading?: ReactNode;
  /**
   * Right of the title, ALWAYS visible: a runtime, a timestamp, a count. It is
   * separate from `actions` because those hide behind hover on a pointer
   * device, and a readout that vanishes when the cursor leaves is not a
   * readout — it is a control that has been mislabelled.
   */
  trailing?: ReactNode;
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
  trailing,
  actions,
  active = false,
  onActivate,
  activateLabel,
  className,
  ...rest
}: MediaRowProps) {
  const Root = as;
  const art = isArtworkSpec(artwork) ? (
    // Wrapped so the artwork can carry the play wash. `rounded-ctl` on the
    // wash is <Artwork>'s own default corner, and MediaRowArtwork exposes no
    // `rounded`, so the two cannot drift apart.
    <span className="relative shrink-0">
      <Artwork
        src={artwork.src ?? null}
        alt={artwork.alt}
        kind={artwork.kind}
        size={48}
        // exactOptionalPropertyTypes: an explicit `undefined` is not the same as
        // an absent prop, and <Artwork> derives the shape when it is absent.
        {...(artwork.shape !== undefined ? { shape: artwork.shape } : {})}
      />
      {onActivate !== undefined && (
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 grid place-items-center rounded-ctl',
            // The measured scrim and the absolute white, the same pair the
            // call tiles use: what is behind this is an arbitrary poster, so
            // neither half may invert with the theme.
            'bg-scrim text-[var(--ink-white)]',
            ARTWORK_PLAY_REVEAL,
          )}
        >
          <PlayIcon size={16} />
        </span>
      )}
    </span>
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

      {trailing !== undefined && trailing !== null && (
        <span className="shrink-0 text-label tabular-nums text-low">{trailing}</span>
      )}

      {actions !== undefined && actions !== null && (
        <span className={cn('flex shrink-0 items-center gap-1', HOVER_REVEAL)}>{actions}</span>
      )}
    </Root>
  );
}
