import { cn } from '@/lib/cn';

/** Gather brand orb — the aurora play triangle.
 *
 *  This is one of the three places the aurora gradient is sanctioned
 *  (DESIGN.md §2: the primary action, the brand mark, the live indicator), and
 *  it is the reason the other two mean anything. A screen region carries at
 *  most one of them, so a header lockup and a primary button in the same
 *  header is already the budget spent.
 *
 *  Every stop is `var(--aurora-*)`, so the mark narrowed with the palette and
 *  retints with the theme. `app/icon.svg` draws the same mark for the browser
 *  tab and the PWA, and it has NOT followed: a static asset is fetched outside
 *  the document, so no custom property reaches it and its stops are still the
 *  pre-2026-08-19 rainbow, amber and all. The two are no longer the same
 *  artwork and this file is not the one that is wrong — see the note in the
 *  handoff. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-label="Gather"
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id="logo-aurora" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--aurora-1)" />
          <stop offset="0.5" stopColor="var(--aurora-2)" />
          <stop offset="1" stopColor="var(--aurora-3)" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill="var(--bg-deep)" />
      <path d="M208 160 L368 256 L208 352 Z" fill="url(#logo-aurora)" />
      <circle
        cx="256"
        cy="256"
        r="196"
        fill="none"
        stroke="url(#logo-aurora)"
        strokeOpacity="0.35"
        strokeWidth="6"
        strokeDasharray="4 18"
      />
    </svg>
  );
}

/**
 * The lockup: mark + name, as one object.
 *
 * It was assembled by hand in four places (home, settings, legal, login) and
 * had already drifted — `text-lg font-bold tracking-tight` in one header,
 * `text-lg font-bold` in another, and a different gap in each. A wordmark that
 * is a different size on two consecutive screens is the cheapest way to look
 * unconsidered, so it is one component with one setting.
 *
 * Deliberately NOT a link: every caller wraps it in the `<Link>` that suits its
 * route, and nesting an anchor inside an anchor is invalid.
 */
export function Wordmark({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <Logo size={size} />
      <span className="font-display text-title text-hi">Gather</span>
    </span>
  );
}
