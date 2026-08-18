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
  elevation,
  emitCssControlMetrics,
  emitCssScaleVariables,
  layout,
  radii,
  typeRamp,
} from '../src/index';

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
  it('is the tightened 6 / 8 / 10 / 14 ladder', () => {
    expect(radii.sm).toBe(6);
    expect(radii.control).toBe(8);
    expect(radii.card).toBe(10);
    expect(radii.panel).toBe(14);
    expect(radii.pill).toBe(999);
  });

  it('gives a control and a card DIFFERENT corners', () => {
    // They were both 12. A 32px button and a 56px row cut identically is why
    // nothing on the surface read as a control rather than a tile.
    expect(radii.control).not.toBe(radii.card);
    expect(radii.control).toBeLessThan(radii.card);
  });

  it('climbs strictly from chip to panel', () => {
    const ladder = [radii.sm, radii.control, radii.card, radii.panel];
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i], `rung ${i}`).toBeGreaterThan(ladder[i - 1] as number);
    }
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
  it('climbs in offset, blur and total ink', () => {
    const total = (name: (typeof ELEVATION_NAMES)[number]): number =>
      elevation[name].reduce((sum, layer) => sum + layer.alpha, 0);
    for (let i = 1; i < ELEVATION_NAMES.length; i += 1) {
      const lower = ELEVATION_NAMES[i - 1] as (typeof ELEVATION_NAMES)[number];
      const upper = ELEVATION_NAMES[i] as (typeof ELEVATION_NAMES)[number];
      const ambient = (n: typeof upper) => elevation[n][elevation[n].length - 1];
      expect(ambient(upper)?.y, `${upper} vs ${lower}`).toBeGreaterThan(ambient(lower)?.y as number);
      expect(ambient(upper)?.blur).toBeGreaterThan(ambient(lower)?.blur as number);
      expect(total(upper)).toBeGreaterThan(total(lower));
    }
  });

  it('is a contact layer plus an ambient one, never a single smear', () => {
    for (const name of ELEVATION_NAMES) {
      expect(elevation[name], name).toHaveLength(2);
      const [contact, ambient] = elevation[name];
      expect(contact?.blur, name).toBeLessThan(ambient?.blur as number);
    }
  });

  it('stays faint enough to read as depth rather than as a black box', () => {
    for (const name of ELEVATION_NAMES) {
      for (const layer of elevation[name]) {
        expect(layer.alpha, `${name} layer alpha`).toBeLessThan(0.3);
        // Negative spread is what stops a shadow haloing out past its owner.
        expect(layer.spread, `${name} layer spread`).toBeLessThan(0);
      }
    }
  });

  it('is emitted as a box-shadow washed from the ABSOLUTE ink, not a theme token', () => {
    // A shadow is an absence of light. If it were a wash of `--bg-void` it
    // would turn into a near-white glow the moment the light theme loaded.
    const css = emitCssScaleVariables();
    for (const name of ELEVATION_NAMES) {
      expect(css).toContain(`--elevation-${name}:`);
    }
    const line = css.split('\n').find((l) => l.includes('--elevation-e2:')) ?? '';
    expect(line).toContain('var(--ink-black)');
    expect(line).not.toContain('--bg-void');
  });
});

describe('the type ramp breathes', () => {
  it('gives the big steps document leading, not poster leading', () => {
    // display shipped at 32/36 = 1.125 and title at 20/26 = 1.30. A page title
    // set that tight reads as a banner, which is half of "cartoonish".
    expect(typeRamp.display.lineHeight / typeRamp.display.fontSize).toBeGreaterThanOrEqual(1.2);
    expect(typeRamp.title.lineHeight / typeRamp.title.fontSize).toBeGreaterThanOrEqual(1.35);
  });

  it('keeps reading text at reading leading', () => {
    expect(typeRamp.body.lineHeight / typeRamp.body.fontSize).toBeGreaterThanOrEqual(1.4);
    expect(typeRamp.label.lineHeight / typeRamp.label.fontSize).toBeGreaterThanOrEqual(1.35);
  });

  it('tracks the small uppercase step wide enough to be legible', () => {
    expect(typeRamp.caption.uppercase).toBe(true);
    expect(typeRamp.caption.letterSpacing).toBeGreaterThanOrEqual(0.05);
  });

  it('tightens tracking only where the size earns it', () => {
    // Negative tracking belongs to the two display steps and nowhere else;
    // applied at 13px it is the thing that makes text look squeezed.
    expect(typeRamp.display.letterSpacing).toBeLessThan(0);
    expect(typeRamp.title.letterSpacing).toBeLessThan(0);
    expect(typeRamp.body.letterSpacing).toBe(0);
    expect(typeRamp.label.letterSpacing).toBe(0);
  });
});
