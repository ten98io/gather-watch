// @vitest-environment jsdom
/**
 * The eight services the browser extension EXISTS for were the only sites
 * Gather refused to queue.
 *
 * providers.ts mapped netflix/primevideo/disneyplus/max/hulu/paramountplus/
 * peacock/crunchyroll to a null MediaRef, and QueuePane turned that null into
 * "X protects its video, so it can't play inside Gather — watch it together
 * with the Gather browser extension". An UNRECOGNISED https host fell through
 * the same function to `{ kind: 'page', url }` and queued fine, driven by the
 * extension's generic driver. So being recognised was strictly worse than
 * being unknown, and the copy recommended the one thing it then blocked.
 *
 * These pin the fix from both ends: the parse yields a real page ref carrying
 * the provider's identity, and the composer adds it. jsdom, because the
 * refusal was never markup — it only existed after a paste and a click.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaRef } from '@gather/contracts';
import type {
  Member,
  QueueItem,
  QueueItemId,
  QueueItemInput,
  Room,
  RoomId,
  UserId,
} from '@gather/contracts';
import { parseProviderUrl } from '@/lib/providers';

// Same classic-runtime workaround as queue-page-link.test.tsx: `jsx: "preserve"`
// means vitest's esbuild emits React.createElement calls.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = 'room_test' as RoomId;
const ME = 'user_me' as UserId;

/** Every DRM host, its registry id, and the name the row must show. */
const DRM_SERVICES = [
  ['https://www.netflix.com/watch/80123456', 'netflix', 'Netflix'],
  ['https://www.primevideo.com/detail/0ABC', 'primevideo', 'Prime Video'],
  ['https://www.disneyplus.com/video/abc-def', 'disneyplus', 'Disney+'],
  ['https://play.max.com/video/watch/abc', 'max', 'Max'],
  ['https://www.hulu.com/watch/abc-def', 'hulu', 'Hulu'],
  ['https://www.paramountplus.com/shows/video/abc/', 'paramountplus', 'Paramount+'],
  ['https://www.peacocktv.com/watch/asset/abc', 'peacock', 'Peacock'],
  ['https://www.crunchyroll.com/watch/ABC123/episode', 'crunchyroll', 'Crunchyroll'],
] as const;

describe('parseProviderUrl hands the DRM tier a real page ref', () => {
  it('gives all eight services a page ref keyed on the pasted url', () => {
    for (const [url, id] of DRM_SERVICES) {
      const parsed = parseProviderUrl(url);
      expect(parsed, url).not.toBeNull();
      // `page:${url}` is what apps/extension/src/driver.ts keys mediaKeyOf on,
      // so the url must survive the parse byte for byte.
      expect(parsed?.ref, url).toEqual({ kind: 'page', url });
      expect(parsed?.provider.id, url).toBe(id);
    }
  });

  it('keeps the provider identity so the row is Netflix, not netflix.com', () => {
    for (const [url, id, name] of DRM_SERVICES) {
      const parsed = parseProviderUrl(url);
      expect(parsed?.provider.name, url).toBe(name);
      expect(parsed?.provider.id, url).toBe(id);
      // The title QueuePane stores. The generic page path uses the bare host;
      // a named service has a better word for itself than its dns entry.
      expect(parsed?.titleHint, url).toBe(name);
    }
  });

  it('keeps the tier at extension, which is what makes the UI ask for it', () => {
    for (const [url] of DRM_SERVICES) {
      const parsed = parseProviderUrl(url);
      expect(parsed?.provider.capability, url).toBe('extension');
      expect(parsed?.provider.note, url).toContain('Gather browser extension');
      expect(parsed?.provider.note, url).toContain('their own account');
    }
  });

  it('emits refs the contract accepts — a page ref is not a local dialect', () => {
    for (const [url] of DRM_SERVICES) {
      expect(() => MediaRef.parse(parseProviderUrl(url)?.ref), url).not.toThrow();
    }
  });

  it('matches subdomains and bare hosts alike', () => {
    for (const url of [
      'https://netflix.com/watch/1',
      'https://www.netflix.com/watch/1',
      'https://m.netflix.com/watch/1',
      'https://help.netflix.com/watch/1',
    ]) {
      expect(parseProviderUrl(url)?.provider.id, url).toBe('netflix');
      expect(parseProviderUrl(url)?.ref, url).toEqual({ kind: 'page', url });
    }
  });

  it('still refuses a non-https paste, named service or not', () => {
    // A page ref is handed to a browser as a link to open, and the contract's
    // HttpsUrl refuses the rest independently. Being on the list buys nothing.
    for (const url of [
      'http://www.netflix.com/watch/80123456',
      'http://www.hulu.com/watch/abc',
      'http://blog.example.com/the-film',
    ]) {
      expect(parseProviderUrl(url), url).toBeNull();
    }
    expect(parseProviderUrl('javascript:alert(1)')).toBeNull();
  });

  it('leaves the unrecognised long tail exactly as it was', () => {
    const url = 'https://blog.example.com/the-film';
    const parsed = parseProviderUrl(url);
    expect(parsed?.ref).toEqual({ kind: 'page', url });
    expect(parsed?.provider.capability).toBe('generic');
    expect(parsed?.provider.name).toBe('blog.example.com');
    expect(parsed?.titleHint).toBe('blog.example.com');
  });

  it('produces no parse that is recognised-but-unqueueable', () => {
    // The defect in one assertion. `ref` is non-nullable in the type now, so
    // this guards the runtime against a future branch reintroducing the state
    // the type no longer describes.
    for (const url of [
      ...DRM_SERVICES.map(([u]) => u),
      'https://www.youtube.com/watch?v=abc123XYZ',
      'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://cdn.example.com/movie.mp4',
      'https://blog.example.com/the-film',
    ]) {
      const parsed = parseProviderUrl(url);
      expect(parsed, url).not.toBeNull();
      expect(parsed?.ref ?? null, url).not.toBeNull();
    }
  });
});

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
  added = [];
  const useRoomState = create(() => ({
    queue: { items: [] as QueueItem[] },
    playback: null,
    presence: {},
  }));
  // Through setState, not a captured array: the store snapshot is what the
  // pane subscribes to, and swapping the seed variable would not reach it.
  seedQueue = (items) => {
    act(() => useRoomState.setState({ queue: { items } }));
  };
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

