/**
 * The drift guard between apps/web and @gather/design.
 *
 * Owns: proving that app/tokens.generated.css is still what the package emits,
 * that globals.css writes no colour of its own, and that every token reaches
 * Tailwind as `var(--token)` and not as a resolved colour — the runtime rebinds
 * `--accent` per track, so a baked accent would break listen rooms in a way no
 * type checker would notice.
 *
 * Deliberately NOT: an opinion on whether the palette is any good. Contrast
 * ratios, gamut mapping and the ladder's legibility are packages/design/test's
 * problem. This file only asserts that web is reading the same numbers.
 *
 * After changing packages/design/src, regenerate rather than hand-edit:
 *   pnpm --filter @gather/design build
 *   pnpm --filter @gather/web tokens:generate
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COLOR_TOKEN_NAMES,
  CONTROL_SIZE_NAMES,
  ELEVATION_NAMES,
  controlSizes,
  cssVarName,
  emitCssThemes,
  fontFamily,
  layout,
  motion,
  radii,
  typeRamp,
} from '@gather/design';
import tailwindConfig from '../tailwind.config';

/**
 * Web takes the scale variables too, not only the palette.
 *
 * It did not use to: scales reached web through Tailwind alone, and globals.css
 * paid for that by hand-writing `border-radius: 20px` on `.glass-panel` and
 * `12px` on `.glass-raised` — the radius ladder, copied, and free to drift from
 * it. It also has to: a control's height is the one token that must resolve at
 * RUNTIME, because `@media (pointer: coarse)` is what decides it.
 */
const EMIT_OPTIONS = { includeScales: true } as const;

const GENERATED_CSS_PATH = fileURLToPath(new URL('../app/tokens.generated.css', import.meta.url));
const GLOBALS_CSS_PATH = fileURLToPath(new URL('../app/globals.css', import.meta.url));

/** `pnpm --filter @gather/web tokens:generate` sets this; CI never does. */
const REGENERATE = process.env.UPDATE_TOKENS === '1';

const globalsCss = readFileSync(GLOBALS_CSS_PATH, 'utf8');

/** Missing reads as empty so a deleted file fails as a diff, not as an ENOENT. */
const readGenerated = (): string =>
  existsSync(GENERATED_CSS_PATH) ? readFileSync(GENERATED_CSS_PATH, 'utf8') : '';

/**
 * Tailwind's own types describe `extend` as deeply resolvable (values may be
 * functions of the theme), which none of ours are. Read them back concretely.
 */
const extend = (tailwindConfig.theme?.extend ?? {}) as unknown as {
  colors: Record<string, string>;
  fontFamily: Record<string, string[]>;
  fontSize: Record<string, [string, Record<string, string>]>;
  borderRadius: Record<string, string>;
  spacing: Record<string, string>;
  boxShadow: Record<string, string>;
  transitionTimingFunction: Record<string, string>;
  transitionDuration: Record<string, string>;
  animation: Record<string, string>;
};

