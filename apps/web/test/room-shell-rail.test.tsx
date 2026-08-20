// @vitest-environment jsdom
/**
 * THE RAIL AND THE IMMERSIVE MODE (DESIGN.md §11 D1.1, unified 2026-08-20).
 *
 * The desktop rail used to survive a THEATER flip as a floating glass panel —
 * a server-backed, room-wide flag flipped it, so keeping the very same React
 * node across the flip was the whole defence against call-tile remounts. That
 * model is dead: theater IS fullscreen now, one LOCAL latch per viewer, and
 * while it is on the rail is deliberately UNMOUNTED — its replacement chrome
 * (chat sidebar, call pills) lives INSIDE the stage section, because the
 * fullscreen top layer paints over anything mounted out here. A merely-hidden
 * rail was considered and rejected: a hidden ChatPane keeps marking messages
 * seen, which would zero the unread count the overlay's handle exists to show.
 *
 * What this file pins now:
 *
 *  · entering the mode is LOCAL AND FREE OF THE WIRE: no fetch of any kind —
 *    the old header control PATCHed /rooms/:id/theater and re-laid-out the
 *    whole room; a regression to that is a one-line revert this catches;
 *  · the rail leaves with the mode and comes back with the exit, and the
 *    in-stage overlay (exit control, pills, chat handle) is what replaces it;
 *  · the mode is the USER'S LATCH, not the item's: the queue moving video →
 *    music re-lays-out nothing, in either layout — and the way out stays.
 *
 * The panes are stubbed, as before: this is a test about the SHELL's layout
 * decisions, and mounting the real call surface would drag a mesh, a members
 * query and a media pipeline into it without making any claim stronger. The
 * StagePane stub renders its `overlay` prop — that prop IS the shell decision
 * under test.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MediaRef, Message, Room, UserId } from '@gather/contracts';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mount counters, one per stubbed pane. */
const mounts = vi.hoisted(() => ({ dock: 0, overlay: 0, chat: 0 }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
}));

vi.mock('@/components/call/CallSurface', () => ({
  CallSessionProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  CallDock: () => {
    React.useEffect(() => {
      mounts.dock += 1;
    }, []);
    return React.createElement('div', { 'data-testid': 'call-dock' }, 'dock');
  },
  CallOverlay: () => {
    React.useEffect(() => {
      mounts.overlay += 1;
    }, []);
    return React.createElement('div', { 'data-testid': 'call-overlay' }, 'overlay');
  },
  // The immersive overlay mounts Agent B's pills through the shell's chrome;
  // the stub records the contract props the shell is responsible for.
  CallPills: ({ edge, collapsed }: { edge: string; collapsed: boolean }) =>
    React.createElement(
      'div',
      { 'data-testid': 'call-pills', 'data-edge': edge, 'data-collapsed': String(collapsed) },
      'pills',
    ),
}));
vi.mock('@/components/chat/ChatPane', () => ({
  ChatPane: () => {
    React.useEffect(() => {
      mounts.chat += 1;
    }, []);
    return React.createElement('div', { 'data-testid': 'chat' }, 'chat');
  },
}));
vi.mock('@/components/queue/QueuePane', () => ({
  QueuePane: () => React.createElement('div', null, 'queue'),
}));
vi.mock('@/components/people/PeoplePane', () => ({
  PeoplePane: () => React.createElement('div', null, 'people'),
}));
vi.mock('@/components/stage/StagePane', () => ({
  // The stub renders the shell's `overlay` node: that prop is the layout
  // decision under test (the immersive chrome goes INSIDE the stage section).
  StagePane: ({ overlay }: { overlay?: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'stage' }, overlay ?? null),
}));
vi.mock('@/components/room/RoomMenu', () => ({
  RoomMenu: () => React.createElement('div', null, 'menu'),
}));

const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { RoomLayout } = await import('@/app/room/[id]/room-shell');
const { resetImmersive } = await import('@/components/room/ImmersiveStage');
const { ROOM_ID, makeMember, makeRoom, playbackFor, queueItem } = await import(
  './helpers/room-render'
);
type RoomConnection = ReturnType<typeof useRoomConnection>;

const h = React.createElement;

const VIDEO: MediaRef = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' };
const MUSIC: MediaRef = { kind: 'soundcloud', url: 'https://soundcloud.com/artist/neon-rain' };
const PEER = 'user-peer' as UserId;

/** A message from someone else — the only kind that counts as unread. */
function peerMessage(seq: number): Message {
  return {
    id: `msg_${String(seq)}` as Message['id'],
    roomId: ROOM_ID,
    authorId: PEER,
    kind: 'text',
    body: `line ${String(seq)}`,
    gifUrl: null,
    attachment: null,
    replyTo: null,
    mentions: [],
    reactions: {},
    pinned: false,
    editedAt: null,
    deletedAt: null,
    seq,
    createdAt: 1_000 + seq,
  };
}

