import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Which rung of the control ladder the field sits on — the same two rungs the
 * button uses, so a field and the button that submits it line up.
 *
 * Named `inputSize` and not `size` because `size` is already on
 * `InputHTMLAttributes` and means "width in characters"; shadowing it would
 * make one of the two silently unreachable.
 */
export type InputSize = 'md' | 'lg';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  inputSize?: InputSize;
  /**
   * Draws the field's edge in `--danger`. An EDGE, never text: the same class
   * has to be legal on Daylight, where a 3:1 colour may carry a border and may
   * not carry words (DESIGN.md §2).
   */
  invalid?: boolean;
}

/** Heights are `var(--control-h-*)`, so the field is 32/40px under a mouse and
 *  44/48px under a finger without this file knowing which. */
const sizeClasses: Record<InputSize, string> = {
  md: 'h-ctl-md px-ctl-x-md',
  lg: 'h-ctl-lg px-ctl-x-lg',
};

/**
 * Text input. Focus ring via global :focus-visible.
 *
 * Three things went, all of them the same mistake — saying "this is a field"
 * three times at once:
 *  · the `inset 0 1px 0` white highlight, which is a bevel, and a bevel on a
 *    32px control is the most dated thing a UI can wear;
 *  · glass, which is reserved for surfaces over moving video (DESIGN.md §4) and
 *    left the field's legibility depending on the page behind it;
 *  · `text-sm` (14px, Tailwind core), which is not on the ramp — a field's text
 *    is `text-body`, the same size as the text around it, because it IS content.
 * What is left is one background step and one hairline.
 *
 * AUTOFILL IS NOT SOLVED HERE, deliberately. Chrome paints an autofilled field
 * with its own light lavender from a UA rule that no `background-color` can
 * reach, and the override — an inset `--surface-2` shadow plus
 * `-webkit-text-fill-color` — lives once in `app/globals.css` against
 * `input:-webkit-autofill` (DESIGN.md §8). It therefore also covers every
 * `<input>` that is not this component. Do not restate it per component: two
 * copies of that rule is how one of them goes stale against the ladder.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, inputSize = 'md', invalid = false, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      // `cn` is a plain joiner, so every pair below is a ternary and never two
      // classes stacked: the later class does not win, CSS source order does.
      aria-invalid={invalid ? true : undefined}
      className={cn(
        'w-full rounded-ctl border bg-surface-2 text-body text-hi placeholder:text-low',
        'transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        sizeClasses[inputSize],
        invalid ? 'border-danger' : 'border-hairline hover:border-border-glass',
        className,
      )}
      {...props}
    />
  );
});
