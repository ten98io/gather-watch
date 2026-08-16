'use client';

/**
 * ListenStage — the listen room's own composition (UX_OVERHAUL D3 / bug B3).
 *
 * A listen room is not a watch room with a different tile in the middle. There
 * is no letterboxed video surface to protect, so the whole stage is rebuilt
 * around the artwork: a blurred backdrop of the current track, a centred hero
 * column (large square art, title, provider, transport inline beneath it), a
 * visualiser as a supporting element, and up-next as a track list rather than a
 * video queue.
 *
 * Everything colours off `--accent`, which is rebound per track to the
 * artwork's dominant colour (lib/artwork-color.ts). `--accent` is `--aurora-1`
 * globally, so extraction failing — a CORS-tainted canvas, a broken image, SSR
 * — silently lands back on the aurora accent rather than an empty variable.
 *
 * The visualiser taps the real <audio>/<video> element through WebAudio, which
 * only works for CORS-clean sources; anything else honestly renders the static
 * glow instead of fake bars.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { QueueItem } from '@gather/contracts';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import type { PlayerAdapter } from '@/lib/player/adapter';
import type { NativeAdapter } from '@/lib/player/native';
import { ARTWORK_FALLBACK_ACCENT, loadArtworkAccent } from '@/lib/artwork-color';
import { providerLabel } from '@/lib/labels';
import { formatMs } from '@/lib/permissions';
import { ArtworkBackdrop } from '@/components/ui/artwork-backdrop';
import { EmptyState } from '@/components/ui/empty-state';
import { MediaRow } from '@/components/ui/media-row';
import { NowPlaying } from '@/components/ui/now-playing';
import { MusicIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

const BAR_COUNT = 32;
/** Up-next stays a glanceable list, not a second queue pane. */
const UP_NEXT_LIMIT = 4;

/**
 * Resolve `--accent` to a concrete `rgb(...)` for canvas painting. Canvas
 * fillStyle cannot read a CSS custom property, and oklch() support in canvas is
 * uneven, so the colour is laundered through a computed `color` on the element
 * itself — that always resolves to an rgb triple the 2D context accepts.
 */
