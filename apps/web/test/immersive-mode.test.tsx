// @vitest-environment jsdom
/**
 * THE IMMERSIVE CHROME'S OWN CONTRACTS (DESIGN.md §11 D1.1, unified
 * 2026-08-20). The shell-level behaviour — entering locally with no theater
 * write, the rail leaving, the chat handle and its unread count — is pinned
 * in room-shell-rail.test.tsx; the mode-drives-fullscreen wiring in
 * fullscreen-stage.test.ts. What is pinned HERE is what the chrome itself
 * promises:
 *
 *  · THE BADGE SAYS THE RAIL'S TRUTH OR NOTHING. The stage wore a static
 *    "Private · device-to-device" read off `room.relayMode` while the rail
 *    beside it rendered "Private · direct" from live link stats — two
 *    near-identical badges, one measured and one architectural, and the owner
 *    stood in front of the pair asking "am I using TURN or P2P?". The stage
 *    badge is now the SAME source and the SAME words (useCallSession's
 *    relayLabel), and when no link exists ('alone') it says nothing rather
 *    than guessing.
 *
 *  · THE PILLS' EDGE AND COLLAPSE ARE PER-VIEWER CHROME: owned by the
 *    overlay, remembered in localStorage, never room state. The overlay owns
 *    WHERE the pills sit; CallPills renders WHO is in them — the component
 *    contract, exercised here through a stub that only reports its props.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomId } from '@gather/contracts';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the mocked call session answers — mutated per case. */
const session = vi.hoisted(() => ({
  mediaPath: 'alone' as string,
  relayLabel: 'Device-to-device',
}));

vi.mock('@/components/call/CallSurface', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/call/CallSurface')>();
  return {
    ...real,
    // The badge reads the session; these cases steer it. `relayLabel` is
    // derived exactly the way the provider derives it, from the REAL label
    // map, so the words asserted below are the rail's own words.
    useCallSession: () => ({
      ...({} as ReturnType<typeof real.useCallSession>),
      mediaPath: session.mediaPath,
      relayLabel: session.relayLabel,
    }),
    // Contract stub: props in, markup out, nothing of B's internals.
    CallPills: ({
      edge,
      collapsed,
      onToggleCollapsed,
    }: {
      edge: string;
      collapsed: boolean;
      onToggleCollapsed(): void;
    }) =>
      React.createElement(
        'button',
        {
          'data-testid': 'call-pills',
          'data-edge': edge,
          'data-collapsed': String(collapsed),
          onClick: onToggleCollapsed,
        },
        'pills',
      ),
  };
});
vi.mock('@/components/chat/ChatPane', () => ({
  ChatPane: () => React.createElement('div', { 'data-testid': 'chat' }, 'chat'),
}));

const { CALL_PATH_LABEL } = await import('@/components/call/CallSurface');
const { ImmersiveOverlay, StageLivePathBadge } = await import(
  '@/components/room/ImmersiveStage'
);

const h = React.createElement;
const ROOM_ID = 'room-immersive' as RoomId;

/** This jsdom build ships no Storage at all (window.localStorage is
 *  undefined), which is also a real browser condition the chrome must survive
 *  — so the harness installs a recording stub and one case removes it. */
function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map<string, string>(Object.entries(seed));
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
  return store;
}

function removeStorage(): void {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });
}

