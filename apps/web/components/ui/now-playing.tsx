/**
 * <NowPlaying> — what is playing, as content rather than chrome (DESIGN.md §4).
 *
 * `hero` is the listen composition's centrepiece: oversized artwork, a provider
 * overline, the title at the display step, progress. `compact` is the same
 * information in a 48px row for watch rooms and mini-players. Purely
 * presentational — the progress bar reports position, it does not seek;
 * transport controls come in through `actions`.
 *
 * The fill uses `bg-accent`, so a listen room that rebinds `--accent` to the
 * artwork's dominant colour (lib/artwork-color.ts) retints it for free.
 *
 * ── The one display setting on the screen ────────────────────────────────
 * `hero` spends `text-display` (DESIGN.md §3), and a screen gets exactly one.
 * That is affordable here because the hero is the answer to "what is this
 * screen about" — the room is playing this track — and because the only
 * surface that mounts it is the listen composition, which is the whole stage
 * when it is up. `compact` deliberately does NOT take the step: it is a row,
 * and two display settings on one screen is the failure §10 names.
 */
import type { ReactNode } from 'react';
import { Artwork } from '@/components/ui/artwork';
import type { ArtworkKind } from '@/components/ui/artwork';
import { formatDurationMs } from '@/lib/format';
import { cn } from '@/lib/cn';

export type NowPlayingVariant = 'hero' | 'compact';

export interface NowPlayingProps {
  title: string;
  kind: ArtworkKind;
  artworkUrl?: string | null;
  /** Human provider name — 'YouTube', 'Web page'. Never a raw enum value. */
  provider?: string | null;
  /** Anything else worth one line: who added it, album, uploader. */
  meta?: ReactNode;
  positionMs?: number | null;
  durationMs?: number | null;
  /** Default 'compact'. */
  variant?: NowPlayingVariant;
  /** Default true. Set false when a real transport below owns progress and
   *  seeking — two progress bars for one track is the same duplicate-control
   *  mistake as two play buttons. */
  showProgress?: boolean;
  /** Transport controls, like/queue buttons — rendered next to the text. */
  actions?: ReactNode;
  className?: string;
}

function progressPercent(positionMs: number | null, durationMs: number | null): number | null {
  if (positionMs === null || durationMs === null || durationMs <= 0) return null;
  const ratio = positionMs / durationMs;
  if (!Number.isFinite(ratio)) return null;
  return Math.min(100, Math.max(0, ratio * 100));
}

function Progress({
  positionMs,
  durationMs,
  showTimes,
}: {
  positionMs: number | null;
  durationMs: number | null;
  showTimes: boolean;
}) {
  const percent = progressPercent(positionMs, durationMs);
  return (
    <div className="flex w-full flex-col gap-1">
      <div
        role="progressbar"
        aria-label="Playback progress"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent !== null
          ? {
              'aria-valuenow': Math.round(percent),
              'aria-valuetext': `${formatDurationMs(positionMs ?? 0)} of ${formatDurationMs(
                durationMs ?? 0,
              )}`,
            }
          : {})}
        className="h-1 w-full overflow-hidden rounded-full bg-hairline"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150"
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
      {showTimes && (
        <div className="flex items-center justify-between text-label tabular-nums text-low">
          <span>{formatDurationMs(positionMs ?? 0)}</span>
          <span>{durationMs === null ? '--:--' : formatDurationMs(durationMs)}</span>
        </div>
      )}
    </div>
  );
}

export function NowPlaying({
  title,
  kind,
  artworkUrl,
  provider,
  meta,
  positionMs = null,
  durationMs = null,
  variant = 'compact',
  showProgress = true,
  actions,
  className,
}: NowPlayingProps) {
  const position = positionMs ?? null;
  const duration = durationMs ?? null;
  const providerLine =
    provider !== null && provider !== undefined && provider.length > 0 ? provider : null;

  if (variant === 'hero') {
    return (
      <section className={cn('flex w-full flex-col items-center gap-6', className)}>
        {/* ── The artwork is capped; the section is not ─────────────────────
            `size="full"` means the cover fills its container, and a square's
            HEIGHT follows its width — so the only thing stopping an oversized
            cover from pushing the transport off a short stage is a cap on the
            box it fills. It lives here and not on the caller's column because
            the two want different widths: the cover has to stay inside the
            stage, while the title and whatever transport sits under it want the
            whole measure. Capping the column instead is what squeezed a
            ten-control transport bar into 384px and wrapped it onto three rows.
            24rem is the ceiling on a tall display; 38vh is what actually binds
            on a laptop, and in fullscreen — where the stage IS the viewport —
            it is exactly right.

            `stage`, the 28px rung — DESIGN.md §4 names now-playing artwork as
            one of the two surfaces it exists for. Glow is allowed here and
            almost nowhere else: this is signature moment §5.1. */}
        <div className="w-full max-w-[min(24rem,38vh)]">
          <Artwork
            src={artworkUrl ?? null}
            alt={title}
            kind={kind}
            size="full"
            rounded="stage"
            className="shadow-glow-lg"
          />
        </div>
        {/* Overline and title are ONE unit and sit tight together; the gap that
            says "a new thing starts here" is the one above, not between them. */}
        <div className="flex w-full flex-col items-center gap-2 text-center">
          {providerLine !== null && <p className="text-caption text-low">{providerLine}</p>}
          <h2 className="line-clamp-2 text-headline text-hi md:text-display">{title}</h2>
          {meta !== undefined && meta !== null && (
            <p className="truncate text-label text-low">{meta}</p>
          )}
        </div>
        {showProgress && <Progress positionMs={position} durationMs={duration} showTimes />}
        {actions !== undefined && (
          <div className="flex items-center justify-center gap-2">{actions}</div>
        )}
      </section>
    );
  }

  const metaLine = meta ?? providerLine;
  return (
    <section className={cn('flex w-full items-center gap-3', className)}>
      <Artwork src={artworkUrl ?? null} alt={title} kind={kind} size={48} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate text-body text-hi">{title}</p>
        {metaLine !== null && <p className="truncate text-label text-low">{metaLine}</p>}
        {showProgress && (
          <Progress positionMs={position} durationMs={duration} showTimes={false} />
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </section>
  );
}
