'use client';

/**
 * ListenStage — the listen composition (DESIGN.md §11 D3, §7).
 *
 * A music item is not a video item with a different tile in the middle. There
 * is no letterboxed picture to protect, so the stage is rebuilt around the
 * artwork: a blurred backdrop of the current track, an oversized hero column
 * (large square art, provider, the title at the display step, the transport
 * inline beneath it, the visualiser under that), and up-next promoted to a
 * track list BESIDE the hero rather than stacked under it — which is what §7
 * means by "queue is promoted next to it".
 *
 * ── The composition is two columns, and the breakpoint is `xl` ────────────
 * Below `xl` the stage is narrower than the rail leaves room for (a 1280px
 * window is a ~880px stage; a 1024px one is ~620px), so the columns stack and
 * the hero keeps the whole width. Above it they sit side by side, vertically
 * centred, separated by `section` — the rung that means "two blocks of one
 * composition" rather than two things that happen to be adjacent.
 *
 * Everything colours off `--accent`, which is rebound per track to the
 * artwork's dominant colour (lib/artwork-color.ts). `--accent` is `--aurora-1`
 * globally, so extraction failing — a CORS-tainted canvas, a broken image, SSR
 * — silently lands back on the aurora accent rather than an empty variable.
 *
 * ── The one gradient in this region ──────────────────────────────────────
 * There is no StageShield here (`providerSurface` is false for a music item),
 * so the region's single gradient (§2, budget of three product-wide) is unspent
 * — and it is spent on the one thing that is genuinely a primary action: the
 * button that recovers a start this browser refused. Nothing else on this
 * surface may take it. What says "this room is in motion" is the visualiser,
 * which is the artwork's own colour and not the brand's.
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
import { Button } from '@/components/ui/button';
import { MediaRow } from '@/components/ui/media-row';
import { NowPlaying } from '@/components/ui/now-playing';
import { cn } from '@/lib/cn';

const BAR_COUNT = 32;
/** Up-next stays a glanceable list, not a second queue pane. */
const UP_NEXT_LIMIT = 4;

/**
 * Resolve `--accent` to a concrete rgb triple for canvas painting. Canvas
 * fillStyle cannot read a CSS custom property, and oklch() support in canvas is
 * uneven, so the colour is laundered through a computed `color` on the element
 * itself — that always resolves to an rgb triple the 2D context accepts.
 *
 * Null when it does not, and the caller then paints NOTHING for that frame.
 * The fallback used to be a hard-coded `[168, 85, 247]` — the aurora violet,
 * written a second time in a file that is not `packages/design/src/tokens.ts`,
 * which is the one thing §2 forbids outright. There is no token to reach for
 * from here either: the whole point of this function is that the token has
 * already been resolved by the engine. So an unreadable accent means we do not
 * know the colour, and bars in an invented purple are worse than no bars.
 */
function resolveAccentRgb(el: HTMLElement): [number, number, number] | null {
  const parts = getComputedStyle(el).color.match(/[\d.]+/g);
  if (parts === null || parts.length < 3) return null;
  const r = Number(parts[0]);
  const g = Number(parts[1]);
  const b = Number(parts[2]);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return [r, g, b];
}

/**
 * MAY WE TAP THIS ELEMENT WITH WEBAUDIO?
 *
 * Only if its source is same-origin. `createMediaElementSource` does not fail
 * on a cross-origin resource — it succeeds and then outputs SILENCE, while
 * routing the element's audio through the graph, so tapping a plain .mp3 from
 * somebody else's host turns a working track into a silent one with a
 * visualiser bouncing on nothing. That was survivable only because the stage
 * element carried `crossOrigin="anonymous"`, which made those files fail to
 * load in the first place; now that they load, this is the guard that keeps
 * them audible, and it is what makes this file's header promise ("only works
 * for CORS-clean sources; anything else honestly renders the static glow")
 * actually true.
 *
 * hls.js feeds a blob: URL minted by this document, so MSE playback is
 * same-origin here and keeps its visualiser.
 *
 * Decided once per ELEMENT, not per track: a tap redirects the element's output
 * into the graph for the element's whole life and cannot be undone, and the
 * listen composition reuses one element across consecutive music items. So a
 * same-origin item must never share an element with a cross-origin one — which
 * holds today because nothing in this product serves same-origin media at all.
 */