let captured: RoomConnection | null = null;

function Seeded({ patch, children }: { patch: Record<string, unknown>; children?: React.ReactNode }) {
  const connection = useRoomConnection();
  captured = connection;
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

/** The rail element itself, by its own accessible name. */
function railNode(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('aside[aria-label="Room panel"]');
}

function clickButton(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent) === label,
  );
  if (button === undefined) throw new Error(`no button labelled "${label}"`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function installDesktop(): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 768px'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('the immersive mode replaces the rail with in-stage chrome', () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mounts.dock = 0;
    mounts.overlay = 0;
    mounts.chat = 0;
    captured = null;
    resetImmersive();
    try {
      window.localStorage.clear();
    } catch {
      // this jsdom build ships no storage; the component guards the same way
    }
    // The old control wrote /rooms/:id/theater. The room's ambient plumbing
    // still fetches on its own schedule (auth refresh, the chat backlog), so
    // the tripwire is the THEATER write specifically, not the network.
    fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
    (globalThis as { fetch: unknown }).fetch = fetchSpy;
    installDesktop();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  async function mountRoom(room: Room, mediaRef: MediaRef): Promise<void> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const patch = {
      room,
      playback: playbackFor(mediaRef, 0),
      queue: { items: [queueItem(mediaRef, 'Current item')], version: 1 },
    };
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room, member: makeMember('member'), lastEventSeq: 0 } as never,
          h(
            Seeded,
            { patch },
            h(QueryClientProvider, { client }, h(RoomLayout, { roomId: ROOM_ID })),
          ),
        ),
      );
    });
  }

  it('enters locally: rail out, in-stage chrome in, and NOT ONE network call', async () => {
    await mountRoom(makeRoom('watch'), VIDEO);
    expect(railNode(host)).not.toBeNull();

    // A plain member can do this now — the mode fills only their own screen.
    clickButton(host, 'Turn theater mode on');

    expect(railNode(host)).toBeNull();
    const stage = host.querySelector('[data-testid="stage"]');
    expect(stage?.querySelector('[data-testid="call-pills"]')).not.toBeNull();
    expect(stage?.querySelector('button[aria-label="Exit theater mode"]')).not.toBeNull();
    expect(stage?.querySelector('button[aria-label="Show chat"]')).not.toBeNull();
    // The header leaves with the windowed layout; the stage is the screen.
    expect(host.querySelector('header')?.className).toContain('hidden');
    // The one assertion the whole unification hangs on: the flag stays unwritten.
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('theater'))).toEqual([]);
  });

  it('the exit control brings the windowed layout back', async () => {
    await mountRoom(makeRoom('watch'), VIDEO);
    clickButton(host, 'Turn theater mode on');
    expect(railNode(host)).toBeNull();

    clickButton(host, 'Exit theater mode');

    expect(railNode(host)).not.toBeNull();
    expect(host.querySelector('header')?.className).not.toContain('hidden');
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('theater'))).toEqual([]);
  });

  it('carries the shell’s own unread count onto the chat handle', async () => {
    await mountRoom(makeRoom('watch'), VIDEO);
    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');
    await act(async () => {
      connection.useRoomState.setState({ messages: [peerMessage(1), peerMessage(2)] });
      await Promise.resolve();
    });
    clickButton(host, 'Turn theater mode on');

    // The same projection the mobile control and the rail's Chat trigger
    // render — nothing chat-shaped is mounted (the pane stub counts).
    expect(mounts.chat).toBe(0);
    const handle = host.querySelector('button[aria-label="Show chat — 2 unread"]');
    expect(handle).not.toBeNull();
  });

  it('shows chat in one step, hides it in one step', async () => {
    await mountRoom(makeRoom('watch'), VIDEO);
    clickButton(host, 'Turn theater mode on');

    clickButton(host, 'Show chat');
    expect(host.querySelector('[data-testid="chat"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Show chat"]')).toBeNull();

    clickButton(host, 'Hide chat');
    expect(host.querySelector('[data-testid="chat"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Show chat"]')).not.toBeNull();
  });
});

/**
 * The mode is the USER'S LATCH, not the item's: the queue moves on its own,
 * and a layout that changes because a song came on is a twitch, not a mode.
 * The same rule held for the old flag (room-shell keeps the comment); what
 * changed is only whose latch it is.
 */
