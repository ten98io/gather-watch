// @vitest-environment jsdom
/**
 * The queue as a list of MEDIA rather than a form.
 *
 * Duration reporting landed this session, so `durationMs` is populated in
 * practice instead of always null — and the moment it is, two things become
 * assertable that were previously vacuous:
 *
 *   • A row's length has to be spelled the same way as the same item's length
 *     in the history dialog. It was not: the queue used `permissions.formatMs`,
 *     which has no hours field, so a 97-minute film read "97:12" in one list
 *     and "1:37:12" in the other, three centimetres apart.
 *   • The pane can total itself — and must refuse to when any item's length is
 *     still unknown, because a total that silently omits three items is a wrong
 *     number in the one place a reader would trust one.
 *
 * jsdom, because all of it is composition: none of it exists until the pane has
 * a store to read.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Member,
  QueueItem,
  QueueItemId,
  Room,
  RoomId,
  RoomPolicyLevel,
  UserId,
} from '@gather/contracts';

// Same classic-runtime workaround as queue-page-link.test.tsx: `jsx: "preserve"`
// means vitest's esbuild emits React.createElement calls.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = 'room_test' as RoomId;
const ME = 'user_me' as UserId;

const MINUTE = 60_000;

const roomStub = vi.hoisted(() => ({
  connection: null as unknown,
  room: null as unknown,
  member: null as unknown,
}));

// QueuePane never calls the API; RecentlyPlayed (HistoryDialog) does, and
// importing QueuePane is enough to need `api` to exist.
vi.mock('@/lib/api', () => ({
  api: {
    rooms: {
      getHistory: () => Promise.resolve({ entries: [], nextBefore: null }),
      listMembers: () => Promise.resolve({ members: [] }),
    },
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { items: [] }, isPending: false, isSuccess: true }),
}));
vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => roomStub.connection,
  useRoom: () => ({ room: roomStub.room, member: roomStub.member }),
}));

const { QueuePane, totalRuntime } = await import('@/components/queue/QueuePane');

const room = (queueControl: RoomPolicyLevel = 'everyone'): Room => ({
  id: ROOM_ID,
  kind: 'watch',
  name: 'Test room',
  inviteCode: 'ABCD2345' as Room['inviteCode'],
  ownerId: ME,
  policies: {
    playbackControl: 'everyone',
    queueControl,
    chat: 'everyone',
    maxPublishers: 8,
    waitForAll: true,
    skipVoteThreshold: 0.5,
  },
  relayMode: 'mesh',
  theater: false,
  expiresAt: null,
  hasPassword: false,
  createdAt: 0,
});

const member = (role: Member['role'] = 'host'): Member => ({
  roomId: ROOM_ID,
  userId: ME,
  role,
  joinedAt: 0,
  banned: false,
});

function item(id: string, title: string, durationMs: number | null): QueueItem {
  return {
    id: id as QueueItemId,
    mediaRef: { kind: 'youtube', videoId: 'abc123XYZ' },
    title,
    durationMs,
    artworkUrl: null,
    addedBy: ME,
    votesToSkip: [],
  };
}

let host: HTMLDivElement;
let root: Root;
let seedQueue: (items: QueueItem[]) => void;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom ships no matchMedia; useReducedMotion reads it during render.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  const useRoomState = create(() => ({
    queue: { items: [] as QueueItem[] },
    playback: null,
    presence: {},
  }));
  seedQueue = (items) => {
    act(() => useRoomState.setState({ queue: { items } }));
  };
  roomStub.room = room();
  roomStub.member = member();
  roomStub.connection = {
    useRoomState,
    queueAdd: () => undefined,
    queueRemove: () => undefined,
    queueReorder: () => undefined,
    queueVoteSkip: () => undefined,
    syncSetTrackByQueue: () => undefined,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(): void {
  act(() => root.render(<QueuePane roomId={ROOM_ID} />));
}

describe('totalRuntime', () => {
  it('reads in words rather than as a clock', () => {
    expect(totalRuntime([item('a', 'A', 45 * MINUTE), item('b', 'B', 30 * MINUTE)])).toBe(
      '1 hr 15 min',
    );
    expect(totalRuntime([item('a', 'A', 48 * MINUTE)])).toBe('48 min');
    expect(totalRuntime([item('a', 'A', 120 * MINUTE)])).toBe('2 hr');
    expect(totalRuntime([item('a', 'A', 20_000)])).toBe('under a minute');
  });

  it('refuses to total a queue that contains an unknown length', () => {
    // The failure this exists to stop is a CONFIDENT wrong number: three
    // un-enriched items silently contributing zero.
    expect(totalRuntime([item('a', 'A', 45 * MINUTE), item('b', 'B', null)])).toBeNull();
    expect(totalRuntime([item('a', 'A', null)])).toBeNull();
  });

  it('has nothing to say about an empty queue', () => {
    expect(totalRuntime([])).toBeNull();
  });
});

describe('the queue header', () => {
  it('names the pane, then counts it, then times it', () => {
    render();
    seedQueue([item('a', 'A', 45 * MINUTE), item('b', 'B', 30 * MINUTE)]);

    const header = host.querySelector('h3');
    expect(header?.textContent).toContain('Up next');
    expect(header?.textContent).toContain('2 items');
    expect(header?.textContent).toContain('1 hr 15 min');
  });

  it('keeps the count and drops the runtime when a length is missing', () => {
    render();
    seedQueue([item('a', 'A', 45 * MINUTE), item('b', 'B', null)]);

    const header = host.querySelector('h3');
    expect(header?.textContent).toContain('2 items');
    expect(header?.textContent).not.toContain('hr');
    expect(header?.textContent).not.toContain('min');
  });

  it('says one item, not 1 items', () => {
    render();
    seedQueue([item('a', 'A', null)]);

    expect(host.querySelector('h3')?.textContent).toContain('1 item');
    expect(host.querySelector('h3')?.textContent).not.toContain('1 items');
  });

  it('still names the pane when there is nothing in it', () => {
    render();

    const header = host.querySelector('h3');
    expect(header?.textContent).toContain('Up next');
    expect(header?.textContent).toContain('Nothing queued');
  });
});

describe('a queue row reads as a piece of media', () => {
  it('spells a long runtime the way the history dialog spells it', () => {
    render();
    // 1:37:12. `permissions.formatMs` rendered this as "97:12".
    seedQueue([item('a', 'The long one', 97 * MINUTE + 12_000)]);

    const row = host.querySelector('[data-queue-item="a"]');
    expect(row?.textContent).toContain('1:37:12');
    expect(row?.textContent).not.toContain('97:12');
  });

  it('carries the artwork, the title and who added it on one row', () => {
    render();
    seedQueue([item('a', 'The long one', 12 * MINUTE)]);

    const row = host.querySelector('[data-queue-item="a"]');
    expect(row?.textContent).toContain('The long one');
    expect(row?.textContent).toContain('added by you');
    // <Artwork> never renders an empty box, so a row without a poster URL
    // still has a poster element (DESIGN.md §8.1).
    expect(row?.querySelector('[aria-label="The long one"], img')).not.toBeNull();
  });
});

describe('the empty queue', () => {
  it('invites rather than apologises when you may queue', () => {
    render();

    expect(host.textContent).toContain('Queue the first thing');
    expect(host.textContent).toContain('Paste any link above');
  });

  it('explains instead of inviting when the room will not let you', () => {
    roomStub.room = room('host');
    roomStub.member = member('member');
    render();

    expect(host.textContent).not.toContain('Queue the first thing');
    expect(host.textContent).toContain('Whoever is running the room');
    // An inert field is worse than no field.
    expect(host.querySelector('input[aria-label="Add to queue"]')).toBeNull();
  });
});
