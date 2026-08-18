// @vitest-environment jsdom
/**
 * THE LAST MILE of E7: an extension-driven room reaching the end of an item.
 *
 * When the extension drives, StagePane deliberately builds NO adapter (two
 * players for one room is the bug that rule exists to prevent), so
 * `adapter.on('ended')` — the only thing that has ever advanced this queue —
 * can never fire. The extension has always reported the end; the page had
 * nothing listening, and an extension-driven room played one item and sat
 * there forever.
 *
 * The bridge's own half (the event union, the port arm, `onEnded`) is proven in
 * extension-bridge.test.ts against a fake chrome. This file proves what the
 * STAGE does with it, so the bridge is mocked down to an emitter and the two
 * fixtures that matter are the real ones: `extensionMediaKey` (the item
 * identity the payload is matched against) and StagePane itself.
 *
 * jsdom, because every claim here lives in an effect.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndedPayload } from '@/lib/extension-bridge';
import type { MediaRef, Member, QueueItem } from '@gather/contracts';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The extension's event port, reduced to something a test can fire. */
const bridge = vi.hoisted(() => ({
  listeners: new Set<(e: EndedPayload) => void>(),
  emit(payload: EndedPayload): void {
    for (const cb of [...this.listeners]) cb(payload);
  },
}));

vi.mock('@/lib/extension-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/extension-bridge')>();
  return {
    ...actual,
    onEnded: (cb: (e: EndedPayload) => void) => {
      bridge.listeners.add(cb);
      return () => bridge.listeners.delete(cb);
    },
  };
});

/** The extension is installed, compatible, and driving the user's own tab. */
vi.mock('@/lib/player/extension-driver', () => ({
  useExtensionDriver: () => ({
    state: {
      phase: 'ready' as const,
      extensionVersion: '0.1.0',
      protocolVersion: 1,
      capabilities: ['handoff', 'telemetry', 'ended'],
      driving: true,
      connected: true,
      roomId: 'room-static',
      roomName: 'Static test room',
      provider: { id: 'generic', name: 'This page', tier: 'generic' },
      hasMedia: true,
      notice: null,
    },
    checking: false,
    ready: true,
    driving: true,
    refresh: () => undefined,
    supports: () => true,
    handoff: () => Promise.resolve({ ok: true as const }),
    sendIntent: () => Promise.resolve({ ok: true as const }),
    release: () => Promise.resolve({ ok: true as const }),
  }),
}));

const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { StagePane } = await import('@/components/stage/StagePane');
const { ROOM_ID, makeMember, makeRoom, queueItem } = await import('./helpers/room-render');
type RoomConnection = ReturnType<typeof useRoomConnection>;

const h = React.createElement;

/** A page ref: the long-tail item only the extension can ever play. */
const PLAYING: MediaRef = { kind: 'page', url: 'https://example.com/watch/one' };
const NEXT: MediaRef = { kind: 'page', url: 'https://example.com/watch/two' };

/** What the extension puts on the wire for PLAYING (driver.ts `mediaKeyOf`). */
const PLAYING_KEY = 'page:https://example.com/watch/one';

function endedFor(mediaKey: string | null): EndedPayload {
  return { positionMs: 59_000, durationMs: 60_000, mediaKey, at: Date.now() };
}

let captured: RoomConnection | null = null;

function Seeded({ patch, children }: { patch: Record<string, unknown>; children?: React.ReactNode }) {
  const connection = useRoomConnection();
  captured = connection;
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

describe('an extension-driven item that runs out', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    bridge.listeners.clear();
    captured = null;
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

  async function mountDriven(role: Member['role']): Promise<{
    ended: ReturnType<typeof vi.fn>;
    items: QueueItem[];
  }> {
    const items = [queueItem(PLAYING, 'the one ending'), queueItem(NEXT, 'the one after')];
    const patch = {
      playback: {
        mediaRef: PLAYING,
        positionMs: 58_000,
        rate: 1,
        playing: true,
        serverTs: Date.now(),
        seq: 1,
        queueIndex: 0,
      },
      queue: { items, version: 1 },
    };

    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room: makeRoom('watch'), member: makeMember(role), roomId: ROOM_ID } as never,
          h(Seeded, { patch }, h(StagePane, { roomId: ROOM_ID })),
        ),
      );
    });

    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');
    const ended = vi.fn();
    connection.syncAdvance = ended as unknown as typeof connection.syncAdvance;
    return { ended, items };
  }

  it('the stage subscribes at all — nothing was listening before', async () => {
    await mountDriven('host');
    expect(bridge.listeners.size).toBeGreaterThan(0);
  });

  it('tells the room the item ended when the extension says it did', async () => {
    const { ended, items } = await mountDriven('host');

    await act(async () => {
      bridge.emit(endedFor(PLAYING_KEY));
    });

    expect(ended.mock.calls).toEqual([[items[0]?.id]]);
  });

  it('reports exactly once — the extension does not de-duplicate, so we do', async () => {
    // apps/extension/src/background.ts says so out loud: its content script
    // makes one judgement per item and the worker adds no second opinion. The
    // server would drop the repeats now (it only moves a room still sitting on
    // the item named), but sending three of them is noise, not a design.
    const { ended, items } = await mountDriven('host');

    await act(async () => {
      bridge.emit(endedFor(PLAYING_KEY));
      bridge.emit(endedFor(PLAYING_KEY));
      bridge.emit(endedFor(PLAYING_KEY));
    });

    expect(ended.mock.calls).toEqual([[items[0]?.id]]);
  });

  it('ignores a late end for an item the room has already left', async () => {
    const { ended } = await mountDriven('host');

    await act(async () => {
      bridge.emit(endedFor('page:https://example.com/watch/something-else'));
    });

    expect(ended.mock.calls).toEqual([]);
  });

  it('ignores an end that names no item', async () => {
    // The extension sends null when its own room had no ref. Null matches
    // nothing on any stage, and must never be read as "the current one".
    const { ended } = await mountDriven('host');

    await act(async () => {
      bridge.emit(endedFor(null));
    });

    expect(ended.mock.calls).toEqual([]);
  });

  it('reports from a plain member too — the extension path is nobody’s privilege', async () => {
    // This used to assert `toEqual([])`: only the room's one elected advancer
    // was allowed to hand the queue on. The extension makes that election worse
    // than useless — the person whose tab is actually playing the item is the
    // one who KNOWS it ended, and they are routinely not the host. The intent
    // reports a fact, so anyone who saw it may report it.
    const { ended, items } = await mountDriven('member');

    await act(async () => {
      bridge.emit(endedFor(PLAYING_KEY));
    });

    expect(ended.mock.calls).toEqual([[items[0]?.id]]);
  });
});
