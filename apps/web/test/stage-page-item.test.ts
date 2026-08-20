/**
 * A `page` item on a browser with no extension.
 *
 * The contract already spells out the requirement (contracts entities.ts, the
 * `page` MediaRef: "A viewer without the extension sees the item and the link,
 * and nothing plays for them — which is what the UI must say"). The stage said
 * nothing at all: `adapterKindFor` correctly returns null for a page, the
 * empty-stage message is reserved for `mediaRef === null`, and the shield only
 * mounts over a real provider surface — so the composition fell through every
 * branch and rendered a completely blank rectangle, directly contradicting the
 * queue's own "Paste any link" promise from the moment the link was pasted.
 *
 * It is also COMMON now rather than rare: protected rows (Netflix, Disney+)
 * became queueable, so this is what every viewer without the extension sees for
 * one. The things it has to settle are asserted below — what the item is, that
 * each person plays their own copy from their own account, how to get the
 * extension (there is ALWAYS somewhere honest to send them now: the app's own
 * /extension page, docs/FEATURE_PLAN.md §9 amendments), and that the install
 * funnel — <ExtensionGate> — mounts here, in this one branch, and nowhere
 * else.
 *
 * The driver hook is stood in for (same technique as
 * stage-driven-transport.test.ts) because a static server render can only ever
 * show the `detecting` snapshot: the phases the funnel exists for — absent,
 * ready — settle asynchronously, which a `renderToStaticMarkup` pass cannot
 * wait for. The default the mock answers is exactly the real hook's server
 * snapshot, so every case that does not touch `ext` renders what SSR renders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef } from '@gather/contracts';
import type { ExtensionDriverState } from '@/lib/player/extension-driver';
import {
  h,
  makeMember,
  makeRoom,
  playbackFor,
  queueItem,
  renderInRoom,
} from './helpers/room-render';

/** The driver's answer, settable per test. `checking: true` beside the
 *  detecting phase is what the real store's SERVER_SNAPSHOT carries. */
const ext = vi.hoisted(() => ({
  state: { phase: 'detecting' } as ExtensionDriverState,
  checking: true,
}));

vi.mock('@/lib/player/extension-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/player/extension-driver')>();
  return {
    ...actual,
    useExtensionDriver: () => ({
      state: ext.state,
      checking: ext.checking,
      ready: ext.state.phase === 'ready',
      driving: ext.state.phase === 'ready' && ext.state.driving,
      refresh: () => undefined,
      supports: () => false,
      handoff: () => Promise.resolve({ ok: true as const }),
      sendIntent: () => Promise.resolve({ ok: true as const }),
      release: () => Promise.resolve({ ok: true as const }),
    }),
  };
});

const { StagePane } = await import('@/components/stage/StagePane');

const PAGE: MediaRef = { kind: 'page', url: 'https://films.example/the-quiet-hour' };
const YT: MediaRef = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' };

afterEach(() => {
  ext.state = { phase: 'detecting' };
  ext.checking = true;
});

function renderPage(mediaRef: MediaRef): string {
  const room = makeRoom('watch');
  const items = [queueItem(mediaRef, 'The Quiet Hour')];
  return renderInRoom(
    room,
    makeMember('member'),
    { playback: playbackFor(mediaRef, 0), queue: { items, version: 1 } },
    h(StagePane, { roomId: room.id }),
  );
}

/** The absent-extension phase, as the real store reports it on desktop Chrome
 *  with nothing installed and no store listing configured. */
function notInstalled(): ExtensionDriverState {
  return {
    phase: 'unavailable',
    reason: 'not-installed',
    message: 'Gather plays through its browser extension — add it to watch together.',
    installUrl: '/extension',
    canInstall: true,
  };
}

function ready(): ExtensionDriverState {
  return {
    phase: 'ready',
    extensionVersion: '0.1.0',
    protocolVersion: 1,
    capabilities: ['handoff'],
    driving: false,
    connected: false,
    roomId: null,
    roomName: null,
    provider: null,
    hasMedia: false,
    notice: null,
  };
}

