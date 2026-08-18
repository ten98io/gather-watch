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
  /** px override for React Native when neither the floor nor the fluid
   *  ceiling is the designed RN size (hero: 28 is the small-web floor, 56 the
   *  large-web ceiling, 34 the RN step — the old displayL). */
  readonly rnFontSize?: number;
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
  // LEADING RETUNED (2026-08-18): 32/36 is 1.125 — a poster setting, and one of
  // the things that made the product read as a toy at a glance. A page title is
  // a document, not a banner; 32/40 is 1.25.
  display: { fontSize: 32, lineHeight: 40, fontWeight: 600, letterSpacing: -0.02 },
  // Same correction one step down: 20/26 (1.30) → 20/28 (1.40).
  title: { fontSize: 20, lineHeight: 28, fontWeight: 600, letterSpacing: -0.01 },
  // Web additionally scales the <body> font-size 15→17px at ≥1440px; that is
  // this step's `maxFontSize`. RN has no viewport unit and uses 15.
  body: { fontSize: 15, lineHeight: 22, fontWeight: 400, letterSpacing: 0, maxFontSize: 17 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: 500, letterSpacing: 0 },
  // Tracking 0.04 → 0.06em: 11px uppercase is the one place in the ramp where
  // under-tracking reads as cramped rather than tight.
  caption: { fontSize: 11, lineHeight: 14, fontWeight: 500, letterSpacing: 0.06, uppercase: true },
  // Marketing/auth heroes only — the one genuinely fluid step in the system.
  hero: {
    fontSize: 28,
    lineHeight: 29,
    fontWeight: 700,
    letterSpacing: -0.02,
    maxFontSize: 56,
    lineHeightRatio: 1.05,
    rnFontSize: 34,
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
 * Radii: 6 chips, 8 controls, 10 cards/rows, 14 panels/sheets, pill.
 *
 * ── Why these moved again (2026-08-18) ────────────────────────────────────
 * A corner radius is only ever legible RELATIVE to the height of the thing it
 * is cut into. The previous ladder (8 / 12 / 12 / 20) was authored against
 * touch-sized controls, and once `controlSizes` below tightened the desktop
 * button to 32px, a 12px corner was 0.38 of the control's height — the ratio a
 * toy has. This ladder holds every rung between 0.18 and 0.25 of its owner's
 * height, which is the band consumer software actually sits in.
 *
 *   sm      6   chips, badges in rows, menu items       6/28  = 0.21
 *   control 8   buttons, inputs, selects, icon buttons  8/32  = 0.25
 *   card    10  media rows, cards, popovers             10/56 = 0.18
 *   panel   14  glass panels, sheets, dialogs
 *
 * `control` and `card` were the SAME value before, so a 32px button and a 56px
 * row were cut identically; separating them is what makes a control read as a
 * control. Radii are only ever tightened here — never loosened — because a
 * looser corner is the single cheapest way back to looking cartoonish.
 *
 * DISAGREEMENT RESOLVED (kept from the earlier reconciliation): mobile still
 * carried the pre-redesign card 16 and panel 24, and lost.
 */
export const radii: Readonly<Record<RadiusName, number>> = {
  sm: 6,
  control: 8,
  card: 10,
  panel: 14,
  pill: 999,
};

export type ControlSizeName = 'sm' | 'md' | 'lg';

/**
 * One control size: everything a button, input or select needs to be drawn.
 *
 * `height` and `touchHeight` are the whole point — see `controlSizes`.
 */
export interface ControlSize {
  /** px. The height where the primary pointer is FINE (mouse/trackpad). */
  readonly height: number;
  /**
   * px. The height where the primary pointer is COARSE (finger). Never below
   * `layout.tap`; a guard test enforces that, because tightening desktop
   * density must not be paid for out of the touch target.
   */
  readonly touchHeight: number;
  /** px, horizontal padding. */
  readonly paddingX: number;
  /** px, icon-to-label gap. */
  readonly gap: number;
  /** The ramp step the label takes. */
  readonly text: TypeStepName;
  /** The corner it is cut with. */
  readonly radius: RadiusName;
}

/**
 * Control geometry — the token that carries "desktop density" across web,
 * mobile and the extension overlay at once.
 *
 * ── The problem this replaces ─────────────────────────────────────────────
 * apps/web hard-coded `h-9 / h-11 / h-12` (36 / 44 / 48px) in
 * components/ui/button.tsx, so the DEFAULT button was 44px tall on a desktop
 * beside 15px body text. 44px is a touch target, not a desktop control: it is
 * the single loudest reason the product read as "cartoonish". Professional
 * desktop density is 32–36px (Linear, GitHub Primer and Figma all sit at 32).
 *
 * ── Why two heights and not one ───────────────────────────────────────────
 * The honest answer to "tighten desktop without hurting touch" is that these
 * are two different questions with two different right answers, and the
 * platform already tells us which one it is being asked. `height` applies
 * under `(pointer: fine)`, `touchHeight` under `(pointer: coarse)` — a media
 * query, so it costs nothing at runtime and needs no JS, no breakpoint guess,
 * and no "is this a phone" heuristic. A desktop browser resized narrow keeps
 * the tight controls (it still has a mouse); a tablet at 1024px gets the
 * 44px ones (it does not). Emitted by `emitCssControlMetrics`.
 */
export const controlSizes: Readonly<Record<ControlSizeName, ControlSize>> = {
  sm: { height: 28, touchHeight: 44, paddingX: 10, gap: 6, text: 'label', radius: 'sm' },
  md: { height: 32, touchHeight: 44, paddingX: 12, gap: 8, text: 'label', radius: 'control' },
  lg: { height: 40, touchHeight: 48, paddingX: 20, gap: 8, text: 'body', radius: 'control' },
};

/** Emission order, smallest first. */
export const CONTROL_SIZE_NAMES: readonly ControlSizeName[] = ['sm', 'md', 'lg'];

export type ElevationName = 'e1' | 'e2' | 'e3';

/** One shadow layer. `x` is always 0 — light in this system comes from above. */
export interface ShadowLayer {
  /** px, downward offset. */
  readonly y: number;
  /** px, blur radius. */
  readonly blur: number;
  /** px, spread. Negative — it is what keeps a shadow from haloing. */
  readonly spread: number;
  /** 0–1, alpha of `INKS.inkBlack`. */
  readonly alpha: number;
}

/**
 * The elevation ladder — three neutral, directional shadows.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 * DESIGN.md §4 says "elevation is glow, not shadow", and the product took that
 * literally everywhere: a 40px aurora glow sat under the dropdown menu, the
 * dialog, the toast, the extension's floating panel, AND under a SECONDARY
 * button on hover. A coloured glow under ordinary chrome is a toy tell — it
 * says "look at me" about a context menu. Glow is still in the system and is
 * still the right answer for a signature moment (the listen-room hero artwork,
 * the playing indicator); it is no longer the answer for "this thing floats".
 *
 * Two layers each, because one layer cannot be both a contact shadow (short,
 * tight, says the edge is real) and an ambient one (long, soft, says how far
 * off the ground it is). Alphas are of the ABSOLUTE black ink, not of a theme
 * token: a shadow is an absence of light, and it must not invert with the
 * palette. In the dark theme these land quietly on a near-black ground, which
 * is correct — dark UIs separate by the surface ladder and use shadow only to
 * confirm an edge.
 */
export const elevation: Readonly<Record<ElevationName, readonly ShadowLayer[]>> = {
  /** Resting raised: a hovered card, an inline popover, a raised row. */
  e1: [
    { y: 1, blur: 2, spread: -1, alpha: 0.16 },
    { y: 2, blur: 6, spread: -2, alpha: 0.1 },
  ],
  /** Floating: dropdown menus, tooltips, toasts, the extension overlay panel. */
  e2: [
    { y: 4, blur: 10, spread: -4, alpha: 0.2 },
    { y: 12, blur: 24, spread: -10, alpha: 0.12 },
  ],
  /** Modal: dialogs and sheets — the only things allowed to look this far off the page. */
  e3: [
    { y: 8, blur: 20, spread: -8, alpha: 0.24 },
    { y: 28, blur: 56, spread: -20, alpha: 0.16 },
  ],
};

/** Emission order, nearest the page first. */
export const ELEVATION_NAMES: readonly ElevationName[] = ['e1', 'e2', 'e3'];

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
