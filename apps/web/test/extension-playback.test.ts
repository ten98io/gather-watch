// @vitest-environment jsdom
/**
 * THE TRANSPORT THE EXTENSION WAS ALREADY FEEDING, AND NOBODY WAS EATING.
 *
 * `lib/extension-bridge.ts` has decoded a telemetry stream — position, length,
 * playing, rate, captured-at — since the channel shipped, and handed it to
 * `onTelemetry`. `onTelemetry` had no production caller. Same for
 * `onCapability`, which carries the driven tab's provider as it changes (an SPA
 * navigation, a tab switch).
 *
 * While the extension drives, this page builds NO adapter at all — StagePane
 * nulls the adapter kind so two players never fight over one room — so every
 * number the transport bar normally reads off a `PlayerAdapter` had no source.
 * The result: a frozen elapsed counter, 00:00 for the length, and a scrubber
 * that could not move, on a room where the real numbers were arriving once a
 * second the whole time.
 *
 * These cases pin the store the components read, and the two pure helpers that
 * turn a 1 Hz sample into something a UI can render honestly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXTENSION_TELEMETRY_STALE_MS,
  NO_EXTENSION_PLAYBACK,
  createExtensionPlaybackStore,
  drivenCapability,
  drivenIsDrm,
  extensionPositionMs,
  extensionTelemetryLive,
} from '@/lib/player/extension-driver';
import type { ExtensionPlayback, ExtensionPlaybackStore } from '@/lib/player/extension-driver';
import {
  PROTOCOL_CHANNEL,
  configureExtensionBridge,
  eventPortName,
  resetExtensionBridge,
} from '@/lib/extension-bridge';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

interface FakePort {
  postMessage: (m: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (cb: (m: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
  emit: (m: unknown) => void;
  name: string;
}

/** The extension answers `hello` and hands out event ports — the minimum the
 *  bridge needs before it will open one. */
