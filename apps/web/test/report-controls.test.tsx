// @vitest-environment jsdom
/**
 * THE REPORT BUTTON, WHICH DID NOT EXIST.
 *
 * `POST /report` has been live the whole time — the admin queue reads it, the
 * takedown engine acts on it — and app/legal/abuse/page.tsx tells every user,
 * in writing, that "Every message, user, room, and upload can be reported from
 * inside the app (Message → Report, member list, room menu)". None of those
 * three controls existed. A product that promises a way to report abuse and
 * ships none is worse than one that promises nothing.
 *
 * So this file is the promise, as a test: all three entry points, each one
 * proved to (a) exist for the people who need it — which is EVERYONE, since
 * the route gates on nothing but a verified identity — (b) send the target
 * shape ReportBody actually declares, and (c) say so out loud when it fails.
 *
 * jsdom throughout, because two of the three controls do not exist in static
 * markup at all: the message action lives behind a context menu that renders
 * nothing until a pointer position exists, and the room action lives inside a
 * closed dialog.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@gather/api-client';
import type { Member, Message, MessageId, Room, User, UserId } from '@gather/contracts';

// `tsconfig.json` sets `jsx: "preserve"` (Next compiles JSX itself), so
// vitest's esbuild falls back to the classic runtime and every compiled
// component reaches for a free `React` — same workaround as
// test/context-menu.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface ReportCall {
  target: { kind: string; [key: string]: unknown };
  reason: string;
}

const stub = vi.hoisted(() => ({
  reports: [] as ReportCall[],
  /** Next report rejects with this code instead of resolving. */
  failWith: null as string | null,
  roster: [] as Array<{ member: unknown; user: unknown }>,
  room: null as unknown as Room,
  member: null as unknown as Member,
}));

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

vi.mock('@/lib/api', () => ({
  api: {
    reports: {
      create: (body: ReportCall) => {
        stub.reports.push(body);
        const code = stub.failWith;
        if (code !== null) {
          return Promise.reject(new ApiError(code as 'RATE_LIMITED', 'raw server body', 429));
        }
        return Promise.resolve({ ok: true as const, reportId: 'rep_1' });
      },
    },
    rooms: {
      listMembers: () => Promise.resolve({ members: stub.roster }),
      leaveRoom: () => Promise.resolve({ ok: true as const }),
      updatePolicies: () => Promise.resolve({ room: stub.room }),
      setMemberRole: () => Promise.resolve({ member: stub.member }),
      transferHost: () => Promise.resolve({ ok: true as const }),
      kickMember: () => Promise.resolve({ ok: true as const }),
      banMember: () => Promise.resolve({ ok: true as const }),
    },
    messages: { pinMessage: () => Promise.resolve({ ok: true as const }) },
  },
  apiFetch: () => Promise.resolve({}),
}));

vi.mock('@/lib/room-context', () => ({
  // Named only because test/helpers/room-render.ts destructures it on import;
  // nothing here renders a provider — the two hooks below are the seam.
  RoomProvider: ({ children }: { children: React.ReactNode }) => children,
  useRoom: () => ({ room: stub.room, member: stub.member }),
  useRoomConnection: () => ({
    useRoomState: (select: (s: { presence: object; membersVersion: number }) => unknown) =>
      select({ presence: {}, membersVersion: 0 }),
    chatDelete: () => {},
    chatEdit: () => {},
    chatReact: () => {},
  }),
}));

const { MessageBubble } = await import('@/components/chat/MessageBubble');
const { PeoplePane } = await import('@/components/people/PeoplePane');
const { RoomMenu } = await import('@/components/room/RoomMenu');
const { Toaster } = await import('@/components/ui/toast');
const { ME, ROOM_ID, makeMember, makeRoom } = await import('./helpers/room-render');

const h = React.createElement;
const FRIEND = 'user-friend' as UserId;

function user(id: UserId, displayName: string): User {
  return {
    id,
    email: null,
    displayName,
    avatarUrl: null,
    accentColor: '#7c5cfc',
    createdAt: 1_000,
  } as User;
}

