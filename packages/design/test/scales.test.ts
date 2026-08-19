/**
 * The geometry guard: radii, control heights, elevation and the type ramp's
 * leading, held to the ratios that separate software from a toy.
 *
 * ── Why ratios and not just values ────────────────────────────────────────
 * "Cartoonish" is not a matter of taste, it is a matter of proportion, and the
 * proportions are measurable. A corner radius means nothing on its own — 12px
 * is precise on a 96px card and a toy on a 32px button, and the shipped system
 * used 12 for BOTH. So the assertions below are mostly about relationships:
 * radius against the height of the thing it is cut into, desktop height against
 * touch height, each elevation level against the one below it.
 *
 * Pinning only the numbers would let someone re-loosen the whole ladder in one
 * edit and still be green. Pinning the ratios means the ladder can be retuned,
 * but not un-tightened.
 *
 * Deliberately NOT: colour. That is test/palette.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  CONTROL_SIZE_NAMES,
  ELEVATION_NAMES,
  SPACING_RAMP,
  controlSizes,
  cssVarName,
  elevation,
  emitCssControlMetrics,
  emitCssScaleVariables,
  emitRnElevation,
  emitRnTypeRamp,
  layout,
  radii,
  spacing,
  texture,
  typeRamp,
} from '../src/index';
import type { TypeStepName } from '../src/index';

/**
 * The band a control's corner has to live in, as a fraction of its height.
 *
 * Below 0.15 the corner reads as a hard-edged mistake at small sizes; at and
 * above 0.28 it starts to read as a lozenge. The shipped `control: 12` on the
 * new 32px button would be 0.375 — comfortably outside, which is the point.
 */
const RADIUS_RATIO_MIN = 0.15;
const RADIUS_RATIO_MAX = 0.28;

/** Desktop density. Linear, GitHub Primer and Figma all sit at 32. */
const DESKTOP_DEFAULT_MAX_PX = 36;

describe('the radius ladder', () => {
  it('is the committed 6 / 8 / 14 / 20 / 28 ladder', () => {
    expect(radii.sm).toBe(6);
    expect(radii.control).toBe(8);
    expect(radii.card).toBe(14);
    expect(radii.panel).toBe(20);
    expect(radii.stage).toBe(28);
    expect(radii.pill).toBe(999);
  });

  it('gives a control and a card DIFFERENT corners', () => {
    // They were both 12. A 32px button and a 56px row cut identically is why
    // nothing on the surface read as a control rather than a tile.
    expect(radii.control).not.toBe(radii.card);
    expect(radii.control).toBeLessThan(radii.card);
  });

  it('climbs strictly from chip to stage', () => {
    const ladder = [radii.sm, radii.control, radii.card, radii.panel, radii.stage];
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i], `rung ${i}`).toBeGreaterThan(ladder[i - 1] as number);
    }
  });

  it('spreads its ends far enough apart to say anything', () => {
    // The finding, as an assertion: 6 / 8 / 10 / 14 was four values inside one
    // octave, so a chip, a button, a row and a sheet were all cut roughly the
    // same and none of them read as a different KIND of surface. A radius
    // ladder is a vocabulary only if its ends are far apart.
    expect(radii.stage / radii.sm, 'stage is only this many times the chip corner').toBeGreaterThanOrEqual(4);
  });

  it("keeps a media row's corner modest against its 56px height", () => {
    expect(radii.card / layout.row).toBeLessThanOrEqual(RADIUS_RATIO_MAX);
  });
});

