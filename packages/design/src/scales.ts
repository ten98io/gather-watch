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
  /** px override for React Native when the web size is not the designed RN
   *  one — either because the step is fluid and RN has no viewport (hero: 40
   *  web floor, 88 web ceiling, 36 on a phone), or because the web size is an
   *  oversized display setting a 390pt screen cannot hold (display: 44 → 32).
   *  `emitRnTypeRamp` scales the leading with it, so a step keeps its ratio. */
  readonly rnFontSize?: number;
}

export type TypeStepName =
  | 'hero'
  | 'display'
  | 'headline'
  | 'title'
  | 'body'
  | 'label'
  | 'caption';

/**
 * The type ramp. Replaces ad-hoc `text-sm`/`text-xs` sizing; each step carries
 * size, line-height, weight and tracking together.
 *
 * ── Why the display end moved again (2026-08-19) ──────────────────────────
 * The ramp topped out at `display` 32 with `title` 20 under it, and that is a
 * dashboard ramp: the room title rendered at 14px, section heads at 20, and
 * nothing in the product was ever allowed to be BIG. A composition with no
 * display moment has no hierarchy — every element argues for the same
 * attention, which is exactly what the room read as.
 *
 * So the top of the ramp is now three steps rather than two, and it is
 * genuinely oversized:
 *
 *   hero      fluid 40→88   auth / marketing only, one per page
 *   display   44            the oversized moment — now-playing, empty states
 *   headline  28            room name, page + dialog titles
 *   title     20            section heads, card titles  (UNCHANGED)
 *
 * `title` deliberately did not move: it is the most-used step in the product
 * and every surface below already sits correctly against it. What was missing
 * was everything ABOVE it.
 *
 * Tracking tightens as size grows and never the other way (see the guard in
 * test/scales.test.ts). Large type set at default tracking is the other half
 * of "timid"; -0.045em on an 88px hero is the setting the reference aesthetic
 * actually uses. Below 17px tracking is 0 or positive — negative tracking on
 * small text is what makes it look squeezed.
 *
 * Leading tightens as size grows for the same optical reason. `body` went the
 * other way, 15/22 (1.47) → 16/26 (1.63): reading text wants MORE air, not
 * less, and 16px is the floor a body face should sit at on a desktop.
 */
export const typeRamp: Readonly<Record<TypeStepName, TypeStep>> = {
  // The one genuinely fluid step. RN has no viewport unit, so it carries an
  // explicit `rnFontSize`; `maxFontSize` is the WEB ceiling and never leaks.
  hero: {
    fontSize: 40,
    lineHeight: 42,
    fontWeight: 700,
    letterSpacing: -0.045,
    maxFontSize: 88,
    lineHeightRatio: 1.04,
    rnFontSize: 36,
  },
  // The display moment. 44/48 is 1.09 — poster leading, and correct here for
  // the same reason it was wrong at 32px: the leading a size wants is optical.
  // RN takes 32: 44px of title on a 390pt phone is not oversized, it is broken.
  display: {
    fontSize: 44,
    lineHeight: 48,
    fontWeight: 600,
    letterSpacing: -0.035,
    rnFontSize: 32,
  },
  headline: { fontSize: 28, lineHeight: 34, fontWeight: 600, letterSpacing: -0.025 },
  title: { fontSize: 20, lineHeight: 28, fontWeight: 600, letterSpacing: -0.01 },
  // Web additionally scales the <body> font-size 16→18px on wide viewports;
  // that is this step's `maxFontSize`. RN has no viewport unit and uses 16.
  body: { fontSize: 16, lineHeight: 26, fontWeight: 400, letterSpacing: 0, maxFontSize: 18 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: 500, letterSpacing: 0 },
  // Tracking 0.06 → 0.08em. An 11px uppercase overline is the one place in the
  // ramp where the type is doing structural work, and it needs the air to read
  // as a rule rather than as shouting.
  caption: { fontSize: 11, lineHeight: 14, fontWeight: 500, letterSpacing: 0.08, uppercase: true },
};

export type SpacingName =
  | 'xs'
  | 'sm'
  | 'md'
  | 'lg'
  | 'xl'
  | 'xxl'
  | 'xxxl'
  | 'section'
  | 'chapter'
  | 'canvas';