function resolveAccentRgb(el: HTMLElement): [number, number, number] {
  const computed = getComputedStyle(el).color;
  const parts = computed.match(/[\d.]+/g);
  if (parts === null || parts.length < 3) return [168, 85, 247]; // aurora-1
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/**
 * The visualiser is a supporting element: it reinforces the artwork's colour
 * and shows that audio is really moving, so it never competes with the hero.
 */
function Visualizer({
  adapter,
  playing,
  accent,
}: {
  adapter: PlayerAdapter | null;
  playing: boolean;
  /** Only a repaint trigger — the colour is read off the canvas itself. */
  accent: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduced = useReducedMotion();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (reduced || adapter === null || adapter.kind !== 'native') return;
    const el = (adapter as NativeAdapter).mediaElement;
    let raf = 0;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;

    try {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaElementSource(el);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      setLive(true);
    } catch {
      // Element already tapped elsewhere, or CORS-tainted — static glow only.
      setLive(false);
      return;
    }

    const data = new Uint8Array(analyser.frequencyBinCount);
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d') ?? null;
    if (canvas === null || ctx === null) return;

    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      if (analyser === null) return;
      analyser.getByteFrequencyData(data);
      // Re-read per frame: the accent changes on track change, and this is one
      // getComputedStyle against an element whose style is already resolved.
      const [r, g, b] = resolveAccentRgb(canvas);
      const barW = width / BAR_COUNT;
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const v = (data[i] ?? 0) / 255;
        const h = Math.max(2, v * height);
        const grad = ctx.createLinearGradient(0, height - h, 0, height);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.9)`);
        grad.addColorStop(0.7, `rgba(${r}, ${g}, ${b}, 0.45)`);
        grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.15)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(i * barW + 1, height - h, barW - 2, h, 3);
        ctx.fill();
      }
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      void audioCtx?.close().catch(() => undefined);
    };
  }, [adapter, reduced]);

  return (
    <canvas
      ref={canvasRef}
      width={512}
      height={96}
      aria-hidden
      // `color` is what resolveAccentRgb reads; it paints nothing by itself.
      // The transition lives here rather than on the --accent variable: custom
      // properties are not animatable, but `color` is, so the computed value
      // this reads each frame interpolates across a track change for free.
      style={{ color: accent, transition: 'color 500ms ease' }}
      className={cn(
        'h-16 w-full max-w-sm transition-opacity duration-500',
        live && playing ? 'opacity-100' : 'opacity-25',
      )}
    />
  );
}

export function ListenStage({
  adapter,
  currentItem,
  playing,
  queueItems,
  currentIndex,
  transport,
  blocked = false,
  onActivate,
}: {
  adapter: PlayerAdapter | null;
  currentItem: QueueItem | undefined;
  playing: boolean;
  /** The whole queue — up-next is derived from the playing index. */
  queueItems: readonly QueueItem[];
  /** Index of `currentItem` in `queueItems`, or null when nothing is playing. */
  currentIndex: number | null;
  /** The room's real transport, rendered inline under the hero. */
  transport?: ReactNode;
  /** This browser refused to start playback; only a user gesture can fix it. */
  blocked?: boolean;
  /** Runs that gesture — recovers the refused start on this device. */
  onActivate?: () => void;
}) {
  const artworkUrl = currentItem?.artworkUrl ?? null;
  const [accent, setAccent] = useState<string>(ARTWORK_FALLBACK_ACCENT);

  // Extraction is async and per track. The guard drops a late resolution from a
  // previous track so a slow image can never repaint the current one's accent.
  useEffect(() => {
    let cancelled = false;
    void loadArtworkAccent(artworkUrl).then((next) => {
      if (!cancelled) setAccent(next);
    });
    return () => {
      cancelled = true;
    };
  }, [artworkUrl]);

  const upNext = useMemo(
    () =>
      currentIndex === null
        ? queueItems.slice(0, UP_NEXT_LIMIT)
        : queueItems.slice(currentIndex + 1, currentIndex + 1 + UP_NEXT_LIMIT),
    [queueItems, currentIndex],
  );

  return (
    <div
      // Rebinding --accent here retints everything below it that uses the token:
      // the seek bar, the visualiser, and MediaRow's active edge.
      style={{ '--accent': accent } as CSSProperties}
      className="relative flex h-full w-full flex-col overflow-hidden"
    >
      <ArtworkBackdrop src={artworkUrl} />

      {/* The scroll port and the centring are separate elements on purpose.
          `justify-center` on a scrolling box clips overflow at the top and
          puts it out of reach of the scrollbar; centring an inner min-h-full
          column centres while it fits and scrolls from the top once hero,
          transport and up-next together outgrow the stage. */}
      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full w-full flex-col items-center justify-center gap-5 px-4 py-6">
          {currentItem === undefined ? (
            <EmptyState
              icon={<MusicIcon size={22} />}
              title="Nothing playing yet"
              description="Add a track from the Queue tab — everyone hears the same beat, in time."
            />
          ) : (
            <>
              {/* Hero: one column, narrow enough to work on a phone. */}
              <div className="flex w-full max-w-[19rem] flex-col items-center gap-4 sm:max-w-sm">
                <NowPlaying
                  variant="hero"
                  showProgress={false}
                  title={currentItem.title}
                  kind="music"
                  artworkUrl={artworkUrl}
                  provider={providerLabel(currentItem.mediaRef)}
                />
                {/* Inline, not a floating video-style bar: nothing here needs to
                    get out of the way of moving picture. */}
                {transport !== undefined && <div className="w-full">{transport}</div>}

                {/* Autoplay reality: the room is playing but this browser refused
                    to start. One plain affordance, never a silent dead player. */}
                {blocked && onActivate !== undefined && (
                  <button
                    type="button"
                    onClick={onActivate}
                    className="glass-raised w-full rounded-ctl px-3 py-2 text-body text-hi transition-colors hover:text-accent"
                  >
                    Tap to start listening together
                  </button>
                )}
              </div>

              <Visualizer adapter={adapter} playing={playing} accent={accent} />
            </>
          )}

          {upNext.length > 0 && (
            <section className="w-full max-w-sm" aria-label="Up next">
              <h3 className="px-1 pb-1 text-label uppercase tracking-wide text-low">Up next</h3>
              <ul className="flex flex-col">
                {upNext.map((item) => (
                  <MediaRow
                    as="li"
                    key={item.id}
                    artwork={{ src: item.artworkUrl, alt: item.title, kind: 'music' }}
                    title={item.title}
                    meta={
                      item.durationMs === null
                        ? providerLabel(item.mediaRef)
                        : `${providerLabel(item.mediaRef)} · ${formatMs(item.durationMs)}`
                    }
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
