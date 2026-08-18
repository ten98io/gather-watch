import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

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
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-ctl-md w-full rounded-ctl border border-hairline bg-surface-2 px-3',
        'text-body text-hi placeholder:text-low',
        'transition-colors duration-150 hover:border-border-glass',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