/**
 * The spacing ramp: 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 · 128. No
 * arbitrary values in new code.
 *
 * ── Why it grew a top end (2026-08-19) ────────────────────────────────────
 * It stopped at 48, and a ramp that stops at 48 cannot express a composition —
 * only a component. Every gap in the product therefore came from the same
 * four rungs, so nothing had more room around it than anything else, and
 * uniform spacing reads as uniform importance. Editorial hierarchy is made
 * mostly of whitespace, not of type size, and the whitespace has to be
 * available before a surface can spend it.
 *
 * The three new rungs are named by ROLE rather than by another `x`, because
 * their job is compositional and a reader picking between `xxxl` and `xxxxl`
 * has no way to guess:
 *
 *   section  64   between blocks inside one composition (stage → rail sections)
 *   chapter  96   around a display moment, between major regions of a page
 *   canvas  128   the breathing room a signature empty state or hero sits in
 *
 * The first seven rungs did NOT move: everything downstream is measured
 * against them.
 */
export const spacing: Readonly<Record<SpacingName, number>> = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  section: 64,
  chapter: 96,
  canvas: 128,
};

/** The ramp as an ordered list, for tests and for generating utility scales. */
export const SPACING_RAMP: readonly number[] = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128];

export type RadiusName = 'sm' | 'control' | 'card' | 'panel' | 'stage' | 'pill';

/**
 * Radii: 6 chips, 8 controls, 14 cards/rows, 20 panels/sheets, 28 stage, pill.
 *
 * ── Why the large end moved (2026-08-19) ──────────────────────────────────
 * 6 / 8 / 10 / 14 was the timid middle: every rung close enough to its
 * neighbour that no surface read as a different KIND of thing. A radius ladder
 * only says anything when its ends are far apart — controls crisp, large
 * surfaces genuinely soft — so the ends are now committed to and the small end
 * is unchanged.
 *
 *   sm      6   chips, badges in rows, menu items         6/28  = 0.21
 *   control 8   buttons, inputs, selects, icon buttons    8/32  = 0.25
 *   card   14   media rows, cards, popovers              14/56  = 0.25
 *   panel  20   glass panels, sheets, dialogs
 *   stage  28   the oversized surfaces — now-playing artwork, the stage frame,
 *               a signature empty state's plate
 *
 * ── The rule this replaces, and why it was wrong ──────────────────────────
 * The previous note here said "radii are only ever tightened, never loosened",
 * on the reasoning that a looser corner is the cheapest way back to looking
 * cartoonish. That is true of a CONTROL and false of a large surface: what
 * reads as cartoonish is a corner that is a large FRACTION of its owner's
 * height, which is why the guard in test/scales.test.ts is a ratio and not a
 * value. `control` stays 8 for exactly that reason. A 28px corner on a 480px
 * stage plate is 0.06 of its height — the opposite end of the same rule.
 */
