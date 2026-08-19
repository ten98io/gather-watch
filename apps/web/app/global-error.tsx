'use client';

/**
 * The last boundary: a throw in the ROOT layout itself.
 *
 * Next replaces the whole document with this component, which is why it
 * renders its own <html> and <body> — the root layout, its font variables and
 * the pre-paint theme script are all exactly what failed, so none of them are
 * around to be inherited.
 *
 * Everything here is inline-styled for the same reason. The Tailwind layer and
 * the generated token sheet ride on the root layout's import graph; a screen
 * whose whole job is to work when that graph is broken cannot depend on it.
 *
 * ── Where the numbers come from (2026-08-19) ──────────────────────────────
 * They used to be written out: `#17141f`, `1.5rem`, `0.75rem`, a hand-typed
 * `rgba(255,255,255,0.08)`. That is the palette and both scales copied into a
 * file nobody would think to update, and it had already gone stale — the void
 * moved to a true cinema black and this screen was still painting the old
 * mauve one. So every value is read from @gather/design directly and rendered
 * as `var(--token, <the same value resolved>)`: the stylesheet when it
 * survived, and the identical colour when it did not.
 *
 * Importing the design package does NOT reintroduce the dependency this file
 * exists to avoid. What is suspect in a root-layout failure is the component
 * tree, the router and the CSS — not a module of pure numbers. That is also
 * why there is still no <Link>, no <Button> and no imported icon: a plain
 * anchor, a plain button and an inline path are the controls that cannot fail.
 *
 * As with every boundary here, nothing off `error` reaches the markup — the
 * digest goes to the console so a bug report can still be traced.
 */
import { useEffect } from 'react';
import type { ColorTokenName } from '@gather/design';
import { controlSizes, cssVarName, radii, resolveColorToken, spacing, typeRamp } from '@gather/design';
import { describeBoundaryError, logBoundaryError } from '@/lib/describe-error';

const px = (value: number): string => `${value}px`;

/** `var(--token, <resolved dark value>)`. Dark because that is what the root
 *  layout defaults to, and the theme script is one of the things that failed. */
const token = (name: ColorTokenName): string =>
  `var(${cssVarName(name)}, ${resolveColorToken('dark', name).hex})`;

const shell: React.CSSProperties = {
  minHeight: '100dvh',
  margin: 0,
  display: 'grid',
  placeItems: 'center',
  padding: px(spacing.xl),
  background: token('bgVoid'),
  color: token('textHi'),
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

const plate: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: px(spacing.xxl),
  maxWidth: '36rem',
  width: '100%',
  padding: `${px(spacing.chapter)} ${px(spacing.xxl)}`,
  textAlign: 'center',
  borderRadius: px(radii.stage),
  background: token('surface1'),
};

const disc: React.CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: px(56),
  height: px(56),
  borderRadius: px(radii.pill),
  background: token('surface2'),
  color: token('textLow'),
};

const overline: React.CSSProperties = {
  margin: 0,
  fontSize: px(typeRamp.caption.fontSize),
  lineHeight: px(typeRamp.caption.lineHeight),
  fontWeight: typeRamp.caption.fontWeight,
  letterSpacing: `${typeRamp.caption.letterSpacing}em`,
  textTransform: 'uppercase',
  color: token('textLow'),
};

const headline: React.CSSProperties = {
  margin: 0,
  fontSize: px(typeRamp.display.fontSize),
  lineHeight: px(typeRamp.display.lineHeight),
  fontWeight: typeRamp.display.fontWeight,
  letterSpacing: `${typeRamp.display.letterSpacing}em`,
};

const sentence: React.CSSProperties = {
  margin: 0,
  maxWidth: '28rem',
  fontSize: px(typeRamp.body.fontSize),
  lineHeight: px(typeRamp.body.lineHeight),
  color: token('textMid'),
};

/**
 * `touchHeight`, not `height`. The control ladder picks between the two with
 * `@media (pointer: coarse)`, and an inline style cannot ask a media query —
 * so this screen takes the larger of the pair. Shipping the 40px desktop
 * height here would put a sub-44px target on a phone, and the one screen that
 * cannot be re-rendered is the worst place to miss one.
 */
const control: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: px(controlSizes.lg.touchHeight),
  padding: `0 ${px(controlSizes.lg.paddingX)}`,
  borderRadius: px(radii.control),
  border: 'none',
  background: token('surface2'),
  color: token('textHi'),
  fontSize: px(typeRamp.body.fontSize),
  fontFamily: 'inherit',
  textDecoration: 'none',
  cursor: 'pointer',
};

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logBoundaryError('global', error);
  }, [error]);

  return (
    <html lang="en" data-theme="dark">
      <body style={shell}>
        <main style={plate}>
          <span aria-hidden style={disc}>
            {/* The same orbit mark components/ui/icons.tsx draws, inlined —
                this screen imports no component. */}
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20.341 6.484A10 10 0 0 1 10.266 21.85" />
              <path d="M3.659 17.516A10 10 0 0 1 13.74 2.152" />
              <circle cx="12" cy="12" r="3" />
              <circle cx="19" cy="5" r="2" />
              <circle cx="5" cy="19" r="2" />
            </svg>
          </span>
          <div style={{ display: 'grid', gap: px(spacing.lg), justifyItems: 'center' }}>
            <p style={overline}>Cold start failed</p>
            <h1 style={headline}>Gather couldn’t load.</h1>
            <p style={sentence}>{describeBoundaryError(error)}</p>
          </div>
          <div style={{ display: 'flex', gap: px(spacing.md) }}>
            <button type="button" style={control} onClick={reset}>
              Retry
            </button>
            <a href="/home" style={control}>
              Back to your rooms
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