describe('control geometry', () => {
  for (const name of CONTROL_SIZE_NAMES) {
    const size = controlSizes[name];

    it(`${name}: its corner sits in the ${RADIUS_RATIO_MIN}–${RADIUS_RATIO_MAX} band of its height`, () => {
      const ratio = radii[size.radius] / size.height;
      expect(
        ratio,
        `${name} is ${radii[size.radius]}px on a ${size.height}px control = ${ratio.toFixed(3)}`,
      ).toBeGreaterThanOrEqual(RADIUS_RATIO_MIN);
      expect(
        ratio,
        `${name} is ${radii[size.radius]}px on a ${size.height}px control = ${ratio.toFixed(3)}`,
      ).toBeLessThanOrEqual(RADIUS_RATIO_MAX);
    });

    it(`${name}: never trades the touch target for desktop density`, () => {
      // The whole reason there are two heights. Tightening the mouse case is
      // only legitimate while the finger case is untouched.
      expect(
        size.touchHeight,
        `${name} touch target is ${size.touchHeight}px, floor is ${layout.tap}px`,
      ).toBeGreaterThanOrEqual(layout.tap);
      expect(size.touchHeight).toBeGreaterThanOrEqual(size.height);
    });

    it(`${name}: its padding and gap are on the spacing ramp`, () => {
      // 4 · 8 · 12 · 16 · 24 · 32 · 48, plus the two half-steps a small control
      // genuinely needs. Anything else is an arbitrary value creeping back in.
      const allowed = [...SPACING_RAMP, 6, 10, 20];
      expect(allowed, `${name} paddingX ${size.paddingX}`).toContain(size.paddingX);
      expect(allowed, `${name} gap ${size.gap}`).toContain(size.gap);
    });
  }

  it('puts the DEFAULT control at desktop density, not touch density', () => {
    // This is the finding, as an assertion: the shipped default button was
    // `h-11` — 44px, a touch target — on every desktop in the product.
    expect(
      controlSizes.md.height,
      `default control is ${controlSizes.md.height}px on a fine pointer`,
    ).toBeLessThanOrEqual(DESKTOP_DEFAULT_MAX_PX);
    expect(controlSizes.md.height).toBeLessThan(layout.tap);
  });

  it('climbs sm → md → lg in height, padding and label size', () => {
    expect(controlSizes.sm.height).toBeLessThan(controlSizes.md.height);
    expect(controlSizes.md.height).toBeLessThan(controlSizes.lg.height);
    expect(controlSizes.sm.paddingX).toBeLessThan(controlSizes.md.paddingX);
    expect(controlSizes.md.paddingX).toBeLessThan(controlSizes.lg.paddingX);
    // Only the largest control gets body-sized text; sm and md take `label`.
    expect(controlSizes.sm.text).toBe('label');
    expect(controlSizes.md.text).toBe('label');
    expect(controlSizes.lg.text).toBe('body');
  });

  it('leaves room for the label inside the shortest control', () => {
    for (const name of CONTROL_SIZE_NAMES) {
      const size = controlSizes[name];
      const line = typeRamp[size.text].lineHeight;
      expect(size.height - line, `${name} has ${size.height - line}px of vertical room`).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('the emitted control metrics', () => {
  const css = emitCssControlMetrics();

  it('asks the device rather than guessing from viewport width', () => {
    expect(css).toContain('@media (pointer: coarse)');
    expect(css).not.toContain('min-width');
    expect(css).not.toContain('max-width');
  });

  it('emits both heights for every size, desktop first then touch', () => {
    // Declarations are column-aligned by the emitter, so match past the padding.
    const declares = (property: string, value: string): boolean =>
      new RegExp(`${property}:\\s+${value};`).test(css);
    for (const name of CONTROL_SIZE_NAMES) {
      const size = controlSizes[name];
      expect(declares(`--control-h-${name}`, `${size.height}px`), `${name} desktop`).toBe(true);
      expect(declares(`--control-h-${name}`, `${size.touchHeight}px`), `${name} touch`).toBe(true);
      expect(declares(`--control-px-${name}`, `${size.paddingX}px`), `${name} padding`).toBe(true);
      expect(declares(`--control-gap-${name}`, `${size.gap}px`), `${name} gap`).toBe(true);
    }
  });

  it('overrides ONLY the heights under a coarse pointer', () => {
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
    expect(coarse).not.toContain('--control-px-');
    expect(coarse).not.toContain('--control-gap-');
    // Every height inside the coarse block clears the touch floor.
    for (const match of coarse.matchAll(/--control-h-[a-z]+:\s*(\d+)px/g)) {
      expect(Number(match[1]), coarse).toBeGreaterThanOrEqual(layout.tap);
    }
  });

  it('addresses a shadow root when asked, so the extension inherits it', () => {
    expect(emitCssControlMetrics(':host')).toContain(':host {');
  });
});

describe('the elevation ladder', () => {
  /** Layer 0 is the ring, layer 1 the soft shadow. The shape, not a convention. */
  const ring = (name: (typeof ELEVATION_NAMES)[number]) => elevation[name][0];
  const soft = (name: (typeof ELEVATION_NAMES)[number]) => elevation[name][1];

  it('is a 1px hairline ring plus ONE soft shadow, never a stack of blurs', () => {
    // The correction: depth used to be two blurred layers, and stacked blur
    // reads as soft. The edge is drawn exactly — no blur, no offset, 1px of
    // spread — and a single wide shadow says how far off the page it is.
    for (const name of ELEVATION_NAMES) {
      expect(elevation[name], name).toHaveLength(2);
      expect(ring(name)?.blur, `${name} ring blur`).toBe(0);
      expect(ring(name)?.y, `${name} ring offset`).toBe(0);
      expect(ring(name)?.spread, `${name} ring spread`).toBe(1);
      expect(soft(name)?.blur, `${name} shadow blur`).toBeGreaterThanOrEqual(8);
      expect(soft(name)?.spread, `${name} shadow spread`).toBeLessThan(0);
    }
  });

  it('washes the ring from the THEME and the shadow from the absolute ink', () => {
    // Two different questions. "Where does this surface end" is a palette
    // question — the edge that reads on a near-black ground is a light one, and
    // a black ring in the dark theme draws nothing. "How far off the page is
    // it" is a question about light, and light does not invert.
    for (const name of ELEVATION_NAMES) {
      expect(ring(name)?.wash, `${name} ring`).toBe('hairline');
      expect(soft(name)?.wash, `${name} shadow`).toBe('ink');
    }
  });

  it('climbs only in the shadow — an edge does not get realer with height', () => {
    for (let i = 1; i < ELEVATION_NAMES.length; i += 1) {
      const lower = ELEVATION_NAMES[i - 1] as (typeof ELEVATION_NAMES)[number];
      const upper = ELEVATION_NAMES[i] as (typeof ELEVATION_NAMES)[number];
      expect(soft(upper)?.y, `${upper} vs ${lower}`).toBeGreaterThan(soft(lower)?.y as number);
      expect(soft(upper)?.blur).toBeGreaterThan(soft(lower)?.blur as number);
      expect(soft(upper)?.alpha).toBeGreaterThan(soft(lower)?.alpha as number);
      expect(ring(upper), `${upper} ring vs ${lower} ring`).toEqual(ring(lower));
    }
  });

  it('stays faint enough to read as depth rather than as a black box', () => {
    for (const name of ELEVATION_NAMES) {
      expect(soft(name)?.alpha, `${name} shadow alpha`).toBeLessThanOrEqual(0.3);
    }
  });

  it('emits the ring from --hairline and the shadow from --ink-black', () => {
    // A shadow washed from a theme token would turn into a near-white glow the
    // moment the light theme loaded; a ring washed from the absolute ink is
    // invisible in the dark one. Both mistakes are one edit away.
    const css = emitCssScaleVariables();
    for (const name of ELEVATION_NAMES) {
      expect(css).toContain(`--elevation-${name}:`);
    }
    const line = css.split('\n').find((l) => l.includes('--elevation-e2:')) ?? '';
    expect(line).toContain(`var(${cssVarName('hairline')})`);
    expect(line).toContain('var(--ink-black)');
    expect(line).not.toContain('--bg-void');
  });

  it('gives RN the ring as a border, because RN has no ring-shaped shadow', () => {
    // Dropping it would be the silent failure: every RN surface would keep its
    // shadow and lose its edge, and nothing would report that.
    for (const theme of ['dark', 'light'] as const) {
      for (const name of ELEVATION_NAMES) {
        const level = emitRnElevation(theme)[name];
        expect(level.hairlineWidth, `${theme}.${name}`).toBe(1);
        expect(level.hairlineColor, `${theme}.${name}`).toMatch(/^(#|rgba\()/);
        expect(level.shadowColor, `${theme}.${name}`).toBe('#000000');
      }
    }
    // The ring inverts with the theme; the shadow does not.
    expect(emitRnElevation('dark').e2.hairlineColor).not.toBe(
      emitRnElevation('light').e2.hairlineColor,
    );
  });
});

/** Steps whose job is to be read in quantity. Leading is generous here. */
const READING_STEPS: readonly TypeStepName[] = ['body', 'label'];
/** Steps that structure a page. Leading is between reading and display. */
const STRUCTURAL_STEPS: readonly TypeStepName[] = ['title', 'headline'];
/** Steps that are a moment rather than a paragraph. Leading is optical. */
const DISPLAY_STEPS: readonly TypeStepName[] = ['display', 'hero'];

/** The ratio a step is set at, taking a fluid step's ratio over its px pair. */
const leading = (name: TypeStepName): number => {
  const step = typeRamp[name];
  return step.lineHeightRatio ?? step.lineHeight / step.fontSize;
};

describe('the type ramp has a display end', () => {
  it('is genuinely oversized at the top, not a dashboard', () => {
    // The finding, as an assertion. The ramp topped out at `display` 32 with
    // `title` 20 under it, so no surface in the product could ever be BIG and
    // nothing read as more important than anything else. 44 is the smallest
    // size that is unmistakably a display setting beside 16px body.
    expect(typeRamp.display.fontSize).toBeGreaterThanOrEqual(40);
    expect(typeRamp.hero.maxFontSize ?? 0).toBeGreaterThanOrEqual(72);
  });

  it('keeps a rung between the display end and body', () => {
    // Without `headline` the jump is 20 → 44, which surfaces bridge by
    // inventing an arbitrary size — the exact thing the ramp exists to stop.
    expect(typeRamp.headline.fontSize).toBeGreaterThan(typeRamp.title.fontSize);
    expect(typeRamp.headline.fontSize).toBeLessThan(typeRamp.display.fontSize);
  });

  it('descends without a gap wide enough to invite an arbitrary size', () => {
    const descending: readonly TypeStepName[] = [
      'display',
      'headline',
      'title',
      'body',
      'label',
      'caption',
    ];
    for (let i = 1; i < descending.length; i += 1) {
      const above = typeRamp[descending[i - 1] as TypeStepName].fontSize;
      const below = typeRamp[descending[i] as TypeStepName].fontSize;
      expect(below, `${descending[i]} vs ${descending[i - 1]}`).toBeLessThan(above);
      expect(above / below, `${descending[i - 1]} → ${descending[i]}`).toBeLessThanOrEqual(1.6);
    }
  });
});

describe('the type ramp is set optically', () => {
  it('gives reading text reading leading', () => {
    for (const name of READING_STEPS) {
      expect(leading(name), `${name} ${leading(name).toFixed(2)}`).toBeGreaterThanOrEqual(1.35);
    }
    expect(leading('body')).toBeGreaterThanOrEqual(1.5);
  });

  it('tightens leading as the type grows, and never the other way', () => {
    // The rule the old 32/36 broke by applying poster leading at a document
    // size, and the one a flat "≥1.2 everywhere" would break in reverse by
    // forcing document leading onto an 88px hero. Leading is a function of
    // size, so the guard is too.
    for (const name of STRUCTURAL_STEPS) {
      expect(leading(name), `${name} ${leading(name).toFixed(2)}`).toBeGreaterThanOrEqual(1.2);
      expect(leading(name)).toBeLessThan(leading('body'));
    }
    for (const name of DISPLAY_STEPS) {
      expect(leading(name), `${name} ${leading(name).toFixed(2)}`).toBeGreaterThanOrEqual(1);
      expect(leading(name), `${name} ${leading(name).toFixed(2)}`).toBeLessThanOrEqual(1.15);
      for (const structural of STRUCTURAL_STEPS) expect(leading(name)).toBeLessThan(leading(structural));
    }
  });

  it('tracks the small uppercase step wide enough to be legible', () => {
    expect(typeRamp.caption.uppercase).toBe(true);
    expect(typeRamp.caption.letterSpacing).toBeGreaterThanOrEqual(0.05);
  });

  it('tightens tracking as the type grows, and only where the size earns it', () => {
    // Negative tracking belongs to the steps above body and nowhere else;
    // applied at 13px it is the thing that makes text look squeezed.
    const tightening: readonly TypeStepName[] = ['title', 'headline', 'display', 'hero'];
    for (const name of tightening) expect(typeRamp[name].letterSpacing, name).toBeLessThan(0);
    for (let i = 1; i < tightening.length; i += 1) {
      const looser = typeRamp[tightening[i - 1] as TypeStepName].letterSpacing;
      const tighter = typeRamp[tightening[i] as TypeStepName].letterSpacing;
      expect(tighter, `${tightening[i]} vs ${tightening[i - 1]}`).toBeLessThan(looser);
    }
    expect(typeRamp.body.letterSpacing).toBe(0);
    expect(typeRamp.label.letterSpacing).toBe(0);
    expect(typeRamp.caption.letterSpacing).toBeGreaterThan(0);
  });
});

describe('the RN type ramp', () => {
  it('lands the resized steps at their designed RN size, not a web number', () => {
    // RN has no viewport unit, so the fluid hero (40 floor / 88 ceiling on web)
    // cannot scale and carries an explicit rnFontSize. `display` carries one
    // for the opposite reason: 44px is the designed WEB size and a 390pt phone
    // cannot hold it.
    expect(typeRamp.hero.rnFontSize).toBe(36);
    expect(emitRnTypeRamp().hero.fontSize).toBe(36);
    expect(typeRamp.display.rnFontSize).toBe(32);
    expect(emitRnTypeRamp().display.fontSize).toBe(32);
  });

  it('maxFontSize is the WEB fluid ceiling and never leaks into RN', () => {
    // body widens 16→18 on wide web viewports; RN stays at the floor.
    expect(typeRamp.body.maxFontSize).toBe(18);
    expect(emitRnTypeRamp().body.fontSize).toBe(16);
  });

  it('carries the ramp ratio across a resize rather than the px leading', () => {
    // A resized step keeping its authored px lineHeight is the silent bug:
    // display would arrive on a phone at 32/48, a ratio of 1.5, which is
    // reading leading on a display size.
    const rn = emitRnTypeRamp();
    for (const name of Object.keys(typeRamp) as TypeStepName[]) {
      const emitted = rn[name].lineHeight / rn[name].fontSize;
      expect(Math.abs(emitted - leading(name)), `${name} ${emitted.toFixed(3)}`).toBeLessThan(0.02);
    }
    // A step that does NOT resize keeps its authored px pair exactly.
    expect(rn.title.lineHeight).toBe(typeRamp.title.lineHeight);
  });
});

describe('the spacing ramp reaches composition scale', () => {
  it('carries section-scale rungs, which is what whitespace hierarchy needs', () => {
    // It stopped at 48, so every gap in the product came from the same four
    // rungs and nothing had more room around it than anything else.
    expect(spacing.section).toBe(64);
    expect(spacing.chapter).toBe(96);
    expect(spacing.canvas).toBe(128);
    expect(SPACING_RAMP[SPACING_RAMP.length - 1]).toBe(spacing.canvas);
  });

  it('is one ramp, ascending, on the 4pt grid', () => {
    const values = Object.values(spacing);
    expect(values).toEqual([...SPACING_RAMP]);
    for (const value of values) expect(value % 4, `${value} is off the grid`).toBe(0);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i], `rung ${i}`).toBeGreaterThan(values[i - 1] as number);
    }
  });
});

describe('grain', () => {
  it('is self-contained — no request, which the overlay CSP requires', () => {
    // The extension overlay is injected into a page whose CSP it does not
    // control, and the web app ships one of its own. An external asset here
    // would be a texture that works on the designer's screenshot only.
    expect(texture.grain).toMatch(/^url\("data:image\/svg\+xml,/);
    // The one http:// in there is the SVG namespace, which is an identifier
    // and never fetched. Anything else would be a request.
    expect(texture.grain.match(/https?:\/\//g) ?? []).toEqual(['http://']);
    expect(texture.grain).toContain("xmlns='http://www.w3.org/2000/svg'");
  });

  it('is felt and not seen', () => {
    // Above ~5% it is a pattern; below ~2% the display's own dithering eats it.
    expect(texture.grainOpacity).toBeGreaterThanOrEqual(0.02);
    expect(texture.grainOpacity).toBeLessThanOrEqual(0.05);
    expect(texture.grain).toContain(`opacity='${texture.grainOpacity}'`);
  });

  it('tiles seamlessly, or it is a grid of squares rather than noise', () => {
    expect(texture.grain).toContain("stitchTiles='stitch'");
    expect(texture.grain).toContain(`width='${texture.grainTilePx}'`);
  });

  it('reaches every renderer as a variable', () => {
    const css = emitCssScaleVariables();
    expect(css).toContain('--grain:');
    expect(css).toContain(`--grain-size:`);
    expect(css).toContain(`${texture.grainTilePx}px ${texture.grainTilePx}px`);
  });

  it('survives a template literal, which is how the overlay ships it', () => {
    // src/overlay/tokens.generated.ts wraps the emitted CSS in a backtick
    // string. A backtick or a `${` in the data URI would end the literal.
    expect(texture.grain).not.toContain('`');
    expect(texture.grain).not.toContain('${');
    expect(texture.grain).not.toContain('\\');
  });
});
