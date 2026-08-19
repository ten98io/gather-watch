import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

/**
 * ── What changed, and why each one was a "cartoonish" tell ────────────────
 *
 * · No `hover:shadow-glow` on primary or secondary. A 40px aurora halo blooming
 *   under a SECONDARY button on hover is the loudest toy tell in the product:
 *   glow is a signature moment (DESIGN.md §5), not feedback for a pointer
 *   passing over "Cancel".
 * · `secondary` is the solid elevation ladder, not glass. Glass is reserved for
 *   surfaces floating over moving video (DESIGN.md §4); a button in a settings
 *   page is not one, and glass there meant it carried a wash AND a border AND a
 *   glow to say one thing.
 * · Labels are `font-medium` (500), not `font-semibold` (600). 600 at 13–15px is
 *   chunky — the ramp already gives `text-label` its weight, and stacking a
 *   heavier one on top is how every control ended up shouting equally.
 * · Filled variants take the ink measured against their own fill
 *   (`--ink-on-aurora-gradient` via `.aurora-gradient`, `--ink-on-danger`) and
 *   not `--accent-ink`, which measured 2.99:1 on dark `--danger`.
 * · `brightness-110` → `brightness-105`. A 10% jump on a saturated fill reads as
 *   a light switch; 5% reads as a surface responding.
 */
const variantClasses: Record<ButtonVariant, string> = {
  // Aurora gradient is reserved for primary actions (DESIGN.md §2, §8).
  // `.aurora-gradient` sets the measured ink itself — do not restate it here.
  primary: 'aurora-gradient font-medium hover:brightness-105 active:brightness-95',
  secondary:
    'bg-surface-2 text-hi font-medium hover:bg-surface-3 active:brightness-95',
  destructive:
    'bg-danger text-[var(--ink-on-danger)] font-medium hover:brightness-105 active:brightness-95',
  ghost: 'text-mid font-medium hover:bg-surface-2 hover:text-hi active:brightness-95',
};

/**
 * Heights are `var(--control-h-*)` from @gather/design, NOT a Tailwind step.
 * That indirection is the whole point: the same class is 32px where there is a
 * mouse and 44px where there is a finger, because tokens.generated.css raises
 * it inside `@media (pointer: coarse)`. Writing `h-8` here would ship a 32px
 * touch target; writing `h-11` is what shipped a touch-sized button to every
 * desktop and is the thing this file is being fixed for.
 */
const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-ctl-sm px-ctl-x-sm gap-ctl-g-sm text-label rounded-sm',
  md: 'h-ctl-md px-ctl-x-md gap-ctl-g-md text-label rounded-ctl',
  lg: 'h-ctl-lg px-ctl-x-lg gap-ctl-g-lg text-body rounded-ctl',
  icon: 'h-ctl-md w-ctl-md rounded-ctl',
};

export interface ButtonSkin {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

/**
 * The button's skin, without the `<button>`.
 *
 * Exists because half the primary actions in the product NAVIGATE, and the
 * shape those had settled on was `<Link><Button/></Link>` — an `<a>` wrapping a
 * `<button>`. That is an interactive element nested inside an interactive
 * element: invalid HTML, two tab stops for one action, and a screen reader
 * announcing a link that contains a button. A `<Link>` wearing this string is
 * one control with one role, and it renders identically.
 *
 * Rule for callers: every pair of classes it emits is mutually exclusive, and
 * anything you add through `className` must be too. `cn` is a plain joiner —
 * `bg-surface-2` plus `bg-accent` does not resolve to the second one, it
 * resolves to whichever Tailwind happened to emit later.
 */
export function buttonClasses({ variant = 'primary', size = 'md', className }: ButtonSkin = {}): string {
  return cn(
    'inline-flex select-none items-center justify-center whitespace-nowrap',
    // Colour and filter only. `transition-all` also animated the height,
    // which under `@media (pointer: coarse)` meant the control visibly grew
    // on a device rotation. 150ms is the standard (DESIGN.md §6).
    'transition-[background-color,color,filter] duration-150 ease-spring',
    'disabled:pointer-events-none disabled:opacity-50',
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Buttons (DESIGN.md §8): primary = aurora gradient, secondary = surface-2,
 *  destructive = --danger. Desktop density 28/32/40; touch targets ≥ 44px on
 *  coarse pointers, handled by the control tokens rather than per call site. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={buttonClasses({ variant, size, ...(className === undefined ? {} : { className }) })}
      {...props}
    />
  );
});
