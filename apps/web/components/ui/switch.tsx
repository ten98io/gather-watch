'use client';

import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  disabled?: boolean;
  'aria-label': string;
  className?: string;
}

/**
 * Accessible toggle (role=switch). 44px-wide target.
 *
 * The track is a SOLID `--accent` when on, not the three-stop aurora gradient.
 * A 44×24 element is far too small to show a gradient as anything but noise —
 * all it did was put the loudest fill in the system on the most ordinary
 * control on the settings page. The gradient stays where DESIGN.md §2 puts it:
 * primary actions and brand.
 *
 * The knob is `--ink-on-accent`, the ink @gather/design measures against the
 * accent itself (≥4.72:1 in both themes), so the knob clears the 3:1 non-text
 * bar against its own track by a wide margin — it used to be `--accent-ink`,
 * which measured 3.80:1 on dark `--accent` and would have been the first thing
 * to fail if the accent were ever retinted.
 */
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
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors duration-150',
        // The TRACK is 44×24; the TARGET has to be 44×44 (DESIGN.md §9, and
        // `layout.tap` is the number). Growing the element itself would grow
        // the fill with it — a 44px-tall pill is a different control — so the
        // extra 20px is a transparent pseudo-element centred on the track. It
        // paints nothing and belongs to the button, so a press anywhere in it
        // is a press on the switch.
        'before:absolute before:inset-x-0 before:top-1/2 before:h-tap',
        "before:-translate-y-1/2 before:content-['']",
        checked ? 'bg-accent' : 'border border-hairline bg-surface-3',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...aria}
    >
      <span
        aria-hidden
        className={cn(
          'h-5 w-5 rounded-full transition-transform duration-150 ease-spring',
          // `bg-low` is `--text-low`, which the palette guard holds to ≥4.5:1 on
          // every ladder rung — so the off-state knob is legible on surface-3.
          checked ? 'translate-x-5 bg-[var(--ink-on-accent)]' : 'bg-low',
        )}
      />
    </button>
  );
}