describe('QueuePane queues the services the extension exists for', () => {
  it('adds every one of the eight instead of erroring', () => {
    for (const [url, , name] of DRM_SERVICES) {
      added = [];
      act(() => root.render(<QueuePane roomId={ROOM_ID} />));
      typeInto(url);
      clickAdd();

      expect(added, url).toEqual([
        { mediaRef: { kind: 'page', url }, title: name, durationMs: null, artworkUrl: null },
      ]);
      // The exact sentence that used to greet a Netflix paste.
      expect(host.textContent, url).not.toContain('protects its video');
      expect(host.textContent, url).not.toContain('can’t play inside Gather');
    }
  });

  it('clears the composer on a DRM add, the same as any other add', () => {
    act(() => root.render(<QueuePane roomId={ROOM_ID} />));
    typeInto('https://www.netflix.com/watch/80123456');
    clickAdd();

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Add to queue"]');
    expect(input?.value).toBe('');
  });

  it('says what will happen BEFORE the add — paste, note, no extra step', () => {
    act(() => root.render(<QueuePane roomId={ROOM_ID} />));
    typeInto('https://www.disneyplus.com/video/abc-def');

    // §12 budgets "add content to queue" at 2 (paste, Add). The honest note is
    // a preview on the composer, not a confirm — it costs nothing to walk past.
    expect(host.textContent).toContain('Disney+');
    expect(host.textContent).toContain('Plays through the Gather browser extension');
    expect(host.textContent).toContain('everyone signs in with their own account');
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain('Add');
  });

  it('keeps saying it on the row, where the fact outlives the composer', () => {
    act(() => root.render(<QueuePane roomId={ROOM_ID} />));
    seedQueue([
      {
        id: 'qi-drm' as QueueItemId,
        mediaRef: { kind: 'page', url: 'https://www.netflix.com/watch/80123456' },
        title: 'Netflix',
        durationMs: null,
        artworkUrl: null,
        addedBy: ME,
        votesToSkip: [],
      },
    ]);

    const row = host.querySelector('[data-queue-item="qi-drm"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Netflix');
    // Not labels.ts's tier word: a page row plays somewhere other than this
    // tab, and that is the only thing the meta line has room to say.
    expect(row?.textContent).toContain('Plays in the Gather extension');
    expect(row?.textContent).not.toContain('Web page');
  });

  it('still refuses a link that is not an https address at all', () => {
    act(() => root.render(<QueuePane roomId={ROOM_ID} />));
    typeInto('http://www.netflix.com/watch/80123456');
    clickAdd();

    expect(added).toEqual([]);
    expect(host.textContent).toContain('https://');
    // The refusal is about the scheme; it must not resurrect a list of sites.
    expect(host.textContent).not.toContain('supported service');
    expect(host.textContent).not.toContain('protects its video');
  });
});