function memberRow(userId: UserId, role: Member['role']): Member {
  return { roomId: ROOM_ID, userId, role, joinedAt: 1_000, banned: false };
}

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1' as MessageId,
    roomId: ROOM_ID,
    authorId: FRIEND,
    kind: 'text',
    body: 'come watch this',
    gifUrl: null,
    attachment: null,
    replyTo: null,
    mentions: [],
    reactions: {},
    pinned: false,
    editedAt: null,
    deletedAt: null,
    seq: 1,
    createdAt: 1_000,
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stub.reports = [];
  stub.failWith = null;
  stub.room = makeRoom('watch');
  stub.member = makeMember('member');
  stub.roster = [
    { member: memberRow(ME, 'member'), user: user(ME, 'Me') },
    { member: memberRow(FRIEND, 'member'), user: user(FRIEND, 'Robin') },
  ];
  // jsdom ships no matchMedia; useReducedMotion (bubble, dialog) asks for it.
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

/** Everything on screen, including the portalled dialogs and toasts. */
function buttons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')];
}

function labelled(name: string): HTMLElement | undefined {
  return buttons().find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name);
}

function press(name: string): void {
  const el = labelled(name);
  if (el === undefined) throw new Error(`no control named "${name}"`);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The report dialog's reason field, once it is open. */
function reasonField(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Why are you reporting this?"]',
  );
  if (el === null) throw new Error('the report dialog is not open');
  return el;
}

/**
 * Type a reason and press the real button — the last two steps of every
 * report, and the third of at most three from the room screen (DESIGN.md §12).
 *
 * The value goes in through the prototype setter because React tracks the
 * last value it wrote to a controlled field; assigning `field.value` directly
 * leaves that tracker in agreement with the new text and the change event is
 * swallowed.
 */
async function sendReport(reason: string): Promise<void> {
  const field = reasonField();
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setValue?.call(field, reason);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    labelled('Send report')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

/** True when a toast card is showing this sentence. */
function toastSaying(text: string): boolean {
  return [...document.querySelectorAll('[role="alert"], [role="status"]')].some((card) =>
    card.textContent?.includes(text),
  );
}

async function mount(node: React.ReactNode): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(h(QueryClientProvider, { client }, node, h(Toaster, null)));
  });
  // PeoplePane's roster is a react-query read: the first paint is the pending
  // state, and the rows arrive on react-query's own scheduler — a macrotask,
  // not a microtask, so awaiting promises alone leaves the list empty.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The context menu only exists once a pointer position does. */
function rightClickMessage(): void {
  const bubble = host.querySelector<HTMLElement>('[data-msg-focusable]');
  if (bubble === null) throw new Error('the bubble did not render');
  act(() => {
    bubble.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    );
  });
}

function bubble(msg: Message): React.ReactNode {
  return h(MessageBubble, {
    msg,
    me: ME,
    authorName: 'Robin',
    authorAccent: null,
    canModerate: false,
    groupStart: true,
    replyTarget: undefined,
    replyTargetName: undefined,
    highlighted: false,
    tabIndex: 0,
    onReply: () => {},
  });
}

describe('Message → Report', () => {
  it('files a message target carrying BOTH ids the contract asks for', async () => {
    await mount(bubble(message()));
    rightClickMessage();
    press('Report');
    await sendReport('  spam link  ');

    // ReportTarget's message variant is a COMPOUND reference (messageId +
    // roomId) and the server 404s a pair that does not match, so sending the
    // id alone would fail every time while looking correct here.
    expect(stub.reports).toEqual([
      { target: { kind: 'message', messageId: 'msg-1', roomId: ROOM_ID }, reason: 'spam link' },
    ]);
    expect(toastSaying('Report sent to the operator')).toBe(true);
  });

  it('is offered to a plain member — reporting is not a moderator power', async () => {
    stub.member = makeMember('member');
    await mount(bubble(message()));
    rightClickMessage();
    expect(labelled('Report')).toBeDefined();
  });

  it('is not offered on your own message', async () => {
    await mount(bubble(message({ authorId: ME })));
    rightClickMessage();
    expect(labelled('Report')).toBeUndefined();
  });

  it('sends nothing until there is a reason to send', async () => {
    await mount(bubble(message()));
    rightClickMessage();
    press('Report');
    await sendReport('   ');
    expect(stub.reports).toEqual([]);
  });

  it('says so when the server refuses, in words and not the raw body', async () => {
    stub.failWith = 'RATE_LIMITED';
    await mount(bubble(message()));
    rightClickMessage();
    press('Report');
    await sendReport('spam link');

    expect(toastSaying('You’re doing that too fast — give it a moment.')).toBe(true);
    expect(toastSaying('raw server body')).toBe(false);
    // The dialog stays open, so the reason is not lost with the failure.
    expect(reasonField().value).toBe('spam link');
  });
});

