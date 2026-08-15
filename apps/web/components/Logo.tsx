import { cn } from '@/lib/cn';

/** Playin wordmark orb — the aurora play triangle from app/icon.svg. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-label="Playin"
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
