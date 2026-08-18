// @vitest-environment jsdom
/**
 * The room's playback history, in the room.
 *
 * The owner's words about what this replaces: "library is useless and broken,
 * just have a playback history inside the room". So the bar here is not
 * completeness, it is that a row is REAL — it says what played, and the
 * obvious button puts it back in the queue.
 *
 * jsdom, because both claims are behaviour: the list only exists after a
 * fetch resolves, and the re-queue only exists after a click. A static render
 * can prove neither.
 *
 * The remount test is the load-bearing one. components/ui/tabs.tsx UNMOUNTS
 * the inactive pane, so this component is destroyed and rebuilt every time
 * someone switches away from Queue and back. Anything it remembers is gone;
 * it has to re-read on mount or it comes back blank.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemInput, RoomHistoryEntry, RoomId, UserId } from '@gather/contracts';

// Same classic-runtime workaround as queue-page-link.test.tsx: `jsx:
// "preserve"` means vitest's esbuild emits React.createElement calls.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = 'room_test' as RoomId;
const ME = 'user_me' as UserId;
const FRIEND = 'user_friend' as UserId;

const stub = vi.hoisted(() => ({
  getHistory: (() => Promise.resolve({ entries: [], nextBefore: null })) as unknown,
  listMembers: (() => Promise.resolve({ members: [] })) as unknown,
  added: [] as QueueItemInput[],
}));

vi.mock('@/lib/api', () => ({
  api: {
    rooms: {
      getHistory: (...args: unknown[]) =>
        (stub.getHistory as (...a: unknown[]) => Promise<unknown>)(...args),
      listMembers: (...args: unknown[]) =>
        (stub.listMembers as (...a: unknown[]) => Promise<unknown>)(...args),
    },
  },
}));
vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => ({
    queueAdd: (item: QueueItemInput) => stub.added.push(item),
  }),
  useRoom: () => ({ member: { userId: ME } }),
}));

const { HistoryList, historyEntryToQueueInput } = await import(
  '@/components/queue/HistoryDialog'
);

function entry(over: Partial<RoomHistoryEntry> = {}): RoomHistoryEntry {
  const seq = over.seq ?? 1;
  return {
    id: `h${String(seq)}`,
    roomId: ROOM_ID,
    seq,
    mediaRef: { kind: 'youtube', videoId: 'abc123' },
    title: 'Chasing Cars',
    artworkUrl: null,
    durationMs: 210_000,
    queuedBy: FRIEND,
    startedBy: ME,
    playedAt: Date.now(),
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  stub.added = [];
  stub.getHistory = () => Promise.resolve({ entries: [], nextBefore: null });
  stub.listMembers = () => Promise.resolve({ members: [] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/** Render and let the mount fetch settle. */
async function render(): Promise<void> {
  await act(async () => {
    root.render(<HistoryList roomId={ROOM_ID} />);
  });
}

function clickButton(label: string): void {
  const button = [...host.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent) === label,
  );
  if (button === undefined) throw new Error(`no button labelled "${label}"`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('room history list', () => {
  it('shows what played, and who queued it by name', async () => {
    stub.getHistory = () =>
      Promise.resolve({ entries: [entry({ title: 'Chasing Cars' })], nextBefore: null });
    stub.listMembers = () =>
      Promise.resolve({
        members: [{ member: { userId: FRIEND }, user: { id: FRIEND, displayName: 'Ada' } }],
      });

    await render();

    expect(host.textContent).toContain('Chasing Cars');
    expect(host.textContent).toContain('Ada');
    // A raw user id is never shown to a person.
    expect(host.textContent).not.toContain(FRIEND);
  });

  it('names the person who put it on when it was not the queuer', async () => {
    stub.getHistory = () =>
      Promise.resolve({
        entries: [entry({ queuedBy: FRIEND, startedBy: ME })],
        nextBefore: null,
      });
    stub.listMembers = () =>
      Promise.resolve({
        members: [{ member: { userId: FRIEND }, user: { id: FRIEND, displayName: 'Ada' } }],
      });

    await render();

    expect(host.textContent).toContain('queued by Ada, played by you');
  });

  it('re-queues a row as a valid queue add', async () => {
    stub.getHistory = () =>
      Promise.resolve({
        entries: [entry({ durationMs: 210_000, artworkUrl: 'https://img.example.com/a.jpg' })],
        nextBefore: null,
      });
    await render();

    clickButton('Add Chasing Cars to the queue');

    expect(stub.added).toEqual([
      {
        mediaRef: { kind: 'youtube', videoId: 'abc123' },
        title: 'Chasing Cars',
        durationMs: 210_000,
        artworkUrl: 'https://img.example.com/a.jpg',
      },
    ]);
  });

  it('re-reads on every mount — the pane is unmounted when the tab changes', async () => {
    let calls = 0;
    stub.getHistory = () => {
      calls += 1;
      return Promise.resolve({
        entries: [entry({ title: `Read ${String(calls)}` })],
        nextBefore: null,
      });
    };

    await render();
    expect(host.textContent).toContain('Read 1');

    // Switch away and back: tabs.tsx unmounts, so this is a fresh component.
    await act(async () => {
      root.unmount();
    });
    root = createRoot(host);
    await render();

    expect(calls).toBe(2);
    expect(host.textContent).toContain('Read 2');
  });

  it('says plainly when nothing has played yet', async () => {
    await render();
    expect(host.textContent).toContain('Nothing has played');
  });

  it('says the read failed instead of showing an empty room', async () => {
    stub.getHistory = () => Promise.reject(new Error('offline'));
    await render();

    expect(host.textContent).toContain("Couldn't load");
    expect(host.textContent).not.toContain('Nothing has played');
  });

  it('loads an older page and appends it', async () => {
    stub.getHistory = (_roomId: unknown, query: unknown) => {
      const before = (query as { before?: number } | undefined)?.before;
      return before === undefined
        ? Promise.resolve({ entries: [entry({ seq: 2, title: 'Newer' })], nextBefore: 2 })
        : Promise.resolve({ entries: [entry({ seq: 1, title: 'Older' })], nextBefore: null });
    };
    await render();
    expect(host.textContent).toContain('Newer');
    expect(host.textContent).not.toContain('Older');

    await act(async () => {
      clickButton('Show older');
    });

    expect(host.textContent).toContain('Newer');
    expect(host.textContent).toContain('Older');
    // Exhausted — the affordance goes away rather than fetching nothing.
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Show older',
    );
  });
});

describe('historyEntryToQueueInput', () => {
  it('is exactly the four fields a queue add needs', () => {
    expect(historyEntryToQueueInput(entry())).toEqual({
      mediaRef: { kind: 'youtube', videoId: 'abc123' },
      title: 'Chasing Cars',
      durationMs: 210_000,
      artworkUrl: null,
    });
  });
});
