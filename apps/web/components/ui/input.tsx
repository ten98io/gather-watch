import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** Glass input with inner hairline; focus ring via global :focus-visible. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'glass-raised h-11 w-full rounded-ctl px-3 text-sm text-hi placeholder:text-low',
        'shadow-[inset_0_1px_0_0_color-mix(in_oklch,white_6%,transparent)]',
        'transition-colors duration-200 hover:border-[color-mix(in_oklch,white_14%,transparent)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
