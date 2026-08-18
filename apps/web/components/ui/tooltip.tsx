import type { ReactElement, ReactNode } from 'react';
import { cloneElement, isValidElement } from 'react';
import { cn } from '@/lib/cn';

export type TooltipAlign = 'center' | 'start' | 'end';

export interface TooltipProps {
  content: string;
  children: ReactNode;
  /**
   * Horizontal anchoring of the bubble. Use `start`/`end` for controls that sit
   * against a container edge (the transport bar's first and last buttons) so the
   * bubble grows inward instead of overflowing the clipped stage.
   */
  align?: TooltipAlign;
  className?: string;
}

const alignClasses: Record<TooltipAlign, string> = {
  center: 'left-1/2 -translate-x-1/2',
  start: 'left-0',
  end: 'right-0',
};

/**
 * CSS-only tooltip on hover/focus; also injects `aria-label` into a single
 * element child so the label is available to assistive tech. The bubble itself
 * is `aria-hidden` — it only duplicates that label visually.
 *
 * Renders above the trigger (`-top-9`), which is what the bottom-docked player
 * bar needs. Hover reveal is delayed 300 ms so sweeping the pointer across a row
 * of controls doesn't flash a trail of bubbles; hiding and keyboard focus are
 * instant.
 */
export function Tooltip({ content, children, align = 'center', className }: TooltipProps) {
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        'aria-label': content,
      })
    : children;
  return (
    <span className={cn('group relative inline-flex', className)}>
      {child}
      <span
        aria-hidden
        className={cn(
          // pointer-events-none: the bubble must never swallow the hover (or the
          // click) meant for the control it describes.
          'pointer-events-none absolute -top-9 z-[65] whitespace-nowrap',
          // Opaque, deliberately. Tooltips describe the transport bar, which is
          // itself glass over video — and DESIGN.md §4 says never stack two
          // glass layers, which is exactly what `glass-raised` here did. A
          // solid step plus neutral elevation also means the label's contrast
          // does not depend on the frame of video behind it.
          'rounded-sm border border-hairline bg-surface-3 px-2 py-1 text-label text-hi shadow-e2',
          'opacity-0 transition-opacity duration-150 [transition-delay:0ms]',
          'group-hover:opacity-100 group-hover:[transition-delay:300ms]',
          'group-focus-within:opacity-100 group-focus-within:[transition-delay:0ms]',
          alignClasses[align],
        )}
      >
        {content}
      </span>
    </span>
  );
}
