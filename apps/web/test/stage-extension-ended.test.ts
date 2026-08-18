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
import type { MediaRef, Member } from '@gather/contracts';

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

  async function mountDriven(role: Member['role']): Promise<ReturnType<typeof vi.fn>> {
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
    const setTrack = vi.fn();
    connection.syncSetTrackByQueue = setTrack as unknown as typeof connection.syncSetTrackByQueue;
    return setTrack;
  }

  it('the stage subscribes at all — nothing was listening before', async () => {
    await mountDriven('host');
    expect(bridge.listeners.size).toBeGreaterThan(0);
  });

  it('advances the queue when the extension says the item ended', async () => {
    const setTrack = await mountDriven('host');

    await act(async () => {
      bridge.emit(endedFor(PLAYING_KEY));
    });

    expect(setTrack.mock.calls).toEqual([[1]]);
  });

  it('advances exactly once — the extension does not de-duplicate, so we must', async () => {
    // apps/extension/src/background.ts says so out loud: its content script
    // makes one judgement per item and the worker adds no second opinion. If a
    // repeat reaches the room twice, the room skips an item nobody skipped.
    const setTrack = await mountDriven('host');

    await act(async () => {
      bridge.emit(endedFor(PLAYING_KEY));
      bridge.emit(endedFor(PLAYING_KEY));
      bridge.emit(endedFor(PLAYING_KEY));
    });

    expect(setTrack.mock.calls).toEqual([[1]]);
  });

  it('ignores a late end for an item the room has already left', async () => {
    const setTrack = await mountDriven('host');

    await act(async () => {
      bridge.emit(endedFor('page:https://example.com/watch/something-else'));
    });

    expect(setTrack.mock.calls).toEqual([]);
  });

  it('ignores an end that names no item', async () => {
    // The extension sends null when its own room had no ref. Null matches
    // nothing on any stage, and must never be read as "the current one".
    const setTrack = await mountDriven('host');

    await act(async () => {
      bridge.emit(endedFor(null));
    });

    expect(setTrack.mock.calls).toEqual([]);
  });

  it('still advances from the designated client only', async () => {
    // Same rule as the local-player path: elastic sync means N viewers reach
    // the end at N different moments, and only one client may hand the room on.
    const setTrack = await mountDriven('member');

    await act(async () => {
      bridge.emit(endedFor(PLAYING_KEY));
    });

    expect(setTrack.mock.calls).toEqual([]);
  });
});
