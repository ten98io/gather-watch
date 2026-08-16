/**
 * The non-colour scales — spacing, radii, the type ramp, motion, layout
 * constants and font families.
 *
 * Owns: one reconciled value for each. These lived in two places that had
 * drifted (apps/web/tailwind.config.ts and apps/mobile/src/theme.ts); where
 * they disagreed, DESIGN.md decides, and web already matched DESIGN.md, so
 * mobile's stale numbers lose. The disagreements are recorded in the comments
 * beside each one — a reader who wonders why mobile's radius changed should
 * find the answer here, not in a commit message.
 *
 * Deliberately NOT: colour (src/tokens.ts), or output syntax (the emitters).
 * Units are px numbers and em ratios; no `rem` strings, no `dp`, nothing that
 * presumes a renderer.
 */

/** Weights the ramp uses. RN needs these as strings; the RN emitter converts. */
export type FontWeight = 400 | 500 | 600 | 700;

/** One step of the type ramp (DESIGN.md §3). */
export interface TypeStep {
  /** px. For a fluid step this is the floor. */
  readonly fontSize: number;
  /** px, at `fontSize`. Fluid steps carry `lineHeightRatio` instead. */
  readonly lineHeight: number;
  readonly fontWeight: FontWeight;
  /** em. 0 means no tracking adjustment. */
  readonly letterSpacing: number;
  /** DESIGN.md §3 uppercases only the caption. */
  readonly uppercase?: true;
  /** px ceiling for steps that scale with viewport width. RN uses `fontSize`. */
  readonly maxFontSize?: number;
  /** Unitless line-height, authoritative over `lineHeight` on fluid steps. */
  readonly lineHeightRatio?: number;
}

export type TypeStepName = 'display' | 'title' | 'body' | 'label' | 'caption' | 'hero';

/**
 * The type ramp. Replaces ad-hoc `text-sm`/`text-xs` sizing; each step carries
 * size, line-height, weight and tracking together.
 *
 * Reconciled against apps/mobile/src/theme.ts, which had a different ramp
 * entirely (displayL/displayM/bodyStrong/mono at 34/28/16/14px, title at
 * weight 500, caption at 13px). DESIGN.md §3's table is the ramp; mobile's was
 * a pre-redesign shape. `mono` is not a step — it is a family, see `fontFamily`.
 */
export const typeRamp: Readonly<Record<TypeStepName, TypeStep>> = {
  display: { fontSize: 32, lineHeight: 36, fontWeight: 600, letterSpacing: -0.02 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: 600, letterSpacing: -0.01 },
  // Web additionally scales the <body> font-size 15→17px at ≥1440px; that is
  // this step's `maxFontSize`. RN has no viewport unit and uses 15.
  body: { fontSize: 15, lineHeight: 22, fontWeight: 400, letterSpacing: 0, maxFontSize: 17 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: 500, letterSpacing: 0 },
  caption: { fontSize: 11, lineHeight: 14, fontWeight: 500, letterSpacing: 0.04, uppercase: true },
  // Marketing/auth heroes only — the one genuinely fluid step in the system.
  hero: {
    fontSize: 28,
    lineHeight: 29,
    fontWeight: 700,
    letterSpacing: -0.02,
    maxFontSize: 56,
    lineHeightRatio: 1.05,
  },
};

export type SpacingName = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | 'xxxl';

/**
 * The fixed spacing ramp 4 · 8 · 12 · 16 · 24 · 32 · 48 (DESIGN.md §4). No
 * arbitrary values in new code.
 *
 * Mobile stopped at 32 (`xxl`) and had no 48; web expressed the same ramp as
 * Tailwind's `1 2 3 4 6 8 12`. Union of the two, mobile's key names kept.
 */
export const spacing: Readonly<Record<SpacingName, number>> = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

/** The ramp as an ordered list, for tests and for generating utility scales. */
export const SPACING_RAMP: readonly number[] = [4, 8, 12, 16, 24, 32, 48];

