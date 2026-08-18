// @vitest-environment jsdom
/**
 * QueuePane and the long tail of the web.
 *
 * The owner's report, verbatim: "not known sites added to queue creates a
 * message only supported sites, which raises the question that it is too
 * extensive to add support for each site". Every site outside the 17-entry
 * registry hit one sentence — 'Paste a link from a supported service…' — and
 * stopped there, even though the extension already drives any <video>/<audio>
 * on any page.
 *
 * jsdom, because the refusal is not markup: it only exists after a paste and a
 * click, so a static render can neither see it nor prove it is gone.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member, QueueItemInput, Room, RoomId, UserId } from '@gather/contracts';

// Same classic-runtime workaround as context-menu.test.tsx / call-surface.test.tsx:
// `jsx: "preserve"` means vitest's esbuild emits React.createElement calls.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = 'room_test' as RoomId;
const ME = 'user_me' as UserId;

const roomStub = vi.hoisted(() => ({
  connection: null as unknown,
  room: null as unknown,
  member: null as unknown,
}));

// QueuePane itself never touches the API; RecentlyPlayed (HistoryDialog) does,
// and importing it is enough to need `api` to exist. It used to be stubbed with
// media.listLibrary — the library listing, which has had no server since
// services/media was deleted and no caller since. Playback history is what the
// second button opens now, so that is what the stub answers.
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

const { QueuePane } = await import('@/components/queue/QueuePane');

const room = (): Room => ({
  id: ROOM_ID,
  kind: 'watch',
  name: 'Test room',
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
  expiresAt: null,
  hasPassword: false,
  createdAt: 0,
});

const member = (): Member => ({
  roomId: ROOM_ID,
  userId: ME,
  role: 'host',
  joinedAt: 0,
  banned: false,
});

let host: HTMLDivElement;
let root: Root;
let added: QueueItemInput[];

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom ships no matchMedia; useReducedMotion reads it during render.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  added = [];
  const useRoomState = create(() => ({
    queue: { items: [] },
    playback: null,
    presence: {},
  }));
  roomStub.room = room();
  roomStub.member = member();
  roomStub.connection = {
    useRoomState,
    queueAdd: (item: QueueItemInput) => added.push(item),
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
  vi.restoreAllMocks();
});

/** Drive a controlled React input the way a paste does. */
function typeInto(value: string): void {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Add to queue"]');
  if (input === null) throw new Error('queue input not rendered');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickAdd(): void {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add');
  if (button === undefined) throw new Error('Add button not rendered');
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function paste(url: string): void {
  act(() => root.render(<QueuePane roomId={ROOM_ID} />));
  typeInto(url);
  clickAdd();
}

describe('QueuePane accepts the long tail', () => {
  it('queues an unrecognised https page instead of refusing it', () => {
    paste('https://blog.example.com/the-film');

    expect(added).toEqual([
      {
        mediaRef: { kind: 'page', url: 'https://blog.example.com/the-film' },
        title: 'blog.example.com',
        durationMs: null,
        artworkUrl: null,
      },
    ]);
    expect(host.textContent).not.toContain('supported service');
  });

  it('says in one plain sentence what a page item actually does', () => {
    act(() => root.render(<QueuePane roomId={ROOM_ID} />));
    typeInto('https://blog.example.com/the-film');

    // Honest states over silent failure: the extension drives it on the
    // devices that have it, and the note must not promise more than that.
    expect(host.textContent).toContain('Gather browser extension');
    expect(host.textContent).toContain('just see the link');
  });

  it('still stops at DRM services, which no extension-less page path can play', () => {
    paste('https://www.netflix.com/watch/80123456');

    expect(added).toEqual([]);
    expect(host.textContent).toContain('protects its video');
  });

  it('keeps a known provider on its better path', () => {
    paste('https://www.youtube.com/watch?v=abc123XYZ');

    expect(added[0]?.mediaRef).toEqual({ kind: 'youtube', videoId: 'abc123XYZ' });
  });

  it('refuses a non-https paste without naming a registry', () => {
    paste('javascript:alert(1)');

    expect(added).toEqual([]);
    expect(host.textContent).not.toContain('supported service');
    expect(host.textContent).toContain('https://');
  });
});
