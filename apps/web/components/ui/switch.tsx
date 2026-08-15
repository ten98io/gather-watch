'use client';

import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  disabled?: boolean;
  'aria-label': string;
  className?: string;
}

/** Accessible toggle (role=switch), aurora track when on. 44px-wide target. */
export function Switch({ checked, onCheckedChange, disabled, className, ...aria }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        onCheckedChange(!checked);
      }}
      className={cn(
        'inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border-glass px-0.5 transition-colors duration-200',
        checked ? 'aurora-gradient' : 'bg-glass',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...aria}
    >
      <span
        aria-hidden
        className={cn(
          'h-5 w-5 rounded-full bg-accent-ink shadow transition-transform duration-200 ease-spring',
          checked && 'translate-x-5',
        )}
      />
    </button>
  );
}
