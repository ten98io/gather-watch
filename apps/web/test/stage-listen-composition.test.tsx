// @vitest-environment jsdom
/**
 * The listen composition (DESIGN.md §11 D3, §7) — the stage a music item gets.
 *
 * What is guarded here is what the composition PROMISES and what a re-skin
 * quietly takes back:
 *
 *  · the display step lands on the track, once — it is what the screen is about;
 *  · up-next is a track list beside the hero, headed by the caption step and
 *    not by a hand-spelled `text-label uppercase tracking-wide`;
 *  · the transport survives a track the queue has no row for, which is the one
 *    state that used to render "Nothing playing yet" over audible sound and
 *    withhold every control;
 *  · the region's one aurora gradient goes to the one primary action, and only
 *    when there is one;
 *  · `--accent` is never a TEXT colour on this stage.
 *
 * That last one cannot be caught anywhere else. `packages/design/test/
 * palette.test.ts` walks token PAIRS and never reads a Tailwind class string,
 * so `hover:text-accent` — which is 3.43:1 on the light theme, a non-text
 * value used as text (§2) — was documented as known debt for months precisely
 * because nothing could fail on it. This file reads the strings.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MediaRef, QueueItem, QueueItemId, UserId } from '@gather/contracts';

(globalThis as unknown as { React: typeof React }).React = React;

const { ListenStage } = await import('@/components/stage/ListenStage');

const h = React.createElement;

const SC: MediaRef = { kind: 'soundcloud', url: 'https://soundcloud.com/artist/neon-rain' };

let counter = 0;
function track(title: string, durationMs: number | null = null): QueueItem {
  counter += 1;
  return {
    id: `qi-${counter}` as QueueItemId,
    mediaRef: SC,
    title,
    durationMs,
    artworkUrl: null,
    addedBy: 'user-me' as UserId,
    votesToSkip: [],
  };
}

/** A stand-in transport, so the assertions are about WHERE it lands. */
const TRANSPORT = h('div', { 'data-transport': 'true' }, 'transport');

function renderListen(over: Partial<Parameters<typeof ListenStage>[0]> = {}): string {
  const items = [track('Neon Rain'), track('Slow Orbit', 185_000)];
  return renderToStaticMarkup(
    h(ListenStage, {
      adapter: null,
      currentItem: items[0],
      playing: true,
      queueItems: items,
      currentIndex: 0,
      transport: TRANSPORT,
      ...over,
    }),
  );
}

describe('the listen composition', () => {
  it('gives the track the display step, exactly once', () => {
    const html = renderListen();
    expect(html).toContain('Neon Rain');
    expect(html.match(/text-display/g)).toHaveLength(1);
  });

  it('promotes up-next to a track list beside the hero', () => {
    const html = renderListen();
    expect(html).toContain('aria-label="Up next"');
    expect(html).toContain('Slow Orbit');
    // §7's "next to it": the columns sit side by side once there is room.
    expect(html).toContain('xl:flex-row');
  });

  it('heads up-next with the caption step, not a hand-spelled one', () => {
    const html = renderListen();
    expect(html).toContain('text-caption text-low">Up next');
    // Tracking belongs to the step (§3) — a call site never adds its own.
    expect(html).not.toContain('tracking-wide');
  });

  /**
   * The room is playing something that was set straight on the stage rather
   * than queued. It is the ONLY thing an absent `currentItem` can mean here,
   * because StagePane mounts this composition on `mediaKindFor(ref) ===
   * 'music'` and that is never true of a null ref.
   */
  it('keeps the transport when the queue has no row for the playing track', () => {
    const html = renderListen({ currentItem: undefined });
    expect(html).toContain('data-transport="true"');
    // …and does not claim silence over audible sound.
    expect(html).not.toContain('The room is ready');
  });

  it('spends the region gradient on the refused-start recovery, and only then', () => {
    const idle = renderListen();
    expect(idle).not.toContain('aurora-gradient');

    const blocked = renderListen({ blocked: true, onActivate: () => undefined });
    expect(blocked).toContain('Start listening together');
    // One primary in the region (§2, §8) — the budget is one, not "at least one".
    expect(blocked.match(/aurora-gradient/g)).toHaveLength(1);
  });

  it('offers no recovery affordance without a handler to run', () => {
    expect(renderListen({ blocked: true })).not.toContain('Start listening together');
  });
});

/**
 * The class-string guard. Scoped to the stage because that is the surface these
 * two shapes actually survived on; every one of them was named as known debt in
 * DESIGN.md §2 and could only be closed by hand until now.
 */
const STAGE_SOURCES = [
  '../components/stage/ListenStage.tsx',
  '../components/stage/StagePane.tsx',
  '../components/stage/PlayerControls.tsx',
  '../components/stage/ScreenShareStage.tsx',
  '../components/stage/EmoteOverlay.tsx',
  '../components/ui/now-playing.tsx',
  '../components/ui/artwork.tsx',
  '../components/ui/artwork-backdrop.tsx',
] as const;

/** Comments explain the rule; only the code may not break it. */
function code(relative: string): string {
  const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the stage never paints --accent as text', () => {
  it.each(STAGE_SOURCES)('%s uses the accent as a fill, a ring or an edge', (relative) => {
    const source = code(relative);
    // `text-accent` in any variant — bare, `hover:`, `group-hover:`, `sm:`.
    expect(source).not.toMatch(/\btext-accent\b/);
    // …and the deprecated ink token, which §2.1 replaced with per-fill inks.
    expect(source).not.toMatch(/\btext-accent-ink\b/);
  });
});
