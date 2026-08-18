// @vitest-environment jsdom
/**
 * Unread chat, while you are looking at another tab (E16).
 *
 * The owner said "chat notifications and updates are missing". Half of that is
 * this: there was nothing anywhere in the app that could tell you a message
 * had arrived while you were on Queue or People. TabsTrigger rendered a bare
 * string, and — worse — TabsContent returned null for every inactive tab, so
 * ChatPane was FULLY UNMOUNTED the moment you left it. There was no component
 * alive to count anything, and everything the pane remembered (the exhausted
 * history flag, every extra page pulled in by "load earlier", an open search
 * box, a half-typed reply) was thrown away on every tab switch.
 *
 * So this file pins three claims at once:
 *   1. the unread count is a projection of the ROOM STORE, not of the pane —
 *      it is correct even though nothing rendered it while it accrued,
 *   2. the pane survives a tab switch with its own state intact,
 *   3. returning to Chat clears the badge, and your own messages never
 *      counted in the first place.
 *
 * jsdom, because every one of those is behaviour across a real mount.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestClient } from '@gather/api-client';
import type { FetchLike, WebSocketLike } from '@gather/api-client';
import type { InviteCode, Member, Message, Room, RoomId, ServerEvent, UserId } from '@gather/contracts';

// Same classic-runtime workaround as call-surface.test.tsx: `jsx: "preserve"`
// means vitest's esbuild emits React.createElement calls.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia; useReducedMotion (Composer, MessageBubble) asks
// for one on first render.
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

const ROOM_ID = 'room_test' as RoomId;
const ME = 'user_me' as UserId;
const PEER = 'user_peer' as UserId;

/* ── module doubles ──────────────────────────────────────────────────────── */

const roomStub = vi.hoisted(() => ({ connection: null as unknown }));

vi.mock('@/lib/api', () => ({
  api: {
    rooms: { listMembers: () => Promise.resolve({ members: [] }) },
    messages: {
      listMessages: () => Promise.resolve({ items: [], nextBefore: null }),
      searchMessages: () => Promise.resolve({ items: [] }),
    },
  },
  WS_URL: 'ws://test/ws',
  ensureAccessToken: () => Promise.resolve('tok'),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { members: [], items: [] }, isPending: false, isSuccess: true }),
}));
vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => roomStub.connection,
  useRoom: () => ({ room: makeRoom(), member: makeMember(), connection: roomStub.connection }),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

const { RoomConnection } = await import('@/lib/room-connection');
const { ChatPane } = await import('@/components/chat/ChatPane');
const { Tabs, TabsContent, TabsList, TabsTrigger } = await import('@/components/ui/tabs');

const h = React.createElement;

/* ── fixtures ────────────────────────────────────────────────────────────── */

function makeRoom(): Room {
  return {
    id: ROOM_ID,
    kind: 'watch',
    name: 'Test room',
    inviteCode: 'ABCD2345' as InviteCode,
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
  };
}

function makeMember(): Member {
  return {
    roomId: ROOM_ID,
    userId: ME,
    role: 'host',
    joinedAt: 0,
    banned: false,
  };
}

function message(seq: number, authorId: UserId, body: string): Message {
  return {
    id: `msg_${String(seq)}` as Message['id'],
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
    createdAt: 1_000 + seq,
  };
}

/* ── fake socket ─────────────────────────────────────────────────────────── */

class FakeSocket implements WebSocketLike {
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: string[] = [];

  static instances: FakeSocket[] = [];
  static reset(): void {
    FakeSocket.instances = [];
  }

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.({});
  }
  open(): void {
    this.onopen?.();
  }
  deliver(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

/* ── harness ─────────────────────────────────────────────────────────────── */

let host: HTMLDivElement;
let root: Root;
let socket: FakeSocket;

/** The room rail, exactly as room-shell composes it (chat is the default tab). */
function Shell() {
  const [tab, setTab] = React.useState('chat');
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="chat">Chat</TabsTrigger>
        <TabsTrigger value="queue">Queue</TabsTrigger>
      </TabsList>
      <TabsContent value="chat">
        <ChatPane roomId={ROOM_ID} />
      </TabsContent>
      <TabsContent value="queue">
        <p>the queue pane</p>
      </TabsContent>
    </Tabs>
  );
}

/** The rail tab button whose label starts with `label`. */
function trigger(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) =>
    (el.textContent ?? '').startsWith(label),
  );
  if (found === undefined) throw new Error(`no tab trigger for ${label}`);
  return found;
}

function click(el: HTMLElement): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The chat panel element, whether or not it is the visible tab. */
function chatPanel(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[aria-label="Chat"]');
}

async function deliver(...events: ServerEvent[]): Promise<void> {
  await act(async () => {
    for (const event of events) socket.deliver(event);
  });
}

function chatMessage(seq: number, authorId: UserId, body: string): ServerEvent {
  return {
    type: 'chat.message',
    roomId: ROOM_ID,
    seq,
    ts: 1_000 + seq,
    payload: message(seq, authorId, body),
  };
}

