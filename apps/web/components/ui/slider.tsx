'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/cn';

export interface SliderProps {
  value: number;
  /** Fires on every input event — drive local/preview state from this. */
  onValueChange(value: number): void;
  /**
   * Fires ONCE when an interaction ends (pointer release, key up, blur, or the
   * native `change` event) with the final value. Use it for commits that must
   * not run per input event — e.g. broadcasting a seek to the room — while
   * `onValueChange` keeps the thumb and any readout following the drag.
   */
  onValueCommit?(value: number): void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  'aria-label': string;
  className?: string;
}

/** Aurora-accent range slider (volume, rate, seek scrubbers). Thumb/track are
 *  drawn by `.slider-aurora` in globals.css — `appearance: none` disables
 *  `accent-color`, so the native widget can't be relied on. */
export function Slider({
  value,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  className,
  ...aria
}: SliderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  /** Latest value the user produced; commits report this, not the prop. */
  const latestRef = useRef(value);
  /** Has the value moved since the last commit? Keeps commits to exactly one. */
  const dirtyRef = useRef(false);
  /** A pointer or key is down, so an explicit end handler owns the commit. */
  const activeRef = useRef(false);
  const commitCbRef = useRef(onValueCommit);
  commitCbRef.current = onValueCommit;

  const commit = useCallback(() => {
    activeRef.current = false;
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    commitCbRef.current?.(latestRef.current);
  }, []);

  // Native `change` is the browser's own end-of-interaction signal; it covers
  // paths with no pointer/key sequence (assistive tech setting the value).
  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    const onNativeChange = (): void => {
      if (activeRef.current) return; // the pointer/key handlers will commit
      commit();
    };
    el.addEventListener('change', onNativeChange);
    return () => el.removeEventListener('change', onNativeChange);
  }, [commit]);

  // Drives the filled portion of the track (WebKit has no ::-moz-range-progress
  // equivalent, so the fill is painted as a gradient stop).
  const span = max - min;
  const raw = span > 0 ? ((value - min) / span) * 100 : 0;
  // A non-finite value would emit `--slider-fill: NaN%` and invalidate the
  // track gradient outright, so it degrades to an empty track instead.
  const pct = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;

  return (
    <input
      ref={inputRef}
      type="range"
      style={{ '--slider-fill': `${pct}%` } as CSSProperties}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => {
        const next = Number(e.target.value);
        latestRef.current = next;
        dirtyRef.current = true;
        onValueChange(next);
      }}
      onPointerDown={() => {
        activeRef.current = true;
      }}
      onKeyDown={() => {
        activeRef.current = true;
      }}
      onPointerUp={commit}
      onPointerCancel={commit}
      onLostPointerCapture={commit}
      onKeyUp={commit}
      onBlur={commit}
      className={cn(
        'slider-aurora h-6 w-full cursor-pointer appearance-none bg-transparent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...aria}
    />
  );
}