describe('the mode is the user’s latch, not the item’s', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mounts.dock = 0;
    mounts.chat = 0;
    captured = null;
    resetImmersive();
    try {
      window.localStorage.clear();
    } catch {
      // this jsdom build ships no storage; the component guards the same way
    }
    installDesktop();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  async function mountRoom(room: Room, mediaRef: MediaRef): Promise<void> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room, member: makeMember('host'), lastEventSeq: 0 } as never,
          h(
            Seeded,
            {
              patch: {
                room,
                playback: playbackFor(mediaRef, 0),
                queue: { items: [queueItem(mediaRef, 'Current item')], version: 1 },
              },
            },
            h(QueryClientProvider, { client }, h(RoomLayout, { roomId: ROOM_ID })),
          ),
        ),
      );
    });
  }

  async function playNext(mediaRef: MediaRef): Promise<void> {
    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');
    await act(async () => {
      connection.useRoomState.setState({
        playback: playbackFor(mediaRef, 0),
        queue: { items: [queueItem(mediaRef, 'Next item')], version: 2 },
      });
      await Promise.resolve();
    });
  }

  it('windowed: a video → music track change keeps the very same rail element', async () => {
    // The E4 lesson, in the layout that still has a rail: a remount throws
    // away the call dock's <video> tiles and chat's scroll. Node IDENTITY is
    // the assertion — a rebuilt rail is a different object.
    await mountRoom(makeRoom('watch'), VIDEO);
    const before = railNode(host);
    expect(before).not.toBeNull();
    const dockMounts = mounts.dock;

    await playNext(MUSIC);

    expect(railNode(host)).toBe(before);
    expect(mounts.dock).toBe(dockMounts);
  });

  it('immersive: the mode survives the queue moving to music — and so does the way out', async () => {
    await mountRoom(makeRoom('watch'), VIDEO);
    clickButton(host, 'Turn theater mode on');
    expect(railNode(host)).toBeNull();

    await playNext(MUSIC);

    // Still immersive: nobody touched anything.
    expect(railNode(host)).toBeNull();
    // A switch that flips one way is a trap: the exit is still one step.
    clickButton(host, 'Exit theater mode');
    expect(railNode(host)).not.toBeNull();
  });

  /**
   * The header arrow said "Leave room" and was an <a href="/home">. Nothing in
   * the product called POST /rooms/:id/leave, so the membership survived every
   * "leave": rooms never expire, and /home was therefore append-only — a row
   * for every room ever opened, with no way to lose one. Leaving is now a real
   * call in the room menu, and this arrow says only what it does.
   */
  it('the header arrow is navigation, and no longer claims to leave the room', async () => {
    await mountRoom(makeRoom('watch'), VIDEO);
    const back = host.querySelector<HTMLAnchorElement>('header a[href="/home"]');
    expect(back).not.toBeNull();
    expect(back?.getAttribute('aria-label')).toBe('Your rooms');
    expect(
      [...host.querySelectorAll('a, button')].map((el) => el.getAttribute('aria-label')),
    ).not.toContain('Leave room');
  });
});

/**
 * WHICH PANE THE RAIL OPENS ON, AND WHAT THE OTHER TWO COST.
 *
 * The rail always opened on Chat. DESIGN.md §12 budgets "add content to queue"
 * at 2, "play a queued item" and "reorder / remove a queue item" at 1, and
 * history-replay at 3 — and every one of those flows begins with a trip to the
 * Queue tab, so opening on Chat spent a step on all four and put the first one
 * over its budget outright.
 *
 * The trade only works because Chat can ask for you and the queue cannot: the
 * unread count is on Chat's own trigger. Which is the second case here, and it
 * is not incidental — panels mount lazily, so on a visit that never opens Chat
 * the pane that used to publish that count does not exist. The shell reads the
 * store instead and hands the number down.
 */
describe('the rail’s opening pane', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mounts.chat = 0;
    captured = null;
    resetImmersive();
    installDesktop();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  async function mountRoom(): Promise<void> {
    const room = makeRoom('watch', { theater: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room, member: makeMember('host'), lastEventSeq: 0 } as never,
          h(
            Seeded,
            { patch: { room, playback: null, queue: { items: [], version: 0 } } },
            h(QueryClientProvider, { client }, h(RoomLayout, { roomId: ROOM_ID })),
          ),
        ),
      );
    });
  }

  /** The tab whose trigger reports itself selected, by its own label. */
  function selectedTabs(): Array<string | null> {
    return [...host.querySelectorAll('[role="tab"]')]
      .filter((t) => t.getAttribute('aria-selected') === 'true')
      .map((t) => t.textContent);
  }

  it('is Queue — where the flows §12 budgets at one and two actually start', async () => {
    await mountRoom();
    expect(selectedTabs()).toEqual(['Queue']);
  });

  it('carries the unread count although chat has never been mounted', async () => {
    await mountRoom();
    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');
    await act(async () => {
      connection.useRoomState.setState({ messages: [peerMessage(1), peerMessage(2)] });
      await Promise.resolve();
    });

    const chat = [...host.querySelectorAll('[role="tab"]')].find((t) =>
      (t.textContent ?? '').startsWith('Chat'),
    );
    // The count published by the pane is unavailable by construction here.
    expect(mounts.chat).toBe(0);
    expect(chat?.textContent).toContain('2 unread');
  });
});
