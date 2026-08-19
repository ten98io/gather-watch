/**
 * CSS custom-property emitters.
 *
 * Owns: CSS syntax for the tokens — `oklch()`, `var()`, `rgba()` — and the
 * three block shapes the product needs: the web app's `:root[data-theme]`
 * pair, a shadow root's `:host` set, and the theme-independent scale variables.
 *
 * Deliberately NOT: file I/O, a build step, or anything Tailwind-shaped. These
 * are pure string functions of the tokens; whoever wants a file writes one.
 *
 * ── Why a shadow-root variant is a first-class call ───────────────────────
 * A shadow tree inherits nothing from the page's stylesheet, so the extension
 * overlay cannot reach `:root`'s custom properties — it needs its own copy of
 * the whole block. That copy being hand-maintained is exactly how the overlay
 * ended up on a generic blue/grey palette with no aurora in it at all. It is a
 * function call now.
 *
 * ── Why `oklch(L C H / A)` and not `color-mix(…, transparent)` ────────────
 * The hand-written CSS spelled translucent tokens
 * `color-mix(in oklch, white 5%, transparent)`. Mixing with `transparent`
 * premultiplies, so that expression is exactly `oklch(1 0 0 / 0.05)` — same
 * colour, one function fewer, and legible at a glance. Anyone diffing against
 * the old globals.css should expect this substitution and nothing else.
 */

import type { Oklch } from './oklch';
import type { ColorTokenName, ThemeName } from './tokens';
import { hexToRgb, oklchToHex } from './oklch';
import {
  COLOR_TOKEN_NAMES,
  FILL_TOKENS,
  INK_ON_GRADIENT_CSS_VAR,
  INKS,
  colorTokens,
  cssVarName,
  inkCssVarName,
  inkOn,
  inkOnCssVarName,
  inkOnGradient,
} from './tokens';
import {
  CONTROL_SIZE_NAMES,
  ELEVATION_NAMES,
  controlSizes,
  elevation,
  fontFamily,
  layout,
  motion,
  radii,
  spacing,
  texture,
  typeRamp,
} from './scales';

/** `oklch(…)` keeps the authored colour; `hex` renders it for older targets. */
export type CssColorFormat = 'oklch' | 'hex';

export interface CssEmitOptions {
  /** Default `'oklch'` — the authored form, and what the browser should mix in. */
  readonly colorFormat?: CssColorFormat;
  /** Prepended to every declaration. Default two spaces. */
  readonly indent?: string;
  /** Default true. Notes carry the rationale a future editor would trip on. */
  readonly includeComments?: boolean;
}

export interface CssThemeBlockOptions extends CssEmitOptions {
  /** Default `:root[data-theme='dark']`, matching apps/web today. */
  readonly darkSelector?: string;
  /** Default `:root[data-theme='light']`. */
  readonly lightSelector?: string;
  /** Also emit the theme-independent scale variables. Default false. */
  readonly includeScales?: boolean;
}

export interface ShadowRootCssOptions extends CssEmitOptions {
  /** Default `:host`. */
  readonly hostSelector?: string;
  /**
   * Emit a `prefers-color-scheme: light` block so an un-attributed shadow root
   * follows the reader's system setting. Default true.
   */
  readonly followSystemTheme?: boolean;
  /** Also emit the scale variables. Default true — a shadow root has no Tailwind. */
  readonly includeScales?: boolean;
}

/** Notes at or under this length ride on the declaration; longer ones get a line. */
const INLINE_COMMENT_MAX = 40;

/** Trim float noise without turning `285` into `285.000000`. */
function formatNumber(value: number): string {
  const rounded = Number(value.toFixed(6));
  return String(rounded);
}

/** `oklch(0.13 0.02 285)`, or `oklch(1 0 0 / 0.05)` when `alpha` is given. */
export function formatOklch(color: Oklch, alpha?: number): string {
  const base = `${formatNumber(color.l)} ${formatNumber(color.c)} ${formatNumber(color.h)}`;
  return alpha === undefined
    ? `oklch(${base})`
    : `oklch(${base} / ${formatNumber(alpha)})`;
}

