// @vitest-environment jsdom
/**
 * E4/B2 — THE RAIL SURVIVES A THEATER FLIP.
 *
 * The room shell used to render `<Rail>` in one branch of a ternary and a
 * `<>…</>` fragment in the other, at the same child slot. React reconciles
 * positional children by type, and a fragment is not a component: every flip
 * therefore DESTROYED the rail and built a new one. Which sounds like a
 * repaint, and is not — the rail holds CallDock, so every call tile's `<video>`
 * element was thrown away and recreated (a visible black flash, and a
 * renegotiation's worth of work), chat lost its scroll position, and the queue
 * and people panes re-fetched.
 *
 * The rail is identified here by the tab list it owns. Node IDENTITY is the
 * assertion, not the markup: a remount produces an equal-looking element that
 * is a different object, which is exactly the failure this test is for.
 *
 * The panes are stubbed. This is a test about ONE THING — whether React keeps
 * the subtree — and mounting the real call surface would drag a mesh, a members
 * query and a media pipeline into it without making the claim any stronger. The
 * stub counts its own mounts, which is the same defect stated the other way.
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
  StagePane: () => React.createElement('div', { 'data-testid': 'stage' }, 'stage'),
}));
vi.mock('@/components/room/RoomMenu', () => ({
  RoomMenu: () => React.createElement('div', null, 'menu'),
}));

const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { RoomLayout } = await import('@/app/room/[id]/room-shell');
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

describe('the desktop rail across a theater flip', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mounts.dock = 0;
    mounts.overlay = 0;
    mounts.chat = 0;
    captured = null;
    // Desktop: the branch the rail lives in. The reduced-motion query must
    // answer false or the stage's own transitions never arm.
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
          { room, member: makeMember('host'), lastEventSeq: 0 } as never,
          h(
            Seeded,
            { patch },
            h(QueryClientProvider, { client }, h(RoomLayout, { roomId: ROOM_ID })),
          ),
        ),
      );
    });
  }

  /** Flip the room's stored theater flag the way `room.updated` would. */
  async function setTheater(theater: boolean): Promise<void> {
    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');
    await act(async () => {
      connection.useRoomState.setState((s) => ({
        room: { ...(s.room as Room), theater },
      }));
      await Promise.resolve();
    });
  }

  it('keeps the very same rail element when theater turns off', async () => {
    await mountRoom(makeRoom('watch', { theater: true }), VIDEO);

    // Theater starts collapsed; open the panel so the rail is on screen both
    // before AND after the flip. That is the case the old code destroyed.
    clickButton(host, 'Chat & queue');
    const before = railNode(host);
    expect(before).not.toBeNull();
    const dockMounts = mounts.dock;

    await setTheater(false);

    const after = railNode(host);
    expect(after).not.toBeNull();
    // Identity, not equality: a rebuilt rail is a different node.
    expect(after).toBe(before);
    // The same claim from the other side — the call surface was not recreated.
    expect(mounts.dock).toBe(dockMounts);
  });

  it('and across the flip back on, with the panel still open', async () => {
    // `railOpen` is the shell's own state and survives the flip, so a room that
    // goes theater → windowed → theater keeps the rail on screen throughout.
    await mountRoom(makeRoom('watch', { theater: true }), VIDEO);
    clickButton(host, 'Chat & queue');
    // Select Chat first: the rail opens on Queue now, and panels mount lazily,
    // so without this the mount count below would be 0 before AND after and
    // the assertion would pass on a rail that had been rebuilt twice.
    clickButton(host, 'Chat');
    const before = railNode(host);
    const chatMounts = mounts.chat;
    expect(chatMounts).toBe(1);

    await setTheater(false);
    await setTheater(true);

    expect(railNode(host)).toBe(before);
    expect(mounts.chat).toBe(chatMounts);
  });

  it('theater changes what the rail looks like, not what it is', async () => {
    await mountRoom(makeRoom('watch', { theater: true }), VIDEO);
    clickButton(host, 'Chat & queue');
    const rail = railNode(host);
    // cn() is a plain joiner, so these two must be a ternary — a floating rail
    // that kept `bg-surface-1` would paint solid over the picture.
    expect(rail?.className).toContain('glass-panel');
    expect(rail?.className).not.toContain('bg-surface-1');

    await setTheater(false);

    expect(rail?.className).toContain('bg-surface-1');
    expect(rail?.className).not.toContain('glass-panel');
  });
});

/**
 * The deeper half of E4: theater was re-derived from the PLAYING ITEM
 * (`room.theater && stageKind === 'video'`), so a mixed queue re-laid-out the
 * whole room once per track — rail gone for the song, back for the video,
 * nobody having touched anything.
 */
describe('theater is the user’s latch, not the item’s', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mounts.dock = 0;
    mounts.chat = 0;
    captured = null;
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

  it('a video → music track change does not re-lay-out the room', async () => {
    await mountRoom(makeRoom('watch', { theater: true }), VIDEO);
    clickButton(host, 'Chat & queue');
    const before = railNode(host);
    const dockMounts = mounts.dock;

    await playNext(MUSIC);

    // Theater is still on because the user still has it on. Nothing moved.
    expect(railNode(host)).toBe(before);
    expect(mounts.dock).toBe(dockMounts);
  });

  it('stays switchable off while it is on, whatever is playing', async () => {
    // A control that turns a mode on over video but cannot turn it off over
    // music is a trap: the queue moves on its own.
    await mountRoom(makeRoom('watch', { theater: true }), MUSIC);
    expect(host.textContent).toContain('Theater');
    const toggle = [...host.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Turn theater mode off',
    );
    expect(toggle).toBeDefined();
  });

  it('is not offered over music when it is off — there is nothing to fill', async () => {
    await mountRoom(makeRoom('watch', { theater: false }), MUSIC);
    expect(
      [...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
    ).not.toContain('Turn theater mode on');
  });

  /**
   * The header arrow said "Leave room" and was an <a href="/home">. Nothing in
   * the product called POST /rooms/:id/leave, so the membership survived every
   * "leave": rooms never expire, and /home was therefore append-only — a row
   * for every room ever opened, with no way to lose one. Leaving is now a real
   * call in the room menu, and this arrow says only what it does.
   */
  it('the header arrow is navigation, and no longer claims to leave the room', async () => {
    await mountRoom(makeRoom('watch', { theater: false }), VIDEO);
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
