// @vitest-environment jsdom
/**
 * Toasts, checked for whether a FAILURE actually reaches the person.
 *
 * Every failure path in the app that does not throw ends at `toast.error(...)`
 * — describeError's sentence goes there and nowhere else. The card carried
 * `role="status"` inside an `aria-live="polite"` region, which is correct for
 * "Copied invite code" and wrong for "Your share was ended for the room":
 * polite waits for a pause, and if none comes before the 4.2s auto-dismiss the
 * announcement is dropped. A screen-reader user then gets the same thing as a
 * swallowed rejection — the failure happened and nothing said so.
 *
 * jsdom, because this is a mounted-DOM attribute question and the store is
 * imperative: nothing renders until `toast.error()` is called.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// `jsx: "preserve"` in tsconfig means esbuild emits the CLASSIC runtime here;
// same workaround as test/context-menu.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { Toaster, toast } = await import('@/components/ui/toast');

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(<Toaster />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

/**
 * The card carrying `text`.
 *
 * Looked up BY MESSAGE rather than by taking whatever cards are on screen:
 * the toast store is module-level (it survives unmount) and AnimatePresence
 * keeps a dismissed card mounted for its exit transition, so "every card in
 * the DOM" is not this case's cards. The Toaster also portals to
 * document.body, so none of them are inside `host`.
 */
function cardFor(text: string): HTMLElement {
  const card = [...document.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]')].find(
    (c) => c.textContent?.includes(text),
  );
  if (card === undefined) throw new Error(`no toast card for ${text}`);
  return card;
}

function push(kind: 'default' | 'success' | 'error', message: string): void {
  act(() => {
    if (kind === 'error') toast.error(message);
    else if (kind === 'success') toast.success(message);
    else toast(message);
  });
}

describe('a failure toast', () => {
  it('is announced assertively, not filed behind whatever is being read', () => {
    push('error', 'Your share was ended for the room.');
    const card = cardFor('share was ended');
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.getAttribute('aria-live')).toBe('assertive');
  });

  it('leaves ordinary confirmations polite — an alert for every toast is noise', () => {
    push('success', 'Invite code copied');
    push('default', 'Queued 3 items');
    for (const text of ['Invite code copied', 'Queued 3 items']) {
      const card = cardFor(text);
      expect(card.getAttribute('role')).toBe('status');
      expect(card.getAttribute('aria-live')).toBe('polite');
    }
  });

  it('still shows the sentence it was given, verbatim', () => {
    const sentence = 'The room couldn’t switch to your share — check your connection and try again.';
    push('error', sentence);
    expect(document.body.textContent).toContain(sentence);
  });
});

/**
 * The second half of "does the failure reach the person": can they READ it.
 *
 * The sentence used to be painted `text-success` / `text-danger`. Those are
 * `STANDALONE_UI_TOKENS` in @gather/design — measured against the 3:1 NON-text
 * bar — and on the light theme `--success` lands at 4.41:1 on the toast's
 * glass over the void and 4.29:1 over `--bg-deep`, under the 4.5:1 text bar.
 * The one line the toast exists to deliver was the one line below AA.
 *
 * `packages/design/test/palette.test.ts` cannot catch this: it walks token
 * PAIRS and never reads a Tailwind class string, so a token used in the wrong
 * ROLE is invisible to it. That is what these two pin, and it is why they
 * assert on class names — the role a colour is playing is a fact about the
 * markup, and jsdom computes no stylesheet to ask instead.
 */
describe('severity is a mark, not an ink', () => {
  it('paints every sentence in --text-hi, whatever the kind', () => {
    push('error', 'A failing sentence');
    push('success', 'A cheerful sentence');
    push('default', 'A neutral sentence');

    for (const text of ['A failing sentence', 'A cheerful sentence', 'A neutral sentence']) {
      const line = [...cardFor(text).querySelectorAll('span')].find(
        (el) => el.textContent === text,
      );
      expect(line, `no line element for ${text}`).toBeDefined();
      expect(line?.className).toContain('text-hi');
      expect(line?.className).not.toContain('text-success');
      expect(line?.className).not.toContain('text-danger');
    }
  });

  it('carries the severity on a non-text dot instead — and only where there is severity', () => {
    push('error', 'Something broke');
    push('success', 'Something worked');
    push('default', 'Something happened');

    expect(cardFor('Something broke').querySelector('.bg-danger')).not.toBeNull();
    expect(cardFor('Something worked').querySelector('.bg-success')).not.toBeNull();
    // A plain confirmation has no severity to state; a neutral dot on every
    // toast would be furniture.
    expect(cardFor('Something happened').querySelector('.bg-danger')).toBeNull();
    expect(cardFor('Something happened').querySelector('.bg-success')).toBeNull();
  });
});