export function canTapMediaElement(el: { currentSrc?: string; src?: string }): boolean {
  const src = el.currentSrc !== undefined && el.currentSrc !== '' ? el.currentSrc : (el.src ?? '');
  if (src === '') return false;
  if (typeof window === 'undefined') return false;
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * The visualiser, and D3 calls it "dominant" — so it is given the hero's full
 * width and the height of a display line, which makes it the second-largest
 * element in the composition. What it is NOT given is the middle: it sits
 * BENEATH the artwork, reading as light the cover is throwing off, so it can be
 * that large without competing with the thing it is lighting (§10, chrome that
 * fights the content).
 *
 * It is also this surface's liveness indicator, in the artwork's colour rather
 * than the brand's — see the gradient note in the file header.
 */
function Visualizer({
  adapter,
  playing,
  accent,
  className,
}: {
  adapter: PlayerAdapter | null;
  playing: boolean;
  /** Only a repaint trigger — the colour is read off the canvas itself. */
  accent: string;
  className?: string;
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
    let tapped = false;

    // Decided LAZILY, on the adapter's own 'ready', because it depends on the
    // source and the element has none when this effect first runs: StagePane
    // builds the adapter, and only the commit after that loads it.
    const start = (): void => {
      if (tapped) return;
      if (!canTapMediaElement(el)) {
        setLive(false);
        return;
      }
      tapped = true;

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
        // Element already tapped elsewhere — static glow only.
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
        const rgb = resolveAccentRgb(canvas);
        if (rgb === null) return;
        const [r, g, b] = rgb;
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
    };

    start();
    const offReady = adapter.on('ready', start);

    return () => {
      offReady();
      cancelAnimationFrame(raf);
      void audioCtx?.close().catch(() => undefined);
    };
  }, [adapter, reduced]);

  const bars = live && playing;

  return (
    // TWO LAYERS, because this file's header has always promised that a source
    // we cannot tap "honestly renders the static glow instead of fake bars" —
    // and there was no glow. The canvas simply sat at 25% opacity painting
    // nothing, which on every source this product actually serves (all of them
    // cross-origin, per `canTapMediaElement`) meant the composition reserved
    // 96px for a permanently empty box.
    //
    // The glow is the honest answer and it is not a fake spectrum: it does not
    // move, so nothing about it claims to be measured. It is the artwork's own
    // colour spilling under the cover, which is exactly what §5.1 is for.
    <div aria-hidden className={cn('relative h-24 w-full', className)}>
      <div
        className="absolute inset-0 transition-opacity duration-500"
        style={{
          opacity: bars ? 0 : 1,
          background:
            'radial-gradient(62% 100% at 50% 100%, color-mix(in oklch, var(--accent) 38%, transparent), transparent 72%)',
        }}
      />
      <canvas
        ref={canvasRef}
        width={512}
        height={128}
        // `color` is what resolveAccentRgb reads; it paints nothing by itself.
        // The transition lives here rather than on the --accent variable: custom
        // properties are not animatable, but `color` is, so the computed value
        // this reads each frame interpolates across a track change for free.
        style={{ color: accent, transition: 'color 500ms ease, opacity 500ms ease' }}
        className={cn(
          'absolute inset-0 h-full w-full',
          bars ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}

/**
 * The hero column is WIDER than the cover in it, and that is the point.
 *
 * `<NowPlaying variant="hero">` caps its own artwork against the viewport
 * height (see the note there), so this column is free to be as wide as the
 * measure wants — which is what the transport needs. PlayerControls is ten
 * controls, a scrubber and two clocks; at the 384px this column used to be it
 * wrapped onto three rows and read as a broken toolbar. At `xl`, where up-next
 * sits beside it, 576 + 64 + 384 = 1024 and the stage at that breakpoint is
 * ~880–1060, so both columns still shrink gracefully rather than collide.
 */
const HERO_WIDTH = 'w-full max-w-md xl:max-w-xl';

/** Up-next: wide enough for a 48px thumbnail, a title and a duration, and
 *  narrow enough that the hero stays the subject when they sit side by side. */
const UP_NEXT_WIDTH = 'w-full max-w-sm';

function UpNext({ items }: { items: readonly QueueItem[] }) {
  return (
    <section className={UP_NEXT_WIDTH} aria-label="Up next">
      {/* `text-caption` carries the uppercase AND the +0.08em that makes an
          11px overline read as a rule — the `text-label uppercase tracking-wide`
          this replaces was that step, spelled out by hand and one rung wrong
          (§3: tracking belongs to the step, never to the call site). */}
      <h3 className="px-2 text-caption text-low">Up next</h3>
      <ul className="mt-3 flex flex-col">
        {items.map((item) => (
          <MediaRow
            as="li"
            key={item.id}
            artwork={{ src: item.artworkUrl, alt: item.title, kind: 'music' }}
            title={item.title}
            meta={providerLabel(item.mediaRef)}
            {...(item.durationMs === null ? {} : { trailing: formatMs(item.durationMs) })}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * The room is playing a track the queue has no row for — a one-off `setTrack`
 * with no `queueIndex`. It is the ONLY thing `currentItem === undefined` can
 * mean here, because StagePane mounts this composition on `mediaKindFor(ref)
 * === 'music'` and that is never true of a null ref.
 *
 * What used to be here was `<EmptyState title="Nothing playing yet">`, which
 * was two failures at once: it said nothing was playing while audio came out of
 * the speakers, and it sat in the branch that also withheld the transport, so
 * the one state with no title and no artwork was also the one with no way to
 * pause. The transport now renders in both branches and this says the true
 * thing instead.
 */
function UntitledTrack() {
  return (
    <div className="flex w-full flex-col items-center gap-3 text-center">
      <p className="text-caption text-low">Now playing</p>
      <h2 className="text-headline text-hi md:text-display">An untitled track</h2>
      <p className="max-w-sm text-body text-low">
        This one was set straight on the stage rather than queued, so there is no
        artwork or title to show — the sound and the transport are the whole of it.
      </p>
    </div>
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
      {/* Grain over the veiled backdrop, not over an image: at 92% dim the
          backdrop is a wash rather than a picture, and this is the large quiet
          surface §4 names. It carries nothing — a strict `img-src` drops the
          data URI and the composition is unchanged. */}
      <span aria-hidden className="grain pointer-events-none absolute inset-0" />

      {/* The scroll port and the centring are separate elements on purpose.
          `justify-center` on a scrolling box clips overflow at the top and
          puts it out of reach of the scrollbar; centring an inner min-h-full
          column centres while it fits and scrolls from the top once hero,
          transport and up-next together outgrow the stage. */}
      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            'flex min-h-full w-full flex-col items-center justify-center px-6 py-8',
            // Two blocks of one composition, so `section` — and only once they
            // are genuinely side by side. Stacked, the same 64px of dead air
            // would just be a scroll. (`items-center` reads as the cross axis in
            // both directions, so the row variant does not restate it.)
            'gap-8 xl:flex-row xl:gap-section',
          )}
        >
          <div className={cn(HERO_WIDTH, 'flex flex-col items-center')}>
            {currentItem === undefined ? (
              <UntitledTrack />
            ) : (
              <NowPlaying
                variant="hero"
                showProgress={false}
                title={currentItem.title}
                kind="music"
                artworkUrl={artworkUrl}
                provider={providerLabel(currentItem.mediaRef)}
              />
            )}

            {/* Rhythm, deliberately three different rungs: 24 inside the hero
                between artwork and type (NowPlaying owns that), 32 out to the
                transport because it is a different KIND of thing, 24 down to
                the visualiser because it belongs to the sound the transport
                drives. Uniform gaps here would say all three weigh the same.

                Inline, not a floating video-style bar: nothing on this stage
                needs to get out of the way of a moving picture. */}
            {transport !== undefined && <div className="mt-8 w-full">{transport}</div>}

            {/* Autoplay reality: the room is playing but this browser refused to
                start. THE primary action of this surface, so it takes the
                region's one gradient (§2/§8) — and it is `<Button variant=
                "primary">` rather than a hand-rolled glass box with
                `hover:text-accent`, which was `--accent` used as a text colour
                and is illegal on the light theme at 3.43:1 (§2). */}
            {blocked && onActivate !== undefined && (
              <Button variant="primary" size="lg" className="mt-6 w-full" onClick={onActivate}>
                Start listening together
              </Button>
            )}

            <Visualizer adapter={adapter} playing={playing} accent={accent} className="mt-6" />
          </div>

          {upNext.length > 0 && <UpNext items={upNext} />}
        </div>
      </div>
    </div>
  );
}
