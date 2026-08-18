// @vitest-environment jsdom
/**
 * EmbedAdapter refuses a src it should never have been handed.
 *
 * `iframe.src = ref.embedUrl` is the sink the stored XSS actually used: a
 * guest queued `{kind:'embed', provider:'spotify', embedUrl:'javascript:…'}`
 * and the string ran as script on every viewer's page. The rule now lives in
 * the contract (packages/contracts entities.ts pins each provider's host), and
 * that is the fix — this file is the SECOND layer.
 *
 * It earns its place because the contract only guards the door values come in
 * through. A queue row written BEFORE the rule existed is already in the
 * database and is read back as a plain string; so is anything a future call
 * site builds by hand rather than by parsing. This adapter is the last code
 * between such a string and the browser, so it re-decides the scheme instead
 * of trusting that someone upstream did.
 *
 * Scheme only, deliberately: the host pin needs the `provider` field beside it
 * and belongs where both are validated together. Duplicating the host table
 * here would give two tables to keep in step, and the one that drifts is
 * always the copy.
 *
 * jsdom, because the whole assertion is about a real DOM node — whether an
 * <iframe> exists and what its src attribute says.
 */
import { describe, expect, it } from 'vitest';
import { EmbedAdapter } from '@/lib/player/embed';

type EmbedRef = Parameters<EmbedAdapter['load']>[0];

const REAL_SPOTIFY = 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC';

const ref = (embedUrl: string): EmbedRef => ({
  kind: 'embed',
  provider: 'spotify',
  embedUrl,
  title: null,
});

/** Adapter over a detached container, plus a log of what it emitted. */
function harness() {
  const container = document.createElement('div');
  const adapter = new EmbedAdapter(container);
  const events: string[] = [];
  adapter.on('ready', () => events.push('ready'));
  adapter.on('error', () => events.push('error'));
  return {
    container,
    adapter,
    events,
    frame: (): HTMLIFrameElement | null => container.querySelector('iframe'),
  };
}

/** Everything `z.string().url()` accepts that is not a link to a document. */
const REFUSED = [
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'blob:https://gather.watch/8f1c0d3e-0000-4000-8000-000000000000',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  // Not an execution vector, but not https either, and this adapter's job is
  // to answer exactly one question rather than to rank the answers.
  'http://open.spotify.com/embed/track/1',
];

describe('EmbedAdapter src scheme', () => {
  it('mounts the frame for a real https provider embed', () => {
    const h = harness();
    h.adapter.load(ref(REAL_SPOTIFY));
    expect(h.frame()?.getAttribute('src')).toBe(REAL_SPOTIFY);
    expect(h.events).not.toContain('error');
  });

  it.each(REFUSED)('mounts NO frame for %s', (embedUrl) => {
    const h = harness();
    h.adapter.load(ref(embedUrl));
    expect(h.frame()).toBeNull();
    expect(h.container.children.length).toBe(0);
    expect(h.events).toEqual(['error']);
  });

  /**
   * A refusal has to TAKE DOWN the frame that is already there, not merely
   * decline to add another. Leaving the previous track playing under a refusal
   * would be a room whose stage says one thing and whose speakers say another
   * — and it would leave the earlier frame alive indefinitely, since the next
   * successful load is the only other thing that replaces it.
   */
  it('tears the existing frame down when a later ref is refused', () => {
    const h = harness();
    h.adapter.load(ref(REAL_SPOTIFY));
    expect(h.frame()).not.toBeNull();
    h.adapter.load(ref('javascript:alert(1)'));
    expect(h.frame()).toBeNull();
    expect(h.events).toEqual(['error']);
  });

  it('stays refused after destroy, and mounts nothing at all', () => {
    const h = harness();
    h.adapter.destroy();
    h.adapter.load(ref(REAL_SPOTIFY));
    expect(h.frame()).toBeNull();
  });
});

/**
 * The capabilities the room hands a third-party frame. Pinned so the list is a
 * decision rather than an accident: every token here is a permission Spotify /
 * Apple / Tidal / Deezer get inside our page, and adding one should require
 * changing this line on purpose.
 */
describe('EmbedAdapter frame capabilities', () => {
  it('grants only what an embedded player needs to play', () => {
    const h = harness();
    h.adapter.load(ref(REAL_SPOTIFY));
    // autoplay: the room starts the track, not the viewer.
    // encrypted-media: these providers stream DRM-protected audio.
    expect(h.frame()?.getAttribute('allow')).toBe('autoplay; encrypted-media');
  });
});
