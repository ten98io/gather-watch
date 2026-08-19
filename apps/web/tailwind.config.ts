import type { Config } from 'tailwindcss';
import type { ColorTokenName, TypeStep } from '@gather/design';
import {
  COLOR_TOKEN_NAMES,
  CONTROL_SIZE_NAMES,
  ELEVATION_NAMES,
  cssVarName,
  fontFamily,
  layout,
  motion,
  radii,
  spacing,
  typeRamp,
} from '@gather/design';

/**
 * Tailwind bindings for the Gather design tokens (DESIGN.md §2).
 *
 * Owns: the map from token to utility name — what `bg-surface-1`, `text-hi`
 * and `rounded-ctl` are called — and the web-only bits the package cannot
 * know: the `var(--font-*)` handles next/font mints, and the viewport band a
 * fluid type step interpolates across.
 *
 * Deliberately NOT: a value. Every number and colour below is read from
 * @gather/design. Colours in particular stay `var(--token)` rather than the
 * resolved colour, because the runtime depends on it twice over: `data-theme`
 * on <html> swaps the whole palette, and listen rooms rebind `--accent` inline
 * per track (components/stage/ListenStage.tsx) so the seek bar and the
 * visualiser retint with the artwork. Inline a colour here and both die
 * silently.
 */

/** 4 decimals of rem is 0.0016px at a 16px root — below anything observable. */
const trim = (value: number): string => String(Number(value.toFixed(4)));

const px = (value: number): string => `${value}px`;
const rem = (value: number): string => `${trim(value / 16)}rem`;

/**
 * Viewport band a fluid type step interpolates across; outside it the clamp
 * holds. Web-only — the package has no viewport — and chosen to reproduce the
 * hand-tuned `clamp(1.75rem, 1rem + 2.5vw, 3.5rem)` the hero shipped with.
 */
const FLUID_MIN_VIEWPORT_PX = 480;
const FLUID_MAX_VIEWPORT_PX = 1600;

function fluidSize(minPx: number, maxPx: number): string {
  const slope = (maxPx - minPx) / (FLUID_MAX_VIEWPORT_PX - FLUID_MIN_VIEWPORT_PX);
  const intercept = minPx - slope * FLUID_MIN_VIEWPORT_PX;
  return `clamp(${rem(minPx)}, ${rem(intercept)} + ${trim(slope * 100)}vw, ${rem(maxPx)})`;
}

/** Tailwind's `fontSize` tuple: the size, then the properties that ride with it. */
type FontSizeValue = [string, { lineHeight: string; letterSpacing?: string; fontWeight: string }];

/**
 * `lineHeightRatio` is the package's marker for a genuinely fluid step — only
 * the hero carries one. `body` also has a `maxFontSize`, but web spends it on
 * the <body> element's own clamp in globals.css, not on the `text-body`
 * utility, which has to stay a fixed size that `sm:` variants can override.
 */
function fontSizeValue(step: TypeStep): FontSizeValue {
  const size =
    step.lineHeightRatio === undefined || step.maxFontSize === undefined
      ? rem(step.fontSize)
      : fluidSize(step.fontSize, step.maxFontSize);
  return [
    size,
    {
      lineHeight:
        step.lineHeightRatio === undefined ? rem(step.lineHeight) : trim(step.lineHeightRatio),
      ...(step.letterSpacing === 0 ? {} : { letterSpacing: `${trim(step.letterSpacing)}em` }),
      fontWeight: String(step.fontWeight),
    },
  ];
}

/**
 * Token → utility suffix. Exhaustive by type: add a token to @gather/design
 * and this file stops compiling until web decides what to call it, which is
 * the whole point — the old failure mode was a palette growing in one place
 * and quietly not in another.
 */
const colorUtility: Readonly<Record<ColorTokenName, string>> = {
  bgVoid: 'void',
  bgDeep: 'deep',
  surfaceGlass: 'glass',
  surfaceRaised: 'raised',
  borderGlass: 'border-glass',
  // Elevation ladder (DESIGN.md §4): bg-surface-1/2/3 replace glass on
  // everything that does not float over moving video.
  surface0: 'surface-0',
  surface1: 'surface-1',
  surface2: 'surface-2',
  surface3: 'surface-3',
  hairline: 'hairline',
  scrim: 'scrim',
  textHi: 'hi',
  textMid: 'mid',
  textLow: 'low',
  aurora1: 'aurora-1',
  aurora2: 'aurora-2',
  aurora3: 'aurora-3',
  accent: 'accent',
  accentInk: 'accent-ink',
  success: 'success',
  danger: 'danger',
  warn: 'warn',
  focusRing: 'ring',
};

/**
 * A translucent wash of a token. Stays a `color-mix` over `var()` rather than
 * a resolved colour for the same reason the colours do: the theme swaps and
 * `--accent` is rebound under it at runtime.
 */
const wash = (token: ColorTokenName, percent: number): string =>
  `color-mix(in oklch, var(${cssVarName(token)}) ${percent}%, transparent)`;

const colors: Record<string, string> = Object.fromEntries(
  COLOR_TOKEN_NAMES.map((token) => [colorUtility[token], `var(${cssVarName(token)})`]),
);

const fontSize: Record<string, FontSizeValue> = Object.fromEntries(
  Object.entries(typeRamp).map(([name, step]) => [name, fontSizeValue(step)]),
);

