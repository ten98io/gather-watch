// @vitest-environment jsdom
/**
 * CONSECUTIVE MESSAGES READ AS ONE BLOCK.
 *
 * A fast room is the case chat is actually used in, and the log had no answer
 * for it: every message drew its own surface, its own border and its own
 * author line, so six messages from one person were six identical objects and
 * the eye had to re-read the name each time to learn nothing. The re-composed
 * log opens a RUN with an avatar and a byline and then says nothing more until
 * something changes — a different author, or five quiet minutes.
 *
 * That rule is a fact about a message and its PREDECESSOR, so it lives in
 * ChatPane (the only component holding the window) and is therefore only
 * testable through a mount. Hence jsdom.
 *
 * The fifth case is the one that matters most and is the easiest to lose:
 * grouping is a VISUAL economy. Dropping the repeated name from the screen
 * must not drop it from the accessibility tree, or the log becomes a wall of
 * unattributed sentences to anyone reading it with assistive tech.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member, Message, MessageId, Room, RoomId, User, UserId } from '@gather/contracts';

// `jsx: "preserve"` in tsconfig means vitest's esbuild emits the CLASSIC
// runtime, so every compiled component reaches for a free `React` — same
// workaround as test/report-controls.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = 'room_group' as RoomId;
const ME = 'user_me' as UserId;
const ROBIN = 'user_robin' as UserId;
const SAM = 'user_sam' as UserId;

const NAMES: Readonly<Record<string, string>> = {
  [ME]: 'Me',
  [ROBIN]: 'Robin',
  [SAM]: 'Sam',
};

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

/**
 * A hand-rolled connection rather than a real RoomConnection over a fake
 * socket: nothing here is about transport, and `useRoomState` is only ever
 * called as a selector, so a plain function is the whole seam.
 */
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
          // Wire DATA, not a design value: `User.accentColor` is a required
          // `#rrggbb` on the contract (packages/contracts entities.ts) — every
          // member has one, and the orb ring is where the log spends it. `null`
          // here did not merely under-test the ring, it did not typecheck.
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
    name: 'Group test room',
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

function message(seq: number, authorId: UserId, atMs: number, body: string): Message {
  return {
    id: `msg_${String(seq)}` as MessageId,
    roomId: ROOM_ID,
    authorId,
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
    createdAt: atMs,
  };
}

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

/**
 * One entry per RUN, in order, named by whose run it is.
 *
 * Anchored on `data-group-start` — the run boundary the pane states outright —
 * rather than on the avatar, so this stays true if the opening mark is ever
 * drawn differently, and stays out of the way of the avatar's own
 * accessibility decisions. The name comes from the row's aria-label, which
 * every row carries whether or not it opens a run.
 */
const ROW_LABEL = /^Message from (.+)\. Press the menu key/;

function runs(): string[] {
  return [...panel().querySelectorAll<HTMLElement>('[data-group-start]')].map(
    (el) => ROW_LABEL.exec(el.getAttribute('aria-label') ?? '')?.[1] ?? '',
  );
}

/** Every message row, group start or continuation. */
function rows(): HTMLElement[] {
  return [...panel().querySelectorAll<HTMLElement>('[data-msg-focusable]')];
}

/** Non-overlapping count of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/* ── tests ───────────────────────────────────────────────────────────────── */

describe('a run of messages from one person', () => {
  it('opens once and does not repeat the author', async () => {
    await render([
      message(1, ROBIN, MINUTE, 'starting it'),
      message(2, ROBIN, MINUTE + 1_000, 'and another'),
      message(3, ROBIN, MINUTE + 2_000, 'and one more'),
    ]);

    expect(runs()).toEqual(['Robin']);
    expect(rows()).toHaveLength(3);
    // The visible half of the economy, asserted on what the reader actually
    // sees rather than on how the opening mark happens to be drawn: the name
    // is on the screen ONCE for three messages.
    expect(occurrences(panel().textContent ?? '', 'Robin')).toBe(1);
    // And all three are still on screen — grouping removes the repetition,
    // never the message.
    expect(panel().textContent).toContain('and one more');
  });

  it('keeps a timestamp on every line, including the ones with no byline', async () => {
    await render([
      message(1, ROBIN, MINUTE, 'one'),
      message(2, ROBIN, MINUTE + 1_000, 'two'),
    ]);

    // Exactly one <time> per message: the byline carries the run's, and each
    // continuation carries its own in the author gutter.
    expect(panel().querySelectorAll('time')).toHaveLength(2);
  });
});

describe('what opens a new run', () => {
  it('a different author', async () => {
    await render([
      message(1, ROBIN, MINUTE, 'hi'),
      message(2, ROBIN, MINUTE + 1_000, 'still me'),
      message(3, SAM, MINUTE + 2_000, 'my turn'),
      message(4, ROBIN, MINUTE + 3_000, 'and back'),
    ]);

    expect(runs()).toEqual(['Robin', 'Sam', 'Robin']);
  });

  it('five quiet minutes, even from the same person', async () => {
    await render([
      message(1, ROBIN, MINUTE, 'before'),
      message(2, ROBIN, MINUTE + 6 * MINUTE, 'long after'),
    ]);

    expect(runs()).toEqual(['Robin', 'Robin']);
  });

  it('and nothing else — a four-second gap is the same run', async () => {
    await render([
      message(1, ROBIN, MINUTE, 'before'),
      message(2, ROBIN, MINUTE + 4_000, 'just after'),
    ]);

    expect(runs()).toEqual(['Robin']);
  });
});

describe('grouping is visual economy only', () => {
  it('every row still names its author to a screen reader', async () => {
    await render([
      message(1, ROBIN, MINUTE, 'one'),
      message(2, ROBIN, MINUTE + 1_000, 'two'),
      message(3, ROBIN, MINUTE + 2_000, 'three'),
    ]);

    // The screen shows "Robin" once. The accessibility tree shows it three
    // times, because a continuation row that announces no author is an
    // unattributed sentence.
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Message from Robin. Press the menu key for actions.',
      'Message from Robin. Press the menu key for actions.',
      'Message from Robin. Press the menu key for actions.',
    ]);
  });

  it('gives that label a role, or nothing reads it', async () => {
    await render([message(1, ROBIN, MINUTE, 'one')]);

    // `aria-label` on a bare <div> is dropped: naming an element with the
    // generic role is not something screen readers do. Without a role on the
    // row, the test above asserts an attribute that no reader ever hears — and
    // the whole safety argument for dropping the repeated byline goes with it.
    expect(rows()[0]?.getAttribute('role')).toBe('article');
  });

  it('does not let the orb announce the author a third time', async () => {
    await render([message(1, ROBIN, MINUTE, 'one')]);

    // The row is named "Message from Robin" and the byline says "Robin". An
    // avatar with `role="img" aria-label="Robin"` between them is a third
    // voice for one fact, so the log passes `decorative` (DESIGN.md §8.1, the
    // same call `<Artwork alt=''>` makes).
    expect(panel().querySelectorAll('[role="img"]')).toHaveLength(0);
  });
});
