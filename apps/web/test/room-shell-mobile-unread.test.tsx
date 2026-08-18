// @vitest-environment jsdom
/**
 * UNREAD CHAT ON THE MOBILE-WEB SURFACE.
 *
 * The unread work (E16) landed entirely on the desktop rail: the count is
 * published by ChatPane onto ITS TabsTrigger. Mobile web is a different branch
 * of room-shell — the panes live in a bottom Sheet, and `SheetContent` renders
 * nothing at all while the sheet is closed. So on a phone:
 *
 *   • the whole tab bar (and every badge on it) is inside the closed sheet,
 *   • ChatPane is not merely hidden, it is UNMOUNTED, so the one component
 *     that publishes the count does not exist,
 *   • and before the sheet is opened for the first time, ChatPane has never
 *     mounted at all — TabsContent mounts lazily.
 *
 * The result is a phone that receives chat all evening and never says so once,
 * and then clears the whole backlog the instant the sheet opens, because
 * mounting the pane on the Chat tab marks everything seen. The count is only
 * "silently cleared" because it was never visible anywhere to begin with.
 *
 * The fix has to be a projection of the ROOM STORE read by the shell itself —
 * the one thing on this surface that is always mounted — not another consumer
 * of the pane. These cases pin that: the signal is on the header control that
 * OPENS the sheet, it is right while nothing chat-shaped is mounted, and it
 * counts the same things the desktop badge counts (not my own messages, not
 * the backlog that was already there when I arrived).
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Message, Room, UserId } from '@gather/contracts';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Did anything chat-shaped mount? The point is that nothing has to. */
const mounts = vi.hoisted(() => ({ chat: 0 }));

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
  CallDock: () => React.createElement('div', null, 'dock'),
  CallOverlay: () => React.createElement('div', null, 'overlay'),
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
const { ROOM_ID, ME, makeMember, makeRoom } = await import('./helpers/room-render');

const PEER = 'user-peer' as UserId;
const h = React.createElement;

function message(seq: number, authorId: UserId): Message {
  return {
    id: `msg_${String(seq)}` as Message['id'],
    roomId: ROOM_ID,
    authorId,
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

type RoomConnection = ReturnType<typeof useRoomConnection>;
let captured: RoomConnection | null = null;

function Seeded({
  patch,
  children,
}: {
  patch: Record<string, unknown>;
  children?: React.ReactNode;
}) {
  const connection = useRoomConnection();
  captured = connection;
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

let host: HTMLDivElement;
let root: Root;

/** The header control that opens the mobile sheet, whatever it now says. */
function sheetOpener(): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('header button')].find((b) =>
    (b.textContent ?? '').includes('Chat'),
  );
  if (found === undefined) throw new Error('no header control opens the sheet');
  return found;
}

describe('unread chat on mobile web', () => {
  beforeEach(() => {
    mounts.chat = 0;
    captured = null;
    // Phone: the `(min-width: 768px)` query answers false, which is the branch
    // where the rail — and every badge on it — does not exist.
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

  async function mountRoom(patch: Record<string, unknown> = {}): Promise<void> {
    const room: Room = makeRoom('watch');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room, member: makeMember('member'), lastEventSeq: 0 } as never,
          h(
            Seeded,
            { patch: { room, ...patch } },
            h(QueryClientProvider, { client }, h(RoomLayout, { roomId: ROOM_ID })),
          ),
        ),
      );
    });
  }

  /** Deliver messages the way the socket reducer would. */
  async function arrive(...msgs: Message[]): Promise<void> {
    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');
    await act(async () => {
      connection.useRoomState.setState((s) => ({
        messages: [...(s.messages as Message[]), ...msgs],
      }));
      await Promise.resolve();
    });
  }

  it('shows the count on the control that opens the sheet', async () => {
    await mountRoom();

    await arrive(message(1, PEER), message(2, PEER));

    expect(sheetOpener().textContent).toContain('2 unread');
  });

  it('is right even though nothing chat-shaped has ever mounted', async () => {
    await mountRoom();
    await arrive(message(1, PEER), message(2, PEER), message(3, PEER));

    // The sheet is closed, so ChatPane — the desktop badge's only publisher —
    // does not exist. The count still has to be true.
    expect(mounts.chat).toBe(0);
    expect(sheetOpener().textContent).toContain('3 unread');
  });

  it('counts other people, never me, and never the backlog I arrived to', async () => {
    // chatSeenSeq is the anchor loadRecentMessages seeds on the first page.
    await mountRoom({ messages: [message(1, PEER), message(2, PEER)], chatSeenSeq: 2 });

    await arrive(message(3, ME), message(4, PEER));

    const label = sheetOpener().textContent ?? '';
    expect(label).toContain('1 unread');
    expect(label).not.toContain('4 unread');
  });

  it('says nothing at all when there is nothing unread', async () => {
    await mountRoom({ messages: [message(1, PEER)], chatSeenSeq: 1 });

    expect(sheetOpener().textContent).not.toContain('unread');
  });

  it('clears once the sheet is open on chat, and only then', async () => {
    await mountRoom();
    await arrive(message(1, PEER));
    expect(sheetOpener().textContent).toContain('1 unread');

    await act(async () => {
      sheetOpener().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    // The real ChatPane advances the anchor when it is the visible tab; the
    // stub cannot, so do what it does and check the shell follows the store.
    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');
    await act(async () => {
      connection.markChatSeen(1);
      await Promise.resolve();
    });

    expect(sheetOpener().textContent).not.toContain('unread');
  });
});
