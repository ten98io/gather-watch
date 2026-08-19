/**
 * <EmptyState> — icon, one sentence, at most one action (DESIGN.md §4).
 * Every empty list uses it; a bare "Nothing here" paragraph is not acceptable
 * because an empty region with no way out reads as a broken screen.
 *
 * The action slot takes exactly one control. If a surface needs two, the second
 * one belongs somewhere else.
 *
 * ── The two variants, and why the ramp stops where it does ────────────────
 * `inline` is a state inside a list that is USUALLY full. `signature` is the
 * whole of what a region shows, and an empty room is the first thing anyone
 * ever sees of it — so it gets the composition treatment: canvas-scale
 * breathing room, a larger glyph plate, grain (§4 names a full-bleed empty
 * state as one of the surfaces it belongs on) and the `headline` step.
 *
 * It deliberately stops at `headline` and never reaches `text-display`. A
 * screen may carry ONE display setting and it has to be what the screen is
 * about (§3, §10) — that is the stage's now-playing title, not a rail pane's
 * empty list. A component that spent it would let two of them onto one screen
 * without either call site being able to see the other.
 *
 * ── The gaps are unequal on purpose ───────────────────────────────────────
 * This was one `gap-4` down the whole stack, which spaces the plate, the
 * sentence, the explanation and the action identically and therefore says they
 * rank identically (§10). They do not: the plate is a mark and wants air under
 * it, the description belongs to the title above it and sits close, and the
 * action is a separate thought again. That is why each slot carries its own
 * margin instead of the parent carrying one gap.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type EmptyStateVariant = 'inline' | 'signature';

interface VariantStyle {
  readonly root: string;
  readonly plate: string;
  readonly title: string;
  readonly description: string;
  readonly action: string;
}

const VARIANT: Readonly<Record<EmptyStateVariant, VariantStyle>> = {
  inline: {
    root: 'px-4 py-8',
    plate: 'h-10 w-10 rounded-ctl',
    title: 'mt-3 text-title',
    description: 'mt-2 max-w-xs',
    action: 'mt-4',
  },
  signature: {
    // `min-h-full`, never `h-full`: the canvas-scale padding is generous
    // enough to outgrow a short rail, and a centred flex box that overflows
    // puts its own first line out of reach above the scroll origin.
    //
    // The composition rung halves below `md` (the pattern is written out in
    // app/home/page.tsx): `section` 64 → `xxl` 32, another rung of the same
    // ramp. 128px of vertical padding was drawn for a 380px desktop rail; in
    // the 252px port a phone sheet gives this pane it is most of the reason an
    // EMPTY list arrived already scrolled, with its own plate above the origin.
    //
    // `grain` carries no information here by design: a host page with a strict
    // `img-src` drops the data URI and this surface is still complete (§4).
    root: 'grain min-h-full rounded-panel px-6 py-8 md:py-section',
    // 96px on the 28px rung. §4 names "a signature empty state's plate" as one
    // of the three surfaces `stage` exists for, and the rung only works at
    // this size: 28 on the 56px plate this used to be is half its height,
    // which is the exact ratio §4 calls cartoonish. A small mark in a large
    // quiet plate is the composition; a big glyph in a small box is a button.
    plate: 'h-24 w-24 rounded-stage',
    title: 'mt-8 text-headline',
    description: 'mt-3 max-w-sm',
    action: 'mt-6',
  },
};

export interface EmptyStateProps {
  /** An icon from components/ui/icons.tsx, sized 20–24. Never an emoji. */
  icon: ReactNode;
  /** One short sentence naming what is missing. */
  title: string;
  /** Optional second sentence saying how to fill it. */
  description?: string;
  /** At most one primary action. */
  action?: ReactNode;
  /** `signature` when this IS the region, `inline` when it is a list's state. */
  variant?: EmptyStateVariant;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = 'inline',
  className,
}: EmptyStateProps) {
  const style = VARIANT[variant];
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        style.root,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn('grid shrink-0 place-items-center bg-surface-2 text-low', style.plate)}
      >
        {icon}
      </span>
      <p className={cn('font-display text-hi', style.title)}>{title}</p>
      {description !== undefined && (
        <p className={cn('text-body text-low', style.description)}>{description}</p>
      )}
      {action !== undefined && <div className={style.action}>{action}</div>}
    </div>
  );
}
