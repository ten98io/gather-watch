'use client';

/**
 * ListenStage — the listen-room skin (DESIGN.md §7): oversized artwork with
 * an aurora underglow and a live WebAudio visualizer behind it, instead of a
 * video surface. The analyser taps the real <audio> element (CORS-clean
 * sources only — cross-origin audio without CORS headers honestly renders
 * the static glow, never fake bars).
 */
import { useEffect, useRef, useState } from 'react';
import type { QueueItem } from '@playin/contracts';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import type { PlayerAdapter } from '@/lib/player/adapter';
import type { NativeAdapter } from '@/lib/player/native';
import { cn } from '@/lib/cn';

const BAR_COUNT = 32;

function Visualizer({ adapter, playing }: { adapter: PlayerAdapter | null; playing: boolean }) {
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
      const barW = width / BAR_COUNT;
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const v = (data[i] ?? 0) / 255;
        const h = Math.max(2, v * height);
        const grad = ctx.createLinearGradient(0, height - h, 0, height);
        grad.addColorStop(0, 'rgba(168, 85, 247, 0.9)'); // aurora-1
        grad.addColorStop(0.7, 'rgba(217, 70, 239, 0.5)'); // aurora-2
        grad.addColorStop(1, 'rgba(245, 176, 77, 0.25)'); // aurora-3
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
      height={120}
      aria-hidden
      className={cn(
        'h-24 w-full max-w-lg transition-opacity duration-500',
        live && playing ? 'opacity-100' : 'opacity-30',
      )}
    />
  );
}

export function ListenStage({
  adapter,
  currentItem,
  playing,
}: {
  adapter: PlayerAdapter | null;
  currentItem: QueueItem | undefined;
  playing: boolean;
}) {
  return (
    <div className="flex w-full flex-col items-center justify-center gap-6 p-6">
      {/* Oversized artwork with aurora underglow (§5.1) */}
      <div className="relative">
        <div
          aria-hidden
          className="absolute -inset-8 rounded-full opacity-40 blur-3xl"
          style={{
            background:
              'radial-gradient(closest-side, var(--aurora-1), var(--aurora-2) 60%, transparent)',
          }}
        />
        <div
          className={cn(
            'glass-panel relative flex h-56 w-56 items-center justify-center overflow-hidden rounded-panel shadow-glow-lg sm:h-64 sm:w-64',
            playing && 'shadow-glow-lg',
          )}
        >
          {currentItem?.artworkUrl != null ? (
            // User-provided artwork URL; arbitrary remote image.
            <img
              src={currentItem.artworkUrl}
              alt={currentItem.title}
              className="h-full w-full object-cover"
            />
          ) : (
            <span aria-hidden className="text-7xl">🎧</span>
          )}
        </div>
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <p className="max-w-md truncate font-display text-lg font-semibold text-hi">
          {currentItem?.title ?? 'Listening room'}
        </p>
        <p className="text-xs text-low">
          {currentItem === undefined ? 'Queue something to hear together' : 'Shared playback · everyone hears the same beat'}
        </p>
      </div>

      <Visualizer adapter={adapter} playing={playing} />
    </div>
  );
}