export type RadiusName = 'sm' | 'control' | 'card' | 'panel' | 'pill';

/**
 * Radii (DESIGN.md §4): 8 chips-in-rows, 12 controls AND cards, 20
 * panels/sheets, pill.
 *
 * DISAGREEMENT RESOLVED: mobile still carried the pre-redesign card 16 and
 * panel 24. DESIGN.md records the change explicitly ("card 16→12, panel 24→20
 * — tighter corners read as more precise") and web's tailwind.config.ts
 * already moved. Mobile's values are the stale ones and are dropped.
 */
export const radii: Readonly<Record<RadiusName, number>> = {
  sm: 8,
  control: 12,
  card: 12,
  panel: 20,
  pill: 999,
};

/** Spring parameters shared by Framer Motion (web) and Reanimated (mobile). */
export interface Spring {
  readonly stiffness: number;
  readonly damping: number;
}

/**
 * Motion (DESIGN.md §6). Durations in ms.
 *
 * DISAGREEMENT RESOLVED: mobile used 200ms for micro-interactions, web 220ms
 * (its `transitionDuration.220`, reserved for entrances). Both sit inside
 * DESIGN.md's 180–240ms band; 220 wins because web's is the one users see and
 * the band's endpoints are now recorded so neither side has to guess again.
 * Web's 150ms "standard" transition is not a third opinion — it is the
 * reduced-motion ceiling, kept here as `reducedMotionMaxMs`.
 */
export const motion = {
  /** Micro-interactions. Band 180–240ms; 220 is the default. */
  microMs: 220,
  microMinMs: 180,
  microMaxMs: 240,
  /** Panels and sheets. Band 280–320ms. */
  panelMs: 300,
  panelMinMs: 280,
  panelMaxMs: 320,
  /** Nothing in the system may animate longer than this. */
  maxMs: 400,
  /** Under `prefers-reduced-motion`, keep opacity fades and cap them here. */
  reducedMotionMaxMs: 150,
  spring: { stiffness: 260, damping: 30 } as Spring,
  /** CSS approximation of the spring above, for transitions that cannot use one. */
  springEasing: 'cubic-bezier(0.34, 1.3, 0.64, 1)',
  /** Page transitions fade and rise by this much (DESIGN.md §6). */
  pageRisePx: 12,
  typingDotStaggerMs: 120,
  emoteBurstMs: 2500,
  shimmerMs: 2400,
  /** The ambient conic aurora's full rotation (DESIGN.md §5.5). */
  auroraDriftMs: 60000,
  /** The sync pulse ring (DESIGN.md §5.4). */
  pulseRingMs: 1600,
} as const;

export type Motion = typeof motion;

/**
 * Named layout constants, all on the spacing scale (DESIGN.md §4, §7).
 *
 * DISAGREEMENT RESOLVED: mobile called the 44px touch target `minHit`, web
 * called it `tap`. One name: `tap`. Mobile's `tabBarHeight` had no web
 * counterpart and is kept as `tabBar`; web's `row`/`rail`/`edge` had no mobile
 * counterpart and mobile gains them.
 */
export const layout = {
  /** The active-row accent left edge. */
  edge: 3,
  /** Minimum touch target (DESIGN.md §9, non-negotiable). */
  tap: 44,
  /** Media row height — the `<MediaRow>` primitive. */
  row: 56,
  /** Right rail width on desktop. */
  rail: 380,
  /** Mobile bottom-sheet tab bar. */
  tabBar: 48,
} as const;

export type Layout = typeof layout;

/**
 * Font families (DESIGN.md §3). Stacks are ordered most- to least-preferred;
 * the first entry is the bundled face. Mobile falls back to the platform font
 * until the faces are loaded, which is why the stacks carry `system-ui`.
 */
export const fontFamily = {
  display: ['Space Grotesk', 'system-ui', 'sans-serif'],
  sans: ['Inter', 'system-ui', 'sans-serif'],
  mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type FontFamily = typeof fontFamily;