describe('generated token stylesheet', () => {
  it('is exactly what @gather/design emits', () => {
    const expected = emitCssThemes(EMIT_OPTIONS);
    if (REGENERATE) {
      writeFileSync(GENERATED_CSS_PATH, expected, 'utf8');
    }
    const actual = readGenerated();
    expect(
      actual,
      'app/tokens.generated.css is stale — run `pnpm --filter @gather/web tokens:generate`',
    ).toBe(expected);
  });

  it('is the only place globals.css gets its colours', () => {
    expect(globalsCss).toContain("@import './tokens.generated.css';");
    // `color-mix(in oklch, …)` is fine — it composes a token. A bare `oklch(`
    // or a hex literal is a value being written down a second time.
    expect(globalsCss).not.toMatch(/oklch\(/);
    expect(globalsCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('defines every token in both themes', () => {
    const generated = readGenerated();
    for (const token of COLOR_TOKEN_NAMES) {
      const declarations = generated.split(`${cssVarName(token)}:`).length - 1;
      expect(declarations, `${cssVarName(token)} declarations`).toBe(2);
    }
  });
});

describe('tailwind colour bindings', () => {
  it('covers every token exactly once', () => {
    expect(Object.keys(extend.colors)).toHaveLength(COLOR_TOKEN_NAMES.length);
    for (const token of COLOR_TOKEN_NAMES) {
      expect(Object.values(extend.colors)).toContain(`var(${cssVarName(token)})`);
    }
  });

  it('resolves through custom properties, never a baked colour', () => {
    for (const [utility, value] of Object.entries(extend.colors)) {
      expect(value, `bg-${utility}`).toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
  });

  it('leaves --accent overridable, which listen rooms depend on', () => {
    // ListenStage.tsx sets style={{ '--accent': <artwork colour> }} on the
    // stage, and .slider-aurora colours from var(--accent) for the same reason.
    expect(extend.colors.accent).toBe('var(--accent)');
    expect(globalsCss).toContain('var(--accent)');
  });

  it('keeps the class names components already use', () => {
    // Renaming any of these is a codemod, not a config edit.
    for (const utility of ['void', 'surface-1', 'hi', 'low', 'accent', 'ring', 'border-glass']) {
      expect(Object.keys(extend.colors)).toContain(utility);
    }
  });
});

describe('tailwind scale bindings', () => {
  it('takes the type ramp from the package', () => {
    for (const [name, step] of Object.entries(typeRamp)) {
      const entry = extend.fontSize[name];
      expect(entry, `text-${name}`).toBeDefined();
      const [size, meta] = entry as [string, Record<string, string>];
      expect(meta.fontWeight, `text-${name} weight`).toBe(String(step.fontWeight));
      if (step.lineHeightRatio === undefined) {
        expect(size, `text-${name} size`).toBe(`${step.fontSize / 16}rem`);
        expect(meta.lineHeight, `text-${name} line-height`).toBe(`${step.lineHeight / 16}rem`);
      } else {
        // Fluid steps clamp between the ramp's floor and its ceiling; the
        // interpolation between them is a web viewport tuning, not a token.
        expect(size, `text-${name} floor`).toMatch(
          new RegExp(`^clamp\\(${step.fontSize / 16}rem,`),
        );
        expect(size, `text-${name} ceiling`).toMatch(
          new RegExp(`${(step.maxFontSize ?? 0) / 16}rem\\)$`),
        );
        expect(meta.lineHeight, `text-${name} line-height`).toBe(String(step.lineHeightRatio));
      }
      if (step.letterSpacing === 0) {
        expect(meta.letterSpacing, `text-${name} tracking`).toBeUndefined();
      } else {
        expect(meta.letterSpacing, `text-${name} tracking`).toBe(`${step.letterSpacing}em`);
      }
    }
  });

  it('takes every radius from the package', () => {
    const expected = Object.values(radii)
      .map((value) => `${value}px`)
      .sort();
    expect(Object.values(extend.borderRadius).sort()).toEqual(expected);
    expect(extend.borderRadius.ctl).toBe(`${radii.control}px`);
  });

  it('takes the layout constants from the package', () => {
    expect(extend.spacing.edge).toBe(`${layout.edge}px`);
    expect(extend.spacing.tap).toBe(`${layout.tap}px`);
    expect(extend.spacing.row).toBe(`${layout.row}px`);
    expect(extend.spacing.rail).toBe(`${layout.rail}px`);
  });

  it('leaves control heights as var(), never as a baked number', () => {
    // A baked height would be one number for both device classes, and the one
    // that would get baked is the desktop one — which is how you ship a 32px
    // touch target. The custom property is what lets the coarse-pointer block
    // in tokens.generated.css raise it back to `tap`.
    for (const name of CONTROL_SIZE_NAMES) {
      expect(extend.spacing[`ctl-${name}`], `h-ctl-${name}`).toBe(`var(--control-h-${name})`);
      expect(extend.spacing[`ctl-x-${name}`], `px-ctl-x-${name}`).toBe(`var(--control-px-${name})`);
      expect(extend.spacing[`ctl-g-${name}`], `gap-ctl-g-${name}`).toBe(
        `var(--control-gap-${name})`,
      );
      expect(String(extend.spacing[`ctl-${name}`])).not.toContain(
        `${controlSizes[name].height}px`,
      );
    }
  });

  it('binds the neutral elevation ladder and keeps glow apart from it', () => {
    for (const name of ELEVATION_NAMES) {
      expect(extend.boxShadow[name], `shadow-${name}`).toBe(`var(--elevation-${name})`);
    }
    // Glow survives, and stays the aurora — it is a signature moment, not a
    // depth cue. If these ever became the same value the distinction is gone.
    expect(extend.boxShadow.glow).toContain('--aurora-1');
    expect(extend.boxShadow.glow).not.toContain('--elevation-');
  });

  it('takes motion from the package', () => {
    expect(extend.transitionTimingFunction.spring).toBe(motion.springEasing);
    expect(extend.transitionDuration[String(motion.microMs)]).toBe(`${motion.microMs}ms`);
    expect(extend.animation['fade-in']).toContain(`${motion.microMs}ms`);
    expect(extend.animation.shimmer).toContain(`${motion.shimmerMs}ms`);
    expect(extend.animation['aurora-drift']).toContain(`${motion.auroraDriftMs}ms`);
    expect(extend.animation['pulse-ring']).toContain(`${motion.pulseRingMs}ms`);
  });

  it('keeps next/font in front of the package font stacks', () => {
    for (const family of ['display', 'sans', 'mono'] as const) {
      expect(extend.fontFamily[family]).toEqual([
        `var(--font-${family})`,
        ...fontFamily[family].slice(1),
      ]);
    }
  });
});