export const radii: Readonly<Record<RadiusName, number>> = {
  sm: 6,
  control: 8,
  card: 14,
  panel: 20,
  stage: 28,
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

/** The colour a shadow layer is a wash of. Not a free choice — see `elevation`. */
export type ShadowWash = 'ink' | 'hairline';

/** One shadow layer. `x` is always 0 — light in this system comes from above. */
export interface ShadowLayer {
  /** px, downward offset. */
  readonly y: number;
  /** px, blur radius. 0 on the hairline ring. */
  readonly blur: number;
  /** px. Positive on the hairline ring (it IS the ring); negative on a blurred
   *  layer, where it is what keeps the shadow from haloing. */
  readonly spread: number;
  /** 0–1, alpha of whichever colour `wash` names. */
  readonly alpha: number;
  /**
   * `ink` is the ABSOLUTE black (`INKS.inkBlack`), never a theme token: a
   * shadow is an absence of light and must not invert with the palette.
   * `hairline` is `--hairline`, which is theme-relative BY DESIGN — the crisp
   * edge that reads on a near-black ground is a light one and on paper a dark
   * one, and a black ring on the dark theme is simply invisible.
   */
  readonly wash: ShadowWash;
}

/**
 * The elevation ladder — a crisp 1px hairline ring plus one soft shadow.
 *
 * ── Why this shape (2026-08-19) ───────────────────────────────────────────
 * It used to be two blurred layers per level, a contact shadow under an
 * ambient one. That is how depth was drawn when surfaces were opaque and
 * screens were 1x: stacked blur reads as SOFT, and soft is the opposite of
 * crafted. What the current tier of consumer software actually does is define
 * the edge exactly — one hairline, one device pixel, no blur — and then let a
 * single wide, quiet shadow say how far off the page the thing is. The edge
 * carries the precision; the shadow carries the distance.
 *
 * So each level is exactly two layers and they are not interchangeable:
 *
 *   layer 0   `0 0 0 1px --hairline`   the ring. Same at every level: an edge
 *                                      is either real or it is not; it does
 *                                      not get realer as a panel floats higher.
 *   layer 1   `0 Ypx Bpx -Spx ink`     the distance. This is the only thing
 *                                      that climbs.
 *
 * ── Why the ring is theme-relative and the shadow is not ──────────────────
 * They answer different questions. "Where does this surface end" is a question
 * about the palette (light edge on dark, dark edge on paper). "How far off the
 * page is it" is a question about light, and light does not invert.
 *
 * Glow is still in the system and is still the right answer for a signature
 * moment (DESIGN.md §5); it is not the answer for "this thing floats".
 */
export const elevation: Readonly<Record<ElevationName, readonly ShadowLayer[]>> = {
  /** Resting raised: a hovered card, an inline popover, a raised row. */
  e1: [
    { y: 0, blur: 0, spread: 1, alpha: 1, wash: 'hairline' },
    { y: 2, blur: 8, spread: -3, alpha: 0.16, wash: 'ink' },
  ],
  /** Floating: dropdown menus, tooltips, toasts, the extension overlay panel. */
  e2: [
    { y: 0, blur: 0, spread: 1, alpha: 1, wash: 'hairline' },
    { y: 10, blur: 30, spread: -8, alpha: 0.24, wash: 'ink' },
  ],
  /** Modal: dialogs and sheets — the only things allowed to look this far off the page. */
  e3: [
    { y: 0, blur: 0, spread: 1, alpha: 1, wash: 'hairline' },
    { y: 24, blur: 64, spread: -16, alpha: 0.3, wash: 'ink' },
  ],
};

/** Emission order, nearest the page first. */
export const ELEVATION_NAMES: readonly ElevationName[] = ['e1', 'e2', 'e3'];

/**
 * Grain — the one texture in the system, and the reason the product can read
 * as crafted rather than as glossy.
 *
 * ── Why it is a token and not a stylesheet detail ─────────────────────────
 * It was two percent of noise hand-written into apps/web/app/globals.css and
 * available to nothing else, so the extension overlay and mobile had no
 * texture at all and the web app had it only on <body>. A value that only one
 * of three renderers can reach is the same drift `tokens.ts` exists to stop.
 *
 * ── Why an inline SVG and not an asset ────────────────────────────────────
 * The extension overlay is injected into a page it does not control and the
 * web app ships a CSP; neither may fetch an external image. `feTurbulence` is
 * generated by the renderer from the string below, so there is no request.
 *
 * ── Where it may be used ──────────────────────────────────────────────────
 * The void, and large quiet surfaces (a stage plate, a full-bleed empty state,
 * a sheet). NOT on rows, controls, chips or anything under 200px — at that
 * size the tile repeats visibly and reads as dirt. Never over video, never
 * over text, and it must never carry information: a host page with a strict
 * `img-src` will drop the data URI and the surface has to still be complete.
 *
 * 3.5% is the band where grain is FELT and not SEEN. Above ~5% it is a
 * pattern; below ~2% it does not survive the display's own dithering.
 */
const GRAIN_TILE_PX = 160;
const GRAIN_OPACITY = 0.035;

/** `%23` is `#` — the URI is not quoted for us, so the fragment must be escaped. */
const grainDataUri = (tile: number, opacity: number): string =>
  'url("data:image/svg+xml,' +
  `%3Csvg xmlns='http://www.w3.org/2000/svg' width='${tile}' height='${tile}'%3E` +
  "%3Cfilter id='g'%3E" +
  "%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3'" +
  " stitchTiles='stitch'/%3E" +
  "%3CfeColorMatrix type='saturate' values='0'/%3E" +
  '%3C/filter%3E' +
  `%3Crect width='100%25' height='100%25' filter='url(%23g)' opacity='${opacity}'/%3E` +
  '%3C/svg%3E")';

export const texture = {
  /** px. `stitchTiles` makes the noise seamless at exactly this size. */
  grainTilePx: GRAIN_TILE_PX,
  /** Baked into the SVG, so `--grain` is one value and not two to compose. */
  grainOpacity: GRAIN_OPACITY,
  /** A ready `background-image` value. Emitted as `--grain`. */
  grain: grainDataUri(GRAIN_TILE_PX, GRAIN_OPACITY),
} as const;

export type Texture = typeof texture;

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