describe('immersive chrome', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    session.mediaPath = 'alone';
    session.relayLabel = CALL_PATH_LABEL.alone;
    installStorage();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    removeStorage();
  });

  async function mountBadge(): Promise<void> {
    await act(async () => {
      root.render(h(StageLivePathBadge));
    });
  }

  async function mountOverlay(): Promise<void> {
    await act(async () => {
      root.render(h(ImmersiveOverlay, { roomId: ROOM_ID, unreadChat: 0 }));
    });
  }

  describe('the stage badge is the rail’s live truth, or silence', () => {
    it('says nothing when no link exists — nothing is flowing, so nothing is claimed', async () => {
      session.mediaPath = 'alone';
      session.relayLabel = CALL_PATH_LABEL.alone;
      await mountBadge();
      expect(host.textContent).toBe('');
    });

    it.each([
      ['direct', CALL_PATH_LABEL.direct],
      ['relayed', CALL_PATH_LABEL.relayed],
      ['mixed', CALL_PATH_LABEL.mixed],
      ['connecting', CALL_PATH_LABEL.connecting],
      // 'unknown' claims nothing about the ROUTE — the same refusal the rail
      // makes — but the link itself is real, so it is shown.
      ['unknown', CALL_PATH_LABEL.unknown],
    ])('renders the rail’s own words for %s', async (path, label) => {
      session.mediaPath = path;
      session.relayLabel = label;
      await mountBadge();
      expect(host.textContent).toBe(label);
    });

    it('never renders the dead architectural copy', async () => {
      // The unification’s point: no stored room field can put this string on
      // the stage again, whatever the path is.
      for (const path of Object.keys(CALL_PATH_LABEL)) {
        session.mediaPath = path;
        session.relayLabel = CALL_PATH_LABEL[path as keyof typeof CALL_PATH_LABEL];
        await mountBadge();
        expect(host.textContent).not.toContain('device-to-device');
      }
    });
  });

  describe('the pills’ edge and collapse are per-viewer chrome', () => {
    it('defaults to the right edge, expanded (D1.1)', async () => {
      await mountOverlay();
      const pills = host.querySelector('[data-testid="call-pills"]');
      expect(pills?.getAttribute('data-edge')).toBe('right');
      expect(pills?.getAttribute('data-collapsed')).toBe('false');
    });

    it('wakes up with the viewer’s remembered preferences', async () => {
      installStorage({
        'gather.immersive.pills-edge': 'left',
        'gather.immersive.pills-collapsed': '1',
      });
      await mountOverlay();
      const pills = host.querySelector('[data-testid="call-pills"]');
      expect(pills?.getAttribute('data-edge')).toBe('left');
      expect(pills?.getAttribute('data-collapsed')).toBe('true');
    });

    it('remembers a collapse the moment it happens', async () => {
      const store = installStorage();
      await mountOverlay();
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="call-pills"]')?.click();
      });
      expect(host.querySelector('[data-testid="call-pills"]')?.getAttribute('data-collapsed')).toBe(
        'true',
      );
      expect(store.get('gather.immersive.pills-collapsed')).toBe('1');
    });

    it('moves to the other edge and remembers that too', async () => {
      const store = installStorage();
      await mountOverlay();
      await act(async () => {
        host
          .querySelector<HTMLButtonElement>('button[aria-label="Move call tiles to the left edge"]')
          ?.click();
      });
      expect(host.querySelector('[data-testid="call-pills"]')?.getAttribute('data-edge')).toBe(
        'left',
      );
      expect(store.get('gather.immersive.pills-edge')).toBe('left');
      // The control reads the other way now — a flip that could only flip
      // once would strand the tiles on the left forever.
      expect(
        host.querySelector('button[aria-label="Move call tiles to the right edge"]'),
      ).not.toBeNull();
    });

    it('survives a browser with no storage at all — the choice just dies with the mount', async () => {
      removeStorage();
      await mountOverlay();
      const pills = host.querySelector('[data-testid="call-pills"]');
      expect(pills?.getAttribute('data-edge')).toBe('right');
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-testid="call-pills"]')?.click();
      });
      // No throw, and the in-memory latch still worked.
      expect(pills?.getAttribute('data-collapsed')).toBe('true');
    });
  });

  describe('the chat sidebar', () => {
    it('starts as the 48px handle — the mode exists to give the picture the screen', async () => {
      await mountOverlay();
      expect(host.querySelector('button[aria-label="Show chat"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="chat"]')).toBeNull();
    });

    it('opens in one step and mounts chat only then', async () => {
      await mountOverlay();
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button[aria-label="Show chat"]')?.click();
      });
      expect(host.querySelector('[data-testid="chat"]')).not.toBeNull();
      // The sidebar is the one glass panel over the picture; the handle is
      // gone while it is open (the hide button is the way back).
      expect(host.querySelector('button[aria-label="Show chat"]')).toBeNull();
      expect(host.querySelector('button[aria-label="Hide chat"]')).not.toBeNull();
    });

    it('carries the unread count on the handle', async () => {
      await act(async () => {
        root.render(h(ImmersiveOverlay, { roomId: ROOM_ID, unreadChat: 7 }));
      });
      expect(host.querySelector('button[aria-label="Show chat — 7 unread"]')).not.toBeNull();
    });
  });
});