/** `rgba(255,255,255,0.05)`. No spaces, matching what React Native accepts. */
export function formatRgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${formatNumber(alpha)})`;
}

/**
 * The CSS value for one token. Aliases stay `var(--other)` in both formats:
 * the indirection is load-bearing, because listen rooms rebind `--accent` at
 * runtime and everything aliased to it has to follow.
 */
export function formatColorToken(
  theme: ThemeName,
  name: ColorTokenName,
  format: CssColorFormat = 'oklch',
): string {
  const token = colorTokens[theme][name];
  switch (token.kind) {
    case 'alias':
      return `var(${cssVarName(token.of)})`;
    case 'overlay':
      return format === 'hex'
        ? formatRgba(oklchToHex(token.over), token.alpha)
        : formatOklch(token.over, token.alpha);
    case 'solid':
      return format === 'hex' ? oklchToHex(token.value) : formatOklch(token.value);
  }
}

interface Declaration {
  readonly property: string;
  readonly value: string;
  readonly note?: string;
}

function renderDeclarations(
  declarations: readonly Declaration[],
  indent: string,
  includeComments: boolean,
): string {
  const width = declarations.reduce((max, d) => Math.max(max, d.property.length), 0);
  const lines: string[] = [];
  for (const d of declarations) {
    const note = includeComments ? d.note : undefined;
    if (note !== undefined && note.length > INLINE_COMMENT_MAX) {
      lines.push(`${indent}/* ${note} */`);
    }
    const declaration = `${indent}${`${d.property}:`.padEnd(width + 2)}${d.value};`;
    lines.push(
      note !== undefined && note.length <= INLINE_COMMENT_MAX
        ? `${declaration}  /* ${note} */`
        : declaration,
    );
  }
  return lines.join('\n');
}

function colorDeclarations(theme: ThemeName, format: CssColorFormat): Declaration[] {
  return COLOR_TOKEN_NAMES.map((name) => {
    const token = colorTokens[theme][name];
    const property = cssVarName(name);
    const value = formatColorToken(theme, name, format);
    return token.note === undefined ? { property, value } : { property, value, note: token.note };
  });
}

/**
 * The ink group: the two absolute inks, then one `--ink-on-<fill>` per filled
 * control pointing at whichever of them clears WCAG AA on that fill.
 *
 * Emitted per theme even though the two inks are theme-independent, because
 * WHICH one a fill takes is not — dark's fills are vivid and light and nearly
 * all take black, most of light's take white. That is the whole correction:
 * `--accent-ink` flipped with the theme while the fills under it did not, so
 * every filled label in dark mode measured under 4.5:1.
 *
 * `var(--ink-black)` rather than a literal so a listen room rebinding
 * `--accent` to an artwork colour can retarget `--ink-on-accent` by name.
 */
function inkDeclarations(theme: ThemeName, format: CssColorFormat): Declaration[] {
  const declarations: Declaration[] = [
    {
      property: inkCssVarName('inkBlack'),
      value: format === 'hex' ? INKS.inkBlack.hex : formatOklch(INKS.inkBlack.oklch),
      note: 'ink on a filled control — absolute, chosen per fill, never per theme',
    },
    {
      property: inkCssVarName('inkWhite'),
      value: format === 'hex' ? INKS.inkWhite.hex : formatOklch(INKS.inkWhite.oklch),
    },
  ];
  for (const fill of FILL_TOKENS) {
    declarations.push({
      property: inkOnCssVarName(fill),
      value: `var(${inkCssVarName(inkOn(theme, fill).name)})`,
    });
  }
  // The gradient is three fills under one label, so it needs its own ink — the
  // one whose worst stop is best. See `inkOnGradient`.
  declarations.push({
    property: INK_ON_GRADIENT_CSS_VAR,
    value: `var(${inkCssVarName(inkOnGradient(theme).name)})`,
    note: 'a label crossing all three aurora stops takes one ink',
  });
  return declarations;
}

/**
 * Just the declarations for one theme — no selector, no braces.
 *
 * Two groups, separately aligned: the palette, then the ink. Separate so that
 * adding the longer `--ink-on-aurora-1` name does not re-pad every colour
 * declaration in the generated stylesheets.
 */
export function emitCssVariables(theme: ThemeName, options: CssEmitOptions = {}): string {
  const format = options.colorFormat ?? 'oklch';
  const indent = options.indent ?? '  ';
  const comments = options.includeComments ?? true;
  return [
    renderDeclarations(colorDeclarations(theme, format), indent, comments),
    renderDeclarations(inkDeclarations(theme, format), indent, comments),
  ].join('\n\n');
}

/** One `selector { … }` block for one theme. */
export function emitCssBlock(
  selector: string,
  theme: ThemeName,
  options: CssEmitOptions = {},
): string {
  return `${selector} {\n${emitCssVariables(theme, options)}\n}`;
}

/**
 * One elevation level as a `box-shadow` value: the hairline ring, then the
 * soft shadow (DESIGN.md §4).
 *
 * The two layers name different colours on purpose. The shadow is a wash of
 * `--ink-black` — an absence of light, which must not invert when the palette
 * does. The ring is a wash of `--hairline`, which MUST invert: the edge that
 * reads on a near-black ground is a light one, and a black ring on the dark
 * theme draws nothing at all. Both go through `var()` rather than a literal so
 * every colour in the emitted stylesheet stays addressable by name.
 *
 * A layer at alpha 1 emits the variable itself rather than a `color-mix` with
 * 100% of it, which is the same colour and one function fewer to read.
 */
export function formatElevation(name: (typeof ELEVATION_NAMES)[number]): string {
  return elevation[name]
    .map((layer) => {
      const source = layer.wash === 'hairline' ? cssVarName('hairline') : inkCssVarName('inkBlack');
      const color =
        layer.alpha === 1
          ? `var(${source})`
          : `color-mix(in oklch, var(${source}) ${formatNumber(layer.alpha * 100)}%, transparent)`;
      // `0` rather than `0px` where a length is zero: the ring is the shape
      // `0 0 0 1px`, and spelling it `0 0px 0px 1px` reads as an accident.
      const len = (value: number): string => (value === 0 ? '0' : `${value}px`);
      return `0 ${len(layer.y)} ${len(layer.blur)} ${len(layer.spread)} ${color}`;
    })
    .join(', ');
}

/**
 * Theme-independent geometry, type, elevation and motion as custom properties.
 *
 * The web app reads most of these through Tailwind instead, but a shadow root
 * has no Tailwind and an email/canvas target has no build step, so they are
 * available as variables too. Names mirror the token names: `--space-lg`,
 * `--radius-panel`, `--text-body-size`, `--elevation-e2`, `--dur-micro`,
 * `--layout-rail`.
 */
export function emitCssScaleVariables(options: CssEmitOptions = {}): string {
  const declarations: Declaration[] = [];
  for (const [name, value] of Object.entries(spacing)) {
    declarations.push({ property: `--space-${name}`, value: `${value}px` });
  }
  for (const [name, value] of Object.entries(radii)) {
    declarations.push({ property: `--radius-${name}`, value: `${value}px` });
  }
  for (const [name, value] of Object.entries(layout)) {
    declarations.push({ property: `--layout-${name}`, value: `${value}px` });
  }
  for (const [name, step] of Object.entries(typeRamp)) {
    declarations.push({ property: `--text-${name}-size`, value: `${step.fontSize}px` });
    declarations.push({
      property: `--text-${name}-line`,
      value:
        step.lineHeightRatio === undefined
          ? `${step.lineHeight}px`
          : formatNumber(step.lineHeightRatio),
    });
    declarations.push({ property: `--text-${name}-weight`, value: String(step.fontWeight) });
    declarations.push({
      property: `--text-${name}-tracking`,
      value: step.letterSpacing === 0 ? '0' : `${formatNumber(step.letterSpacing)}em`,
    });
  }
  for (const name of ELEVATION_NAMES) {
    declarations.push({ property: `--elevation-${name}`, value: formatElevation(name) });
  }
  declarations.push({ property: '--dur-micro', value: `${motion.microMs}ms` });
  declarations.push({ property: '--dur-panel', value: `${motion.panelMs}ms` });
  declarations.push({ property: '--dur-max', value: `${motion.maxMs}ms` });
  declarations.push({ property: '--dur-reduced', value: `${motion.reducedMotionMaxMs}ms` });
  declarations.push({ property: '--ease-spring', value: motion.springEasing });
  for (const [name, stack] of Object.entries(fontFamily)) {
    declarations.push({
      property: `--font-${name}`,
      value: stack.map((f) => (f.includes(' ') ? `'${f}'` : f)).join(', '),
    });
  }
  // Grain (DESIGN.md §4). A `background-image` plus the tile it repeats on, so
  // a consumer writes two properties and never re-derives the noise. The data
  // URI is self-contained by requirement, not by preference: the extension
  // overlay is injected into a page whose CSP it does not control.
  declarations.push({ property: '--grain', value: texture.grain });
  declarations.push({
    property: '--grain-size',
    value: `${texture.grainTilePx}px ${texture.grainTilePx}px`,
  });
  return renderDeclarations(declarations, options.indent ?? '  ', options.includeComments ?? true);
}

/**
 * Control geometry, as the ONE thing in the system that has to be a runtime CSS
 * variable rather than a build-time constant.
 *
 * Every other scale can be inlined by Tailwind or by RN, because it is the same
 * number everywhere. A control's height is not: it is 32px where there is a
 * mouse and 44px where there is a finger, and which of those is true is a
 * property of the device, not of the build. `@media (pointer: coarse)` is the
 * browser answering that question directly — no breakpoint guess, no user-agent
 * sniff, no JS, and correct for the cases a width breakpoint gets wrong in both
 * directions (a desktop window dragged narrow keeps its mouse; a 1024px tablet
 * does not have one).
 *
 * Emitted as `--control-h-md`, `--control-px-md`, `--control-gap-md`. Only the
 * heights move under coarse pointers — padding and gap are proportions of the
 * label, not of the target.
 */
export function emitCssControlMetrics(
  selector: string = ':root',
  options: CssEmitOptions = {},
): string {
  const indent = options.indent ?? '  ';
  const comments = options.includeComments ?? true;

  const base: Declaration[] = [];
  for (const name of CONTROL_SIZE_NAMES) {
    const size = controlSizes[name];
    base.push({ property: `--control-h-${name}`, value: `${size.height}px` });
    base.push({ property: `--control-px-${name}`, value: `${size.paddingX}px` });
    base.push({ property: `--control-gap-${name}`, value: `${size.gap}px` });
  }

  const touch: Declaration[] = CONTROL_SIZE_NAMES.map((name) => ({
    property: `--control-h-${name}`,
    value: `${controlSizes[name].touchHeight}px`,
  }));

  const head = comments
    ? `${indent}/* Desktop density. The coarse-pointer block below is the touch answer. */\n`
    : '';
  const coarseHead = comments
    ? `${indent}/* A finger, not a mouse: every control goes back to a ${layout.tap}px target. */\n`
    : '';

  return (
    `${selector} {\n${head}${renderDeclarations(base, indent, comments)}\n}\n\n` +
    `@media (pointer: coarse) {\n${coarseHead}${indent}${selector} {\n` +
    `${renderDeclarations(touch, `${indent}${indent}`, comments)}\n${indent}}\n}`
  );
}

const GENERATED_BANNER =
  '/* Generated by @gather/design — do not edit by hand. Change packages/design/src/tokens.ts. */';

/**
 * Both theme blocks, in the selector shape apps/web already uses. This is the
 * whole of what globals.css needs to stop hand-maintaining.
 */
export function emitCssThemes(options: CssThemeBlockOptions = {}): string {
  const dark = options.darkSelector ?? ":root[data-theme='dark']";
  const light = options.lightSelector ?? ":root[data-theme='light']";
  const parts = [
    GENERATED_BANNER,
    emitCssBlock(dark, 'dark', options),
    emitCssBlock(light, 'light', options),
  ];
  if (options.includeScales === true) {
    parts.push(`:root {\n${emitCssScaleVariables(options)}\n}`);
    parts.push(emitCssControlMetrics(':root', options));
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * The same palette, addressed to a shadow root.
 *
 * Three states, deliberately: `:host` carries dark (DESIGN.md's primary
 * theme), `:host([data-theme='light'])` lets the host element opt in
 * explicitly, and the media block covers a host that has said nothing and
 * should follow the system. The `:not([data-theme='dark'])` guard is what
 * stops the media query overriding an explicit dark choice.
 */
export function emitShadowRootCss(options: ShadowRootCssOptions = {}): string {
  const host = options.hostSelector ?? ':host';
  const indent = options.indent ?? '  ';
  const parts: string[] = [GENERATED_BANNER];

  const scales = options.includeScales ?? true;
  const dark = scales
    ? `${emitCssVariables('dark', options)}\n\n${emitCssScaleVariables(options)}`
    : emitCssVariables('dark', options);
  parts.push(`${host} {\n${dark}\n}`);
  if (scales) parts.push(emitCssControlMetrics(host, options));
  parts.push(`${host}([data-theme='light']) {\n${emitCssVariables('light', options)}\n}`);

  if (options.followSystemTheme ?? true) {
    const inner = emitCssVariables('light', { ...options, indent: `${indent}${indent}` });
    parts.push(
      `@media (prefers-color-scheme: light) {\n` +
        `${indent}${host}(:not([data-theme='dark'])) {\n${inner}\n${indent}}\n}`,
    );
  }

  return `${parts.join('\n\n')}\n`;
}
