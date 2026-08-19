// @vitest-environment jsdom
/**
 * THE LOG STAYS REACHABLE FROM THE KEYBOARD.
 *
 * Every action on a message — react, reply, edit, delete, pin, REPORT — is
 * behind the context menu, and the keyboard route into that menu is the Menu
 * key firing `contextmenu` on the focused element. So a message has to be
 * focusable, and 300 of them cannot each be a tab stop, which is why exactly
 * one row is in the tab order and the Arrow keys move it.
 *
 * The bug this pins is that the two halves of that scheme counted different
 * things. Tombstones and system events render no focusable row — they carry no
 * actions — so a position in the message window is not a position in what can
 * be focused, and:
 *
 *   · when the newest message was a system event ("Robin joined the room" —
 *     the most ordinary last line a room has), the default tab stop resolved
 *     to a row that renders no tab stop at all, so Tab out of the composer
 *     skipped the log entirely and the Arrow keys, which only act on focus
 *     already inside it, had no way to put it back. Reporting a message became
 *     unreachable without a pointer;
 *   · with a tombstone anywhere earlier in the window, arrowing moved the tab
 *     stop onto a different message from the one focus had landed on.
 *
 * jsdom, because both are facts about a rendered tree.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member, Message, MessageId, Room, RoomId, User, UserId } from '@gather/contracts';

// `jsx: "preserve"` in tsconfig means vitest's esbuild emits the CLASSIC
// runtime, so every compiled component reaches for a free `React` — same
// workaround as test/chat-grouping.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = 'room_reach' as RoomId;
const ME = 'user_me' as UserId;
const ROBIN = 'user_robin' as UserId;

const NAMES: Readonly<Record<string, string>> = { [ME]: 'Me', [ROBIN]: 'Robin' };

/* ── module doubles ──────────────────────────────────────────────────────── */

const stub = vi.hoisted(() => ({ messages: [] as unknown[] }));

function roomState(): Record<string, unknown> {
  return {
    messages: stub.messages,
    typing: {},
    readCursors: {},
    chatHistoryExhausted: true,
    chatSeenSeq: 0,
  };
}

const connection = {
  useRoomState: Object.assign(
    (select: (s: Record<string, unknown>) => unknown) => select(roomState()),
    { setState: () => undefined, getState: () => roomState() },
  ),
  markChatSeen: () => undefined,
  chatTyping: () => undefined,
  chatSend: () => undefined,
  chatReact: () => undefined,
  chatEdit: () => undefined,
  chatDelete: () => undefined,
};

vi.mock('@/lib/api', () => ({
  api: {
    rooms: { listMembers: () => Promise.resolve({ members: [] }) },
    messages: {
      listMessages: () => Promise.resolve({ items: [], nextBefore: null }),
      searchMessages: () => Promise.resolve({ items: [] }),
    },
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      members: Object.entries(NAMES).map(([id, displayName]) => ({
        member: { roomId: ROOM_ID, userId: id as UserId, role: 'member', joinedAt: 0, banned: false },
        user: {
          id: id as UserId,
          email: null,
          displayName,
          avatarUrl: null,
          accentColor: '#7c5cfc',
          createdAt: 0,
        } as User,
      })),
      items: [],
    },
    isPending: false,
    isSuccess: true,
  }),
}));

vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => connection,
  useRoom: () => ({ room: makeRoom(), member: makeMember(), connection }),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

const { ChatPane } = await import('@/components/chat/ChatPane');

const h = React.createElement;

/* ── fixtures ────────────────────────────────────────────────────────────── */

function makeRoom(): Room {
  return {
    id: ROOM_ID,
    kind: 'watch',
    name: 'Keyboard reach room',
    inviteCode: 'ABCD2345' as Room['inviteCode'],
    ownerId: ME,
    policies: {
      playbackControl: 'everyone',
      queueControl: 'everyone',
      chat: 'everyone',
      maxPublishers: 8,
      waitForAll: true,
      skipVoteThreshold: 0.5,
    },
    relayMode: 'mesh',
    theater: false,
    createdAt: 0,
    expiresAt: null,
    hasPassword: false,
  };
}

function makeMember(): Member {
  return { roomId: ROOM_ID, userId: ME, role: 'member', joinedAt: 0, banned: false };
}

const MINUTE = 60_000;