describe('the stage explains a page item it cannot play', () => {
  it('says what it is and why it is not playing here', () => {
    const html = renderPage(PAGE);
    expect(html).toContain('This is a link to a page, not a file the room can hand you');
    expect(html).toContain('The Gather extension plays it');
  });

  /**
   * The sentence that actually settles a Netflix row. Without it the reader's
   * next question is "so whose copy am I watching, and do I need an account" —
   * and the answer is the one thing a viewer has to know before they bother
   * installing anything.
   */
  it('says everyone plays their own copy from their own account', () => {
    const html = renderPage(PAGE);
    expect(html).toContain('everyone plays their own copy');
    expect(html).toContain('from their own account');
    expect(html).toContain('same second');
  });

  it('names the item, so the stage is about this link and not links in general', () => {
    expect(renderPage(PAGE)).toContain('The Quiet Hour');
  });

  it('gives the item the display step — it owns the whole stage', () => {
    // A poster state is reachable only when every other state is impossible,
    // which is what lets it spend the one display setting a screen gets (§3).
    expect(renderPage(PAGE)).toContain('text-display');
  });

  it('offers the way out that always exists: open the link yourself', () => {
    const html = renderPage(PAGE);
    expect(html).toContain('Open the link');
    expect(html).toContain('href="https://films.example/the-quiet-hour"');
    // Somewhere else, and in a new tab — losing the room to follow a link out
    // of it is the mistake this whole surface exists to avoid.
    expect(html).toContain('rel="noopener noreferrer"');
  });

  /**
   * `extensionInstallUrl()` used to return null in an unconfigured build and
   * the button was withheld — an offer the build could not honour. That state
   * is unreachable now: the function bottoms out at the app's own /extension
   * page, which ships with the app, so the button always has somewhere honest
   * to go.
   */
  it('always offers the install, at the /extension page when nothing is configured', () => {
    const html = renderPage(PAGE);
    expect(html).toContain('Add the extension');
    expect(html).toContain('href="/extension"');
    // Still exactly one gradient in the region (§2): the install action is the
    // primary, "Open the link" steps down to secondary beside it, and the gate
    // below offers no action while detection runs.
    expect(html.match(/aurora-gradient/g)).toHaveLength(1);
  });

  it('lets a configured install URL win over the /extension fallback', () => {
    const key = 'NEXT_PUBLIC_GATHER_EXTENSION_INSTALL_URL';
    const previous = process.env[key];
    process.env[key] = 'https://store.example/gather';
    try {
      const html = renderPage(PAGE);
      expect(html).toContain('href="https://store.example/gather"');
      expect(html).not.toContain('href="/extension"');
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it('does not claim the room is broken, and does not pretend to be a player', () => {
    const html = renderPage(PAGE);
    // Not the empty room (something IS queued), not the cueing wait (nothing is
    // arriving), and no play affordance over a surface there is no player for.
    expect(html).not.toContain('The room is ready');
    expect(html).not.toContain('Starting…');
    expect(html).not.toContain('Press play — everyone starts together');
    expect(html).not.toContain('Waiting for the host to press play');
  });

  it('leaves every other kind of item exactly as it was', () => {
    const html = renderPage(YT);
    expect(html).not.toContain('This is a link to a page');
    expect(html).toContain('Shared video');
  });
});

/**
 * The install funnel itself. <ExtensionGate> was built for exactly this
 * screen and then never mounted anywhere; the page-kind branch is the ONE
 * honest place it can live before WEB_SLIMMING step 4 executes — every other
 * media kind still plays through this page's own adapters, so a gate anywhere
 * wider would block playback that works.
 */
describe('the install funnel mounts here, and only here', () => {
  it('shows the gate while detection is still running', () => {
    const html = renderPage(PAGE);
    expect(html).toContain('Looking for the Gather extension');
  });

  it('offers the gate’s install action once the extension is known to be absent', () => {
    ext.state = notInstalled();
    ext.checking = false;
    const html = renderPage(PAGE);
    expect(html).toContain('Add the Gather extension to watch together');
    expect(html).toContain('href="/extension"');
    // The poster hands the install conversation to the gate rather than
    // repeating it: one offer, one gradient in the region (DESIGN.md §2).
    // "Open the link" stays on the poster, as the secondary it was.
    expect(html.match(/aurora-gradient/g)).toHaveLength(1);
    expect(html.match(/Add the extension/g)).toHaveLength(1);
    expect(html).toContain('Open the link');
  });

  it('withdraws the gate once the driver is ready', () => {
    ext.state = ready();
    ext.checking = false;
    const html = renderPage(PAGE);
    expect(html).not.toContain('Looking for the Gather extension');
    expect(html).not.toContain('Add the Gather extension to watch together');
    // What remains is the poster’s own sentence for this state.
    expect(html).toContain('You already have the extension');
  });

  it('never gates a kind the web still plays itself', () => {
    const html = renderPage(YT);
    expect(html).not.toContain('Looking for the Gather extension');
    expect(html).not.toContain('Add the Gather extension');

    ext.state = notInstalled();
    ext.checking = false;
    const absent = renderPage(YT);
    expect(absent).not.toContain('Add the Gather extension');
  });
});