beforeEach(async () => {
  FakeSocket.reset();
  const fetchImpl: FetchLike = async () => {
    throw new Error('no REST calls expected');
  };
  const connection = new RoomConnection({
    api: new RestClient('http://test', { fetchImpl }),
    roomId: ROOM_ID,
    userId: ME,
    getToken: async () => 'tok',
    wsBaseUrl: 'ws://test/ws',
    socketOptions: {
      wsCtor: FakeSocket,
      heartbeatMs: 60_000,
      backoffBaseMs: 60_000,
      setTimeoutFn: (fn) => fn,
      clearTimeoutFn: () => undefined,
    },
  });
  roomStub.connection = connection;
  await connection.connect();
  socket = FakeSocket.instances[0]!;
  socket.open();

  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(h(Shell));
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  (roomStub.connection as { close(): void }).close();
});

/* ── tests ───────────────────────────────────────────────────────────────── */

describe('unread chat badge', () => {
  it('shows nothing while Chat is the tab you are on', async () => {
    await deliver(chatMessage(1, PEER, 'hello'));
    expect(trigger('Chat').textContent).toBe('Chat');
  });

  it('counts what arrived while you were on another tab', async () => {
    await click(trigger('Queue'));
    await deliver(chatMessage(1, PEER, 'first'), chatMessage(2, PEER, 'second'));

    // Visible digit AND words, so the tab is still announced as "Chat".
    expect(trigger('Chat').textContent).toContain('2');
    expect(trigger('Chat').textContent).toContain('2 unread');
    expect(trigger('Chat').getAttribute('aria-label')).toBeNull();
  });

  it('never counts your own messages', async () => {
    await click(trigger('Queue'));
    await deliver(chatMessage(1, ME, 'mine'), chatMessage(2, PEER, 'theirs'));

    expect(trigger('Chat').textContent).toContain('1');
    expect(trigger('Chat').textContent).not.toContain('2');
  });

  it('keeps the count while the tab is away — the store holds it, not the pane', async () => {
    await click(trigger('Queue'));
    await deliver(chatMessage(1, PEER, 'first'));
    // Bounce through a third render pass; the count is a projection of store
    // state, so nothing about re-rendering the rail may disturb it.
    await click(trigger('Queue'));
    expect(trigger('Chat').textContent).toContain('1');
  });

  it('clears when you come back to Chat', async () => {
    await click(trigger('Queue'));
    await deliver(chatMessage(1, PEER, 'first'));
    expect(trigger('Chat').textContent).toContain('1');

    await click(trigger('Chat'));
    expect(trigger('Chat').textContent).toBe('Chat');

    // …and the read cursor really went out, once, for the newest seq.
    const reads = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; payload: { lastReadSeq?: number } })
      .filter((frame) => frame.type === 'chat.read');
    expect(reads.map((r) => r.payload.lastReadSeq)).toEqual([1]);
  });
});

describe('the seen anchor lives on the connection', () => {
  it('advances without a socket — the receipt is optional, the anchor is not', () => {
    const offline = new RoomConnection({
      api: new RestClient('http://test', {
        fetchImpl: async () => {
          throw new Error('no REST calls expected');
        },
      }),
      roomId: ROOM_ID,
      getToken: async () => 'tok',
      wsBaseUrl: 'ws://test/ws',
      socketOptions: { wsCtor: FakeSocket },
    });
    // Never connected: RoomSocket.send throws outright, and the chat pane can
    // render inside exactly that window on a fresh room mount.
    expect(() => {
      offline.markChatSeen(7);
    }).not.toThrow();
    expect(offline.useRoomState.getState().chatSeenSeq).toBe(7);
    // Monotonic: a stale cursor never rewinds it.
    offline.markChatSeen(3);
    expect(offline.useRoomState.getState().chatSeenSeq).toBe(7);
  });
});

describe('chat pane across a tab switch', () => {
  it('is not unmounted — it is hidden', async () => {
    expect(chatPanel()).not.toBeNull();
    await click(trigger('Queue'));

    const panel = chatPanel();
    expect(panel).not.toBeNull();
    expect(panel?.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);
    expect(host.textContent).toContain('the queue pane');
  });

  it('keeps its own state — an open search box is still open when you return', async () => {
    const searchToggle = host.querySelector<HTMLButtonElement>('[aria-label="Search chat"]');
    expect(searchToggle).not.toBeNull();
    await click(searchToggle!);
    expect(host.querySelector('[aria-label="Search messages"]')).not.toBeNull();

    await click(trigger('Queue'));
    await click(trigger('Chat'));

    expect(host.querySelector('[aria-label="Search messages"]')).not.toBeNull();
  });

  it('keeps the exhausted-history flag it paid a request for', async () => {
    const connection = roomStub.connection as {
      useRoomState: { setState(patch: Record<string, unknown>): void; getState(): Record<string, unknown> };
    };
    await act(async () => {
      connection.useRoomState.setState({ chatHistoryExhausted: true });
    });
    await click(trigger('Queue'));
    await click(trigger('Chat'));

    expect(connection.useRoomState.getState()['chatHistoryExhausted']).toBe(true);
  });
});