describe('member list → Report', () => {
  it('sits on every row but your own, for a member with no powers at all', async () => {
    stub.member = makeMember('member');
    await mount(h(PeoplePane, { roomId: ROOM_ID }));

    expect(labelled('Report Robin')).toBeDefined();
    expect(labelled('Report Me')).toBeUndefined();
    // …and none of the moderation controls came with it.
    expect(labelled('Kick Robin')).toBeUndefined();
    expect(labelled('Ban Robin')).toBeUndefined();
  });

  it('files a user target', async () => {
    await mount(h(PeoplePane, { roomId: ROOM_ID }));
    press('Report Robin');
    await sendReport('harassing people in chat');

    expect(stub.reports).toEqual([
      { target: { kind: 'user', userId: FRIEND }, reason: 'harassing people in chat' },
    ]);
  });

  it('reports the person the row belongs to, not the last one rendered', async () => {
    // One dialog serves the whole roster, so the target has to travel with the
    // press rather than live in the row.
    stub.roster = [
      ...stub.roster,
      {
        member: memberRow('user-third' as UserId, 'member'),
        user: user('user-third' as UserId, 'Sam'),
      },
    ];
    await mount(h(PeoplePane, { roomId: ROOM_ID }));
    press('Report Sam');
    await sendReport('impersonation');

    expect(stub.reports[0]?.target).toEqual({ kind: 'user', userId: 'user-third' });
  });

  it('surfaces a refusal', async () => {
    stub.failWith = 'FORBIDDEN';
    await mount(h(PeoplePane, { roomId: ROOM_ID }));
    press('Report Robin');
    await sendReport('harassing people in chat');
    expect(toastSaying('You don’t have permission to do that here.')).toBe(true);
  });
});

describe('room menu → Report', () => {
  it('opens for a plain member at all — the menu used to render nothing', async () => {
    stub.member = makeMember('member');
    await mount(h(RoomMenu, { room: stub.room, canManage: false }));
    press('Room settings');

    expect(labelled('Report this room…')).toBeDefined();
    // Without the manage rows: a member is offered no room-wide power.
    expect(labelled('Rename')).toBeUndefined();
    expect(labelled('Delete room…')).toBeUndefined();
  });

  it('files a room target', async () => {
    stub.member = makeMember('member');
    await mount(h(RoomMenu, { room: stub.room, canManage: false }));
    press('Room settings');
    press('Report this room…');
    await sendReport('the queue is nothing but stolen films');

    expect(stub.reports).toEqual([
      {
        target: { kind: 'room', roomId: ROOM_ID },
        reason: 'the queue is nothing but stolen films',
      },
    ]);
  });

  it('replaces the settings dialog rather than stacking a second one on it', async () => {
    stub.member = makeMember('host');
    await mount(h(RoomMenu, { room: stub.room, canManage: true }));
    press('Room settings');
    press('Report this room…');
    // AnimatePresence holds the settings panel through its exit transition, so
    // "one dialog" is only true once that has run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    const open = [...document.querySelectorAll('[role="dialog"]')].map((d) =>
      d.getAttribute('aria-label'),
    );
    expect(open).toEqual(['Report this room']);
  });

  it('surfaces a refusal', async () => {
    stub.failWith = 'VALIDATION';
    stub.member = makeMember('member');
    await mount(h(RoomMenu, { room: stub.room, canManage: false }));
    press('Room settings');
    press('Report this room…');
    await sendReport('x');
    expect(toastSaying('That didn’t look right — check it and try again.')).toBe(true);
  });
});