function base(seq: number, body: string): Message {
  return {
    id: `msg_${String(seq)}` as MessageId,
    roomId: ROOM_ID,
    authorId: ROBIN,
    kind: 'text',
    body,
    gifUrl: null,
    attachment: null,
    replyTo: null,
    mentions: [],
    reactions: {},
    pinned: false,
    editedAt: null,
    deletedAt: null,
    seq,
    createdAt: MINUTE * seq,
  };
}

const said = (seq: number, body: string): Message => base(seq, body);
const roomEvent = (seq: number, body: string): Message => ({
  ...base(seq, body),
  kind: 'system',
});
const deleted = (seq: number): Message => ({ ...base(seq, 'gone'), deletedAt: MINUTE * seq });

/* ── harness ─────────────────────────────────────────────────────────────── */

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom ships no matchMedia; useReducedMotion (bubble, composer) asks on
  // first render.
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

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

async function render(messages: Message[]): Promise<void> {
  stub.messages = messages;
  await act(async () => {
    root.render(h(ChatPane, { roomId: ROOM_ID }));
  });
}

function panel(): HTMLElement {
  const el = host.querySelector<HTMLElement>('[aria-label="Chat"]');
  if (el === null) throw new Error('the chat pane did not render');
  return el;
}

/** The rendered rows, in document order. */
function rows(): HTMLElement[] {
  return [...panel().querySelectorAll<HTMLElement>('[data-msg-focusable]')];
}

/** Index of the single row in the tab order, or -1 if the log has no way in. */
function tabStop(): number {
  return rows().findIndex((r) => r.getAttribute('tabindex') === '0');
}

/** The body text of the row currently in the tab order. */
function tabStopText(): string {
  return rows()[tabStop()]?.textContent ?? '';
}

function arrow(key: 'ArrowUp' | 'ArrowDown'): void {
  act(() => {
    rows()[tabStop()]?.focus();
    panel()
      .querySelector('[aria-live="polite"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

/* ── tests ───────────────────────────────────────────────────────────────── */

describe('the one row in the tab order', () => {
  it('is the newest message', async () => {
    await render([said(1, 'first'), said(2, 'second'), said(3, 'newest')]);

    expect(rows()).toHaveLength(3);
    expect(tabStopText()).toContain('newest');
  });

  it('survives a room event arriving last', async () => {
    await render([said(1, 'first'), said(2, 'newest'), roomEvent(3, 'Robin joined the room')]);

    // A system event renders no focusable row, so the log's way in has to fall
    // back to the newest message that IS one. Before, this was -1: no tab stop
    // anywhere in a log whose last line was "Robin joined the room".
    expect(rows()).toHaveLength(2);
    expect(tabStop()).not.toBe(-1);
    expect(tabStopText()).toContain('newest');
  });

  it('survives a tombstone arriving last', async () => {
    await render([said(1, 'newest'), deleted(2)]);

    expect(tabStop()).not.toBe(-1);
    expect(tabStopText()).toContain('newest');
  });

  it('is nowhere when there is nothing to reach', async () => {
    await render([roomEvent(1, 'Robin joined the room')]);

    expect(rows()).toHaveLength(0);
    expect(tabStop()).toBe(-1);
  });
});

describe('arrowing through a log with unfocusable rows in it', () => {
  it('moves the tab stop onto the row the arrow key actually focused', async () => {
    await render([
      said(1, 'oldest'),
      roomEvent(2, 'Robin joined the room'),
      said(3, 'middle'),
      deleted(4),
      said(5, 'newest'),
    ]);

    expect(rows()).toHaveLength(3);
    expect(tabStopText()).toContain('newest');

    arrow('ArrowUp');
    // Focus and the tab stop are two views of one fact, so they have to name
    // the same row. Counting the tab stop in message positions while the Arrow
    // keys counted rendered rows put them two apart here — the two unfocusable
    // rows above.
    expect(tabStopText()).toContain('middle');
    expect(document.activeElement).toBe(rows()[tabStop()]);

    arrow('ArrowUp');
    expect(tabStopText()).toContain('oldest');

    // Clamped, not wrapping: arrowing off the top stays on the oldest message.
    arrow('ArrowUp');
    expect(tabStopText()).toContain('oldest');

    arrow('ArrowDown');
    expect(tabStopText()).toContain('middle');
  });
});
