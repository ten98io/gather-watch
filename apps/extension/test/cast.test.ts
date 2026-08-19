import { describe, expect, it } from 'vitest';
import { REVEAL_DELAY_MS, castAffordanceFor, performNativeCast } from '../src/cast';
import type { CastDeps, CastTarget } from '../src/cast';
import { providerForUrl } from '../src/providers';

/** A fake page: a selector → element map, recording clicks and waits. */
function fakeDom(present: Record<string, { visible?: boolean }>): CastDeps & {
  clicks: string[];
  waits: number[];
  appear(selector: string): void;
} {
  const state = new Map(
    Object.entries(present).map(([sel, v]) => [sel, { visible: v.visible !== false }]),
  );
  const clicks: string[] = [];
  const waits: number[] = [];
  return {
    clicks,
    waits,
    appear: (selector: string) => state.set(selector, { visible: true }),
    query: (selector: string): CastTarget | null => {
      const entry = state.get(selector);
      if (entry === undefined) return null;
      return {
        visible: entry.visible,
        click: () => clicks.push(selector),
      };
    },
    wait: async (ms: number) => {
      waits.push(ms);
      await Promise.resolve();
    },
  };
}

const youtube = providerForUrl('https://www.youtube.com/watch?v=abc');
const netflix = providerForUrl('https://www.netflix.com/watch/80100172');
const unknown = providerForUrl('https://example.com/video');

describe('performNativeCast', () => {
  it("clicks YouTube's own cast button", async () => {
    const dom = fakeDom({ '.ytp-remote-button': {} });
    const res = await performNativeCast(youtube.cast, dom, youtube.name);
    expect(res.clicked).toBe(true);
    expect(res.selector).toBe('.ytp-remote-button');
    expect(dom.clicks).toEqual(['.ytp-remote-button']);
    expect(res.reason).toContain('YouTube');
  });

  it('opens the overflow menu when the button is not directly visible', async () => {
    const dom = fakeDom({
      '.ytp-remote-button': { visible: false },
      '.ytp-overflow-button': {},
    });
    // The button becomes visible once the overflow menu opens.
    const deps: CastDeps = {
      query: (selector) => {
        if (selector === '.ytp-remote-button' && dom.clicks.includes('.ytp-overflow-button')) {
          return { visible: true, click: () => dom.clicks.push(selector) };
        }
        return dom.query(selector);
      },
      wait: dom.wait,
    };
    const res = await performNativeCast(youtube.cast, deps, youtube.name);
    expect(res.clicked).toBe(true);
    expect(dom.clicks).toEqual(['.ytp-overflow-button', '.ytp-remote-button']);
    expect(dom.waits).toEqual([REVEAL_DELAY_MS]);
  });

  it('reports honestly, and clicks nothing, when the control is absent', async () => {
    const dom = fakeDom({});
    const res = await performNativeCast(youtube.cast, dom, youtube.name);
    expect(res.clicked).toBe(false);
    expect(res.selector).toBeNull();
    expect(dom.clicks).toEqual([]);
    expect(res.reason).toContain("Couldn't find YouTube's cast control");
  });

  /**
   * The selectors are data, and a site is under no obligation to keep the
   * class names they were written against. A reskin that moves the cast button
   * but leaves the overflow menu where it was lands exactly here: the menu
   * opens, the button is not in it, and the user is left looking at the site's
   * own menu hanging open over the video, with nothing said.
   */
  it('closes the menu it opened when the button is not in there after all', async () => {
    const dom = fakeDom({ '.ytp-overflow-button': {} });

    const res = await performNativeCast(youtube.cast, dom, youtube.name);

    expect(res.clicked).toBe(false);
    expect(res.reason).toContain("Couldn't find YouTube's cast control");
    // Opened, looked, and put back: the same toggle, pressed twice.
    expect(dom.clicks).toEqual(['.ytp-overflow-button', '.ytp-overflow-button']);
  });

  it('leaves the menu open when the button WAS in there', async () => {
    const dom = fakeDom({
      '.ytp-remote-button': { visible: false },
      '.ytp-overflow-button': {},
    });
    const deps: CastDeps = {
      query: (selector) => {
        if (selector === '.ytp-remote-button' && dom.clicks.includes('.ytp-overflow-button')) {
          return { visible: true, click: () => dom.clicks.push(selector) };
        }
        return dom.query(selector);
      },
      wait: dom.wait,
    };

    await performNativeCast(youtube.cast, deps, youtube.name);

    // Closing it would take the site's own cast picker down with it.
    expect(dom.clicks).toEqual(['.ytp-overflow-button', '.ytp-remote-button']);
  });

  it('refuses protected sites with the site\'s own reason — never a capture fallback', async () => {
    const dom = fakeDom({ '[data-uia="control-cast"]': {} });
    const res = await performNativeCast(netflix.cast, dom, netflix.name);
    expect(res.clicked).toBe(false);
    expect(dom.clicks).toEqual([]); // not native: not even attempted
    expect(res.reason).toBe(netflix.cast.reason);
    expect(res.reason).toMatch(/can't be mirrored|own mobile and TV apps/);
  });

  it('falls back to the generic explanation on unknown sites', async () => {
    const res = await performNativeCast(unknown.cast, fakeDom({}), unknown.name);
    expect(res.clicked).toBe(false);
    expect(res.reason).toContain('Cast…');
  });
});

describe('castAffordanceFor', () => {
  it('enables the control only where the site can actually cast', () => {
    expect(castAffordanceFor(youtube)).toEqual({
      enabled: true,
      label: 'Cast from YouTube',
      reason: '',
    });
    const drm = castAffordanceFor(netflix);
    expect(drm.enabled).toBe(false);
    expect(drm.reason).toBe(netflix.cast.reason);
  });

  it('never hides the control — it explains instead', () => {
    for (const provider of [netflix, unknown]) {
      const affordance = castAffordanceFor(provider);
      expect(affordance.enabled).toBe(false);
      expect(affordance.reason.length).toBeGreaterThan(0);
    }
    expect(castAffordanceFor(null).reason.length).toBeGreaterThan(0);
  });
});
