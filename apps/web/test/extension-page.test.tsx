/**
 * /extension — the page every "Add the extension" affordance lands on until a
 * store listing exists (docs/FEATURE_PLAN.md §9 amendments: point the funnel
 * at an honest docs page rather than let it silently degrade).
 *
 * Same technique as the legal pages in no-paywall.test.ts: a plain server
 * component rendered straight to static markup. What is pinned here is
 * HONESTY — the page must say the store listing does not exist, must not link
 * to a store page that would 404, and must hold the ExtensionGate copy bar
 * (plain sentences, no machinery vocabulary) with the one sanctioned
 * exception: the load-unpacked walkthrough may name chrome://extensions,
 * because that is the literal thing a person types.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// Same classic-runtime workaround as every other .tsx render in this suite.
(globalThis as unknown as { React: typeof React }).React = React;
const { default: ExtensionPage } = await import('@/app/extension/page');

const html = renderToStaticMarkup(React.createElement(ExtensionPage));

describe('/extension — what it says', () => {
  it('names the thing and what it actually does', () => {
    expect(html).toContain('The Gather extension');
    // The three true claims, in plain words: drives your own player in your
    // own tab/account (DRM services included), shares a screen, carries the
    // room along.
    expect(html).toContain('drives your own player');
    expect(html).toContain('signed in to their own account');
    expect(html).toContain('share a tab, a window or your whole screen');
  });

  it('admits the store listing does not exist yet, and promises the link here', () => {
    expect(html).toContain('not on the Chrome Web Store yet');
    expect(html).toContain('this page will link straight to it');
  });

  it('links to no store page that cannot exist yet', () => {
    expect(html).not.toContain('chromewebstore.google.com');
  });

  it('walks a team build through load-unpacked', () => {
    expect(html).toContain('chrome://extensions');
    expect(html).toContain('Developer mode');
    expect(html).toContain('Load unpacked');
    expect(html).toContain('dist');
  });

  it('tells the truth about detection: the room notices on reload', () => {
    // A room tab open BEFORE the install never hears the announce — Chrome
    // does not inject declarative content scripts into already-loaded
    // documents, and no prod build ships a configured extension id for the
    // hello path — so the page may not claim the room notices "on its own".
    expect(html).toContain('reload your room');
    expect(html).toContain('as the page loads');
    expect(html).not.toContain('on its own');
    expect(html).toContain('check again');
  });

  it('does not claim the room is broken without it', () => {
    // The same reassurance the gate makes: the room works before the install.
    expect(html).toContain('chat, voice and the queue');
  });
});

describe('/extension — plain language', () => {
  it('holds the ExtensionGate copy bar', () => {
    // The gate suite's denylist, applied verbatim. chrome://extensions is the
    // sanctioned exception and contains none of these strings.
    const jargon = [
      'mv3',
      'manifest',
      'protocol',
      'desktopcapture',
      'chrome.runtime',
      'not_installed',
      'unsupported_version',
      'bridge',
      'undefined',
    ];
    const lower = html.toLowerCase();
    for (const word of jargon) expect(lower).not.toContain(word);
  });
});