function installFakeChrome(): { ports: FakePort[] } {
  const ports: FakePort[] = [];
  const chrome = {
    runtime: {
      sendMessage: (_id: string, msg: Record<string, unknown>, cb: (r?: unknown) => void) => {
        setTimeout(() => {
          cb(
            msg['type'] === 'hello'
              ? {
                  channel: PROTOCOL_CHANNEL,
                  v: 1,
                  id: msg['id'],
                  ok: true,
                  type: 'hello',
                  payload: {
                    extensionVersion: '0.1.0',
                    protocolVersion: 1,
                    minProtocolVersion: 1,
                    capabilities: ['handoff', 'telemetry', 'capability'],
                  },
                }
              : undefined,
          );
        }, 0);
      },
      connect: (_id: string, info: { name: string }) => {
        let onMessage: ((m: unknown) => void) | null = null;
        const port: FakePort = {
          name: info.name,
          postMessage: () => undefined,
          disconnect: () => undefined,
          onMessage: {
            addListener: (cb) => {
              onMessage = cb;
            },
          },
          onDisconnect: { addListener: () => undefined },
          emit: (m) => onMessage?.(m),
        };
        ports.push(port);
        return port;
      },
    },
  };
  (window as unknown as { chrome: unknown }).chrome = chrome;
  return { ports };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

const telemetry = (payload: Record<string, unknown>): unknown => ({
  channel: PROTOCOL_CHANNEL,
  v: 1,
  event: 'telemetry',
  payload,
});

describe('what a component can read while the extension drives', () => {
  let store: ExtensionPlaybackStore | null = null;
  let ports: FakePort[] = [];

  beforeEach(() => {
    resetExtensionBridge();
    ports = installFakeChrome().ports;
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    store = createExtensionPlaybackStore();
  });

  afterEach(() => {
    store?.dispose();
    store = null;
    delete (window as unknown as { chrome?: unknown }).chrome;
    resetExtensionBridge();
    configureExtensionBridge({ extensionIds: [] });
  });

  /** Subscribes (which is what opens the port) and waits for it. */
  async function live(): Promise<{ seen: ExtensionPlayback[]; off: () => void }> {
    const seen: ExtensionPlayback[] = [];
    const off = (store as ExtensionPlaybackStore).observe((pb) => seen.push(pb));
    await settle();
    return { seen, off };
  }

  it('opens the shared event port for a playback subscriber alone', async () => {
    const { off } = await live();
    expect(ports).toHaveLength(1);
    expect(ports[0]?.name).toBe(eventPortName());
    off();
  });

  it('carries position, length, playing and rate through to the snapshot', async () => {
    const { seen, off } = await live();
    ports[0]?.emit(
      telemetry({ positionMs: 12_000, durationMs: 2_700_000, playing: true, rate: 1, at: 5_000 }),
    );

    expect(seen).toHaveLength(1);
    expect(store?.getSnapshot()).toMatchObject({
      positionMs: 12_000,
      durationMs: 2_700_000,
      playing: true,
      rate: 1,
      updatedAt: 5_000,
    });
    off();
  });

  /**
   * A live stream has no length. The content script already sends 0 rather
   * than Infinity (no JSON channel could carry Infinity intact anyway), and
   * anything else non-finite is read the same way: 0 means NOT KNOWN
   * everywhere in this app, and must never be rendered as a zero-length item.
   */
  it('reads a missing or impossible length as "not known"', async () => {
    const { off } = await live();
    ports[0]?.emit(telemetry({ positionMs: 1_000, durationMs: 0, playing: true, rate: 1, at: 1 }));
    expect(store?.getSnapshot().durationMs).toBe(0);

    ports[0]?.emit(telemetry({ positionMs: 1_000, durationMs: -5, playing: true, rate: 1, at: 2 }));
    expect(store?.getSnapshot().durationMs).toBe(0);
    off();
  });

  it('does not re-publish an identical frame', async () => {
    const { seen, off } = await live();
    const frame = { positionMs: 900, durationMs: 60_000, playing: false, rate: 1, at: 77 };
    ports[0]?.emit(telemetry(frame));
    ports[0]?.emit(telemetry(frame));
    // A paused tab reports the same numbers every second; re-publishing them
    // would re-render every subscriber for no change at all.
    expect(seen).toHaveLength(1);
    off();
  });

  it('answers what the driven source honestly is when the provider changes', async () => {
    const { off } = await live();
    ports[0]?.emit({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      event: 'capability',
      payload: { id: 'netflix', name: 'Netflix', tier: 'drm' },
    });

    const snapshot = store?.getSnapshot();
    expect(snapshot?.provider).toEqual({ id: 'netflix', name: 'Netflix', tier: 'drm' });
    // The honest tier comes from THIS app's registry, keyed by the shared id —
    // never from the wire's legacy 'api' | 'drm' | 'generic' vocabulary.
    expect(snapshot?.capability).toBe('extension');
    expect(snapshot?.drm).toBe(true);
    off();
  });

  it('drops the old tab’s numbers when the driven source changes', async () => {
    const { off } = await live();
    ports[0]?.emit(
      telemetry({ positionMs: 30_000, durationMs: 60_000, playing: true, rate: 1, at: 10 }),
    );
    ports[0]?.emit({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      event: 'capability',
      payload: { id: 'youtube', name: 'YouTube', tier: 'api' },
    });

    // A different source is a different item: holding the last one's position
    // would draw the old scrubber over the new tab until the next frame.
    expect(store?.getSnapshot()).toMatchObject({
      positionMs: 0,
      durationMs: 0,
      playing: false,
      updatedAt: 0,
      capability: 'full-sync',
      drm: false,
    });
    off();
  });

  it('closes the port when its last subscriber leaves', async () => {
    const { off } = await live();
    expect(ports).toHaveLength(1);
    off();
    // Re-subscribing opens a fresh port rather than reusing a dead one.
    const again = (store as ExtensionPlaybackStore).observe(() => undefined);
    await settle();
    expect(ports).toHaveLength(2);
    again();
  });
});

describe('rendering a 1 Hz sample honestly', () => {
  const frame = (over: Partial<ExtensionPlayback> = {}): ExtensionPlayback => ({
    ...NO_EXTENSION_PLAYBACK,
    positionMs: 10_000,
    durationMs: 600_000,
    playing: true,
    rate: 1,
    updatedAt: 1_000,
    ...over,
  });

  it('projects the position forward at the rate it was running', () => {
    // Half a second after the reading was captured, at 2×.
    expect(extensionPositionMs(frame({ rate: 2 }), 1_500)).toBe(11_000);
  });

  it('never projects past the item’s own end', () => {
    expect(extensionPositionMs(frame({ positionMs: 599_500 }), 3_000)).toBe(600_000);
  });

  it('leaves a paused reading exactly where it was', () => {
    expect(extensionPositionMs(frame({ playing: false }), 9_000)).toBe(10_000);
  });

  it('freezes rather than inventing progress once the tab stops reporting', () => {
    const stale = 1_000 + EXTENSION_TELEMETRY_STALE_MS + 1;
    expect(extensionTelemetryLive(frame(), stale)).toBe(false);
    expect(extensionPositionMs(frame(), stale)).toBe(10_000);
  });

  it('is not "live" before any frame has arrived', () => {
    expect(extensionTelemetryLive(NO_EXTENSION_PLAYBACK, 1_000)).toBe(false);
  });
});

describe('the driven source’s honest tier', () => {
  it('is generic for a provider this build has never heard of', () => {
    expect(drivenCapability({ id: 'someservice', name: 'Some Service', tier: 'api' })).toBe(
      'generic',
    );
    expect(drivenCapability(null)).toBe('generic');
    expect(drivenIsDrm(null)).toBe(false);
  });

  it('reads DRM off the wire tier as well as off the registry', () => {
    // The redacted generic summary carries no DRM claim, and the registry has
    // no entry for it — neither says protected, so it is not.
    expect(drivenIsDrm({ id: 'generic', name: 'This page', tier: 'generic' })).toBe(false);
    // A build whose registry does not know the id still honours the wire.
    expect(drivenIsDrm({ id: 'unheard-of', name: 'X', tier: 'drm' })).toBe(true);
    // …and a known extension-tier service is protected whatever the wire said.
    expect(drivenIsDrm({ id: 'disneyplus', name: 'Disney+', tier: 'generic' })).toBe(true);
  });
});
