import { forwardRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Glass multiline input matching Input. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'glass-raised min-h-[88px] w-full rounded-ctl px-3 py-2 text-sm text-hi placeholder:text-low',
        'shadow-[inset_0_1px_0_0_color-mix(in_oklch,white_6%,transparent)]',
        'transition-colors duration-200 hover:border-[color-mix(in_oklch,white_14%,transparent)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
