'use client';

import { cn } from '@/lib/cn';

export interface SliderProps {
  value: number;
  onValueChange(value: number): void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  'aria-label': string;
  className?: string;
}

/** Aurora-accent range slider (volume, rate, seek scrubbers). */
export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  className,
  ...aria
}: SliderProps) {
  return (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => {
        onValueChange(Number(e.target.value));
      }}
      className={cn(
        'h-6 w-full cursor-pointer appearance-none bg-transparent accent-[var(--aurora-1)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...aria}
    />
  );
}
