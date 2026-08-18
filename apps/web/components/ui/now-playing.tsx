/**
 * <NowPlaying> — what is playing, as content rather than chrome (DESIGN.md §4).
 *
 * `hero` is the listen-room centrepiece: large artwork, title, provider,
 * progress. `compact` is the same information in a 48px row for watch rooms and
 * mini-players. Purely presentational — the progress bar reports position, it
 * does not seek; transport controls come in through `actions`.
 *
 * The fill uses `bg-accent`, so a listen room that rebinds `--accent` to the
 * artwork's dominant colour (lib/artwork-color.ts) retints it for free.
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
  const metaLine =
    meta ??
    (provider !== null && provider !== undefined && provider.length > 0 ? provider : null);

  if (variant === 'hero') {
    return (
      <section className={cn('flex w-full flex-col items-center gap-4', className)}>
        <Artwork
          src={artworkUrl ?? null}
          alt={title}
          kind={kind}
          size="full"
          rounded="panel"
          className="shadow-glow-lg"
        />
        <div className="flex w-full flex-col items-center gap-1 text-center">
          <h2 className="line-clamp-2 text-title text-hi">{title}</h2>
          {metaLine !== null && <p className="truncate text-label text-low">{metaLine}</p>}
        </div>
        {showProgress && <Progress positionMs={position} durationMs={duration} showTimes />}
        {actions !== undefined && (
          <div className="flex items-center justify-center gap-2">{actions}</div>
        )}
      </section>
    );
  }

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