/**
 * Control geometry, as spacing entries pointing at the custom properties the
 * package emits. Feeds `h-`, `w-`, `px-` and `gap-` at once, which is why
 * height and padding get different prefixes: `h-ctl-md`, `px-ctl-x-md`,
 * `gap-ctl-g-md`.
 */
const controlSpacing: Record<string, string> = Object.fromEntries(
  CONTROL_SIZE_NAMES.flatMap((name) => [
    [`ctl-${name}`, `var(--control-h-${name})`],
    [`ctl-x-${name}`, `var(--control-px-${name})`],
    [`ctl-g-${name}`, `var(--control-gap-${name})`],
  ]),
);

const elevationShadows: Record<string, string> = Object.fromEntries(
  ELEVATION_NAMES.map((name) => [name, `var(--elevation-${name})`]),
);

/**
 * next/font loads the bundled face in app/layout.tsx and exposes it as
 * `--font-<family>`; the package's stack supplies the fallbacks behind it.
 */
const fontStack = (family: keyof typeof fontFamily): string[] => [
  `var(--font-${family})`,
  ...fontFamily[family].slice(1),
];

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors,
      fontFamily: {
        display: fontStack('display'),
        sans: fontStack('sans'),
        mono: fontStack('mono'),
      },
      // Type ramp (DESIGN.md §3). Size / line-height / tracking / weight in one
      // utility; `font-bold` &co still win because core fontWeight sorts after
      // core fontSize. Use these instead of ad-hoc text-sm/text-xs.
      fontSize,
      // Radius ladder (DESIGN.md §4). Committed at both ends: controls stay
      // crisp, large surfaces are genuinely soft. The keys are class suffixes,
      // which is why `control` is spelled `ctl` — 38 call sites already say
      // `rounded-ctl` and renaming it is a codemod.
      borderRadius: {
        sm: px(radii.sm),
        ctl: px(radii.control),
        card: px(radii.card),
        panel: px(radii.panel),
        stage: px(radii.stage),
        pill: px(radii.pill),
      },
      // Layout constants that were previously arbitrary values. `tabBar` is in
      // the package too but is mobile's bottom sheet; web has no use for it.
      //
      // The `ctl-*` entries are deliberately `var()` and NOT a number: a
      // control's height is 32px where there is a mouse and 44px where there is
      // a finger, and @gather/design emits that pair behind a
      // `@media (pointer: coarse)` block. Inline the number here and desktop
      // density gets bought with the touch target, which is not a trade this
      // system makes. `h-ctl-md` / `px-ctl-x-md` are the only correct way to
      // size a control.
      spacing: {
        edge: px(layout.edge), // active-row accent edge
        tap: px(layout.tap), // minimum touch target
        row: px(layout.row), // media row height
        rail: px(layout.rail), // right rail width
        // The composition-scale end of the spacing ramp, by name. Tailwind's
        // own `16 / 24 / 32` happen to be the same pixels, but `gap-chapter`
        // says what the gap IS and `gap-24` says how big it is — and the ramp
        // is the vocabulary mobile and the overlay share, so a number here
        // would be the one client that opted out of it.
        section: px(spacing.section),
        chapter: px(spacing.chapter),
        canvas: px(spacing.canvas),
        ...controlSpacing,
      },
      // Two elevation vocabularies, and they are not interchangeable:
      //
      //  · `shadow-e1/e2/e3` — neutral, directional depth for chrome that
      //    floats (menus, tooltips, toasts, dialogs, sheets). Emitted by
      //    @gather/design as a wash of the ABSOLUTE ink, so it does not invert
      //    with the theme.
      //  · `shadow-glow` / `shadow-glow-lg` — the aurora underglow, RESERVED
      //    for signature moments (DESIGN.md §5): the listen-room hero artwork,
      //    the playing indicator. It used to sit under every dropdown and under
      //    secondary buttons on hover, which is what made ordinary chrome shout.
      boxShadow: {
        ...elevationShadows,
        glow: `0 0 40px -12px ${wash('aurora1', 22)}`,
        'glow-lg': `0 0 80px -20px ${wash('aurora2', 30)}`,
      },
      transitionTimingFunction: {
        spring: motion.springEasing,
      },
      // 150ms is the standard; the micro duration is reserved for entrances
      // (DESIGN.md §6). Keyed by its own value so the class can never name a
      // duration the token no longer has.
      transitionDuration: {
        [motion.microMs]: `${motion.microMs}ms`,
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'aurora-drift': {
          '0%': { transform: 'rotate(0deg) scale(1.4)' },
          '100%': { transform: 'rotate(360deg) scale(1.4)' },
        },
        'pulse-ring': {
          '0%': { opacity: '0.6', transform: 'scale(0.9)' },
          '100%': { opacity: '0', transform: 'scale(1.8)' },
        },
      },
      animation: {
        'fade-in': `fade-in ${motion.microMs}ms ease-out`,
        shimmer: `shimmer ${motion.shimmerMs}ms linear infinite`,
        'aurora-drift': `aurora-drift ${motion.auroraDriftMs}ms linear infinite`,
        'pulse-ring': `pulse-ring ${motion.pulseRingMs}ms ease-out infinite`,
      },
    },
  },
  plugins: [],
};

export default config;
