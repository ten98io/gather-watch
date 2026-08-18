import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaRef } from '@gather/contracts';

import {
  DEFAULT_DETECT_TIMEOUT_MS,
  PROTOCOL_CHANNEL,
  PROTOCOL_VERSION,
  buildAnnounceRequest,
  buildRequest,
  configureExtensionBridge,
  detectExtension,
  eventPortName,
  extensionMediaKey,
  handoffRoom,
  isExtensionChannelSupported,
  isExtensionId,
  negotiateVersion,
  onEnded,
  onTelemetry,
  parseExtensionIds,
  queryCapability,
  readAnnounce,
  readEvent,
  readResponse,
  resetExtensionBridge,
  stopDriving,
} from '@/lib/extension-bridge';
import type { EndedPayload, TelemetryPayload } from '@/lib/extension-bridge';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'; // 32 chars, a–p

/* ───────────────────────────── pure protocol ─────────────────────────── */

describe('protocol encode/decode', () => {
  it('builds a versioned envelope', () => {
    const msg = buildRequest('r1', 'handoff', { roomId: 'x' });
    expect(msg.channel).toBe(PROTOCOL_CHANNEL);
    expect(msg.v).toBe(PROTOCOL_VERSION);
    expect(msg.id).toBe('r1');
    expect(msg.type).toBe('handoff');
  });

  it('round-trips an ok response', () => {
    const res = readResponse({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      id: 'r1',
      ok: true,
      type: 'status',
      payload: { connected: true },
    });
    expect(res?.ok).toBe(true);
    if (res?.ok === true) expect(res.payload).toEqual({ connected: true });
  });

  it('round-trips an error response with its supported range', () => {
    const res = readResponse({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      id: 'r1',
      ok: false,
      type: 'error',
      error: { code: 'UNSUPPORTED_VERSION', message: 'no', supported: { min: 1, max: 1 } },
    });
    expect(res?.ok).toBe(false);
    if (res?.ok === false) {
      expect(res.error.code).toBe('UNSUPPORTED_VERSION');
      expect(res.error.supported).toEqual({ min: 1, max: 1 });
    }
  });

  it('ignores foreign or malformed messages instead of throwing', () => {
    for (const raw of [
      null,
      undefined,
      'pong',
      42,
      [],
      { channel: 'other.lib', id: 'r1', ok: true },
      { channel: PROTOCOL_CHANNEL, id: '', ok: true },
      { channel: PROTOCOL_CHANNEL, id: 'r1' },
    ]) {
      expect(readResponse(raw)).toBeNull();
    }
    expect(readEvent({ channel: PROTOCOL_CHANNEL, event: 'not-a-thing' })).toBeNull();
    expect(readEvent({ channel: 'other', event: 'telemetry' })).toBeNull();
    expect(readEvent(null)).toBeNull();
  });

  it('reads a telemetry event', () => {
    const ev = readEvent({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      event: 'telemetry',
      payload: { positionMs: 5 },
    });
    expect(ev?.event).toBe('telemetry');
  });

  // The extension has shipped this event since its MediaEndDetector landed
  // (apps/extension/src/protocol.ts lists 'ended' in ProtocolEventType, in
  // readEvent and in EXTENSION_CAPABILITIES). It died HERE: this reader's
  // allowlist did not name it, so an extension-driven room heard the end of
  // every item as a foreign message and never advanced.
  it('reads an ended event — the extension has always sent one', () => {
    const ev = readEvent({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      event: 'ended',
      payload: { positionMs: 5, durationMs: 5, mediaKey: 'youtube:abc', at: 1 },
    });
    expect(ev?.event).toBe('ended');
  });
});

/**
 * `EndedPayload.mediaKey` is produced by `mediaKeyOf` in
 * apps/extension/src/driver.ts. These cases are that function's output, spelled
 * out — if the extension ever changes the format, this is the file that has to
 * change with it, and this is the test that will say so.
 */
describe('extensionMediaKey (mirrors the extension driver)', () => {
  const cases: Array<[string, MediaRef, string]> = [
    [
      'hls',
      { kind: 'hls', assetId: 'as_1', url: 'https://cdn.example/a.m3u8' } as unknown as MediaRef,
      'hls:as_1',
    ],
    ['youtube', { kind: 'youtube', videoId: 'dQw4w9WgXcQ' }, 'youtube:dQw4w9WgXcQ'],
    ['vimeo', { kind: 'vimeo', videoId: '76979871' }, 'vimeo:76979871'],
    [
      'soundcloud',
      { kind: 'soundcloud', url: 'https://soundcloud.com/a/b' },
      'soundcloud:https://soundcloud.com/a/b',
    ],
    [
      'url',
      { kind: 'url', url: 'https://cdn.example/a.mp4', mime: 'video/mp4' },
      'url:https://cdn.example/a.mp4',
    ],
    [
      'embed',
      {
        kind: 'embed',
        provider: 'spotify',
        embedUrl: 'https://open.spotify.com/embed/track/1',
        title: null,
      },
      'embed:spotify:https://open.spotify.com/embed/track/1',
    ],
    ['page', { kind: 'page', url: 'https://example.com/watch' }, 'page:https://example.com/watch'],
  ];

  for (const [name, ref, key] of cases) {
    it(`keys a ${name} ref as the extension does`, () => {
      expect(extensionMediaKey(ref)).toBe(key);
    });
  }

  it('answers null for no media — which matches no item on any stage', () => {
    expect(extensionMediaKey(null)).toBeNull();
  });

  it('ignores the playback epoch entirely', () => {
    // The whole point: lib/player/adapter.ts's mediaKey appends `seq`, which
    // every play/pause/seek mints afresh. This one names the ITEM.
    const ref: MediaRef = { kind: 'youtube', videoId: 'abc' };
    expect(extensionMediaKey(ref)).toBe('youtube:abc');
    expect(extensionMediaKey(ref)).not.toContain(':0');
  });
});

describe('version negotiation', () => {
  it('picks the highest version both sides speak', () => {
    expect(negotiateVersion({ protocolVersion: 1, minProtocolVersion: 1 }, { min: 1, max: 3 })).toBe(1);
    expect(negotiateVersion({ protocolVersion: 5, minProtocolVersion: 1 }, { min: 1, max: 3 })).toBe(3);
    expect(negotiateVersion({ protocolVersion: 3, minProtocolVersion: 2 }, { min: 1, max: 3 })).toBe(3);
  });

  it('returns null when the ranges do not overlap', () => {
    expect(negotiateVersion({ protocolVersion: 9, minProtocolVersion: 7 }, { min: 1, max: 3 })).toBeNull();
    expect(negotiateVersion({ protocolVersion: 1, minProtocolVersion: 1 }, { min: 2, max: 3 })).toBeNull();
  });
});

describe('extension id parsing', () => {
  it('accepts only real Chrome extension ids', () => {
    expect(isExtensionId(EXT_ID)).toBe(true);
    expect(isExtensionId('too-short')).toBe(false);
    expect(isExtensionId('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false); // q–z invalid
    expect(isExtensionId(`${EXT_ID}x`)).toBe(false);
  });

  it('parses a comma-separated list and drops junk', () => {
    expect(parseExtensionIds(`${EXT_ID}, nonsense ,${EXT_ID}`)).toEqual([EXT_ID]);
    expect(parseExtensionIds(undefined)).toEqual([]);
    expect(parseExtensionIds('')).toEqual([]);
  });

  it('reads a well-formed announcement and rejects a spoofed id', () => {
    const good = readAnnounce({
      channel: PROTOCOL_CHANNEL,
      event: 'announce',
      payload: {
        extensionId: EXT_ID,
        extensionVersion: '0.1.0',
        protocolVersion: 1,
        minProtocolVersion: 1,
      },
    });
    expect(good?.extensionId).toBe(EXT_ID);
    expect(
      readAnnounce({
        channel: PROTOCOL_CHANNEL,
        event: 'announce',
        payload: { extensionId: '../../evil', protocolVersion: 1, minProtocolVersion: 1 },
      }),
    ).toBeNull();
    expect(readAnnounce({ channel: 'other', event: 'announce', payload: {} })).toBeNull();
  });

  it('builds an announce request the content script can recognise', () => {
    expect(buildAnnounceRequest()['channel']).toBe(PROTOCOL_CHANNEL);
    expect(buildAnnounceRequest()['event']).toBe('announce.request');
  });
});

/* ───────────────────────────── SSR safety ────────────────────────────── */

describe('SSR safety (no window)', () => {
  it('reports no channel and never touches window', () => {
    expect(typeof window).toBe('undefined');
    expect(isExtensionChannelSupported()).toBe(false);
  });

  it('detects "not installed" without hanging', async () => {
    resetExtensionBridge();
    await expect(detectExtension()).resolves.toEqual({ installed: false });
  });

  it('returns a NOT_INSTALLED result rather than throwing', async () => {
    resetExtensionBridge();
    const res = await handoffRoom({
      roomId: 'room_1',
      accessToken: 'token',
      apiOrigin: 'http://localhost:4000',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NOT_INSTALLED');
  });

  it('onTelemetry is a no-op that still returns an unsubscribe', () => {
    const off = onTelemetry(() => undefined);
    expect(typeof off).toBe('function');
    off();
  });
});

/* ─────────────────────── browser-ish, with a fake chrome ─────────────── */

interface FakePort {
  postMessage: (m: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (cb: (m: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
  emit: (m: unknown) => void;
  kill: () => void;
  name: string;
}

interface FakeChrome {
  runtime: {
    sendMessage: (id: string, msg: unknown, cb: (r?: unknown) => void) => void;
    connect: (id: string, info: { name: string }) => FakePort;
    lastError?: { message?: string } | undefined;
  };
}

type Responder = (id: string, msg: Record<string, unknown>) => unknown | 'silent' | 'error';

function installFakeWindow(responder: Responder): { chrome: FakeChrome; ports: FakePort[] } {
  const ports: FakePort[] = [];
  const listeners = new Set<(ev: unknown) => void>();

  const chrome: FakeChrome = {
    runtime: {
      sendMessage: (id, msg, cb) => {
        const result = responder(id, msg as Record<string, unknown>);
        if (result === 'silent') return; // callback never fires
        setTimeout(() => {
          chrome.runtime.lastError = result === 'error' ? { message: 'no receiving end' } : undefined;
          cb(result === 'error' ? undefined : result);
          chrome.runtime.lastError = undefined;
        }, 0);
      },
      connect: (_id, info) => {
        let onMessage: ((m: unknown) => void) | null = null;
        let onDisconnect: (() => void) | null = null;
        const port: FakePort = {
          name: info.name,
          postMessage: () => undefined,
          disconnect: () => undefined,
          onMessage: {
            addListener: (cb) => {
              onMessage = cb;
            },
          },
          onDisconnect: {
            addListener: (cb) => {
              onDisconnect = cb;
            },
          },
          emit: (m) => onMessage?.(m),
          kill: () => onDisconnect?.(),
        };
        ports.push(port);
        return port;
      },
    },
  };

  const fakeWindow = {
    chrome,
    location: { origin: 'http://localhost:3000' },
    addEventListener: (type: string, cb: (ev: unknown) => void) => {
      if (type === 'message') listeners.add(cb);
    },
    removeEventListener: (type: string, cb: (ev: unknown) => void) => {
      if (type === 'message') listeners.delete(cb);
    },
    postMessage: (data: unknown) => {
      // Nothing announces by default; tests that need it dispatch manually.
      void data;
    },
  };
  (globalThis as unknown as { window?: unknown }).window = fakeWindow;
  return { chrome, ports };
}

function removeFakeWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

const helloResponse = (msg: Record<string, unknown>): unknown => ({
  channel: PROTOCOL_CHANNEL,
  v: 1,
  id: msg['id'],
  ok: true,
  type: 'hello',
  payload: {
    extensionVersion: '0.1.0',
    protocolVersion: 1,
    minProtocolVersion: 1,
    capabilities: ['handoff', 'telemetry'],
  },
});

describe('detectExtension (fake chrome)', () => {
  beforeEach(() => {
    resetExtensionBridge();
    vi.useRealTimers();
  });

  afterEach(() => {
    removeFakeWindow();
    resetExtensionBridge();
    configureExtensionBridge({ extensionIds: [] });
  });

  it('finds a configured extension and reports its version', async () => {
    installFakeWindow((_id, msg) => (msg['type'] === 'hello' ? helloResponse(msg) : null));
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const info = await detectExtension();
    expect(info).toMatchObject({
      installed: true,
      version: '0.1.0',
      protocolVersion: 1,
      compatible: true,
      extensionId: EXT_ID,
    });
    expect(info.capabilities).toContain('handoff');
  });

  it('degrades to "not installed" fast when nothing answers — never hangs', async () => {
    installFakeWindow(() => 'silent');
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const started = Date.now();
    const info = await detectExtension({ timeoutMs: 50 });
    expect(info).toEqual({ installed: false });
    expect(Date.now() - started).toBeLessThan(DEFAULT_DETECT_TIMEOUT_MS);
  });

  it('degrades when the browser reports no receiving end', async () => {
    installFakeWindow(() => 'error');
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    await expect(detectExtension({ timeoutMs: 100 })).resolves.toEqual({ installed: false });
  });

  it('marks an extension whose protocol range does not overlap as incompatible', async () => {
    installFakeWindow((_id, msg) => ({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      id: msg['id'],
      ok: true,
      type: 'hello',
      payload: {
        extensionVersion: '9.0.0',
        protocolVersion: 9,
        minProtocolVersion: 8,
        capabilities: [],
      },
    }));
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const info = await detectExtension({ timeoutMs: 100 });
    expect(info.installed).toBe(true);
    expect(info.compatible).toBe(false);

    const res = await stopDriving();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNSUPPORTED_VERSION');
  });

  it('ignores a response that is not ours', async () => {
    installFakeWindow(() => ({ channel: 'some.other.lib', id: 'x', ok: true }));
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    await expect(detectExtension({ timeoutMs: 100 })).resolves.toEqual({ installed: false });
  });
});

describe('requests (fake chrome)', () => {
  beforeEach(() => {
    resetExtensionBridge();
  });

  afterEach(() => {
    removeFakeWindow();
    resetExtensionBridge();
    configureExtensionBridge({ extensionIds: [] });
  });

  it('sends a handoff and returns the session status', async () => {
    const sent: Array<Record<string, unknown>> = [];
    installFakeWindow((_id, msg) => {
      sent.push(msg);
      if (msg['type'] === 'hello') return helloResponse(msg);
      return {
        channel: PROTOCOL_CHANNEL,
        v: 1,
        id: msg['id'],
        ok: true,
        type: msg['type'],
        payload: {
          connected: true,
          roomId: 'room_1',
          roomName: 'Friday',
          driving: false,
          provider: null,
          hasMedia: false,
        },
      };
    });
    configureExtensionBridge({ extensionIds: [EXT_ID] });

    const res = await handoffRoom({
      roomId: 'room_1',
      roomName: 'Friday',
      accessToken: 'tok_abc',
      apiOrigin: 'http://localhost:4000',
      intent: {
        providerId: 'netflix',
        contentUrl: 'https://www.netflix.com/watch/1',
        positionMs: 0,
        rate: 1,
        playing: false,
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.roomId).toBe('room_1');

    const handoff = sent.find((m) => m['type'] === 'handoff');
    expect(handoff).toBeDefined();
    const payload = handoff?.['payload'] as Record<string, unknown>;
    expect(payload['apiOrigin']).toBe('http://localhost:4000');
    expect(payload['target']).toBe('auto');
    expect(payload['accessToken']).toBe('tok_abc');
  });

  it('surfaces an extension-side refusal as a typed error, not a throw', async () => {
    installFakeWindow((_id, msg) => {
      if (msg['type'] === 'hello') return helloResponse(msg);
      return {
        channel: PROTOCOL_CHANNEL,
        v: 1,
        id: msg['id'],
        ok: false,
        type: 'error',
        error: { code: 'API_ORIGIN_MISMATCH', message: 'different API origin', supported: null },
      };
    });
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const res = await handoffRoom({
      roomId: 'room_1',
      accessToken: 'tok',
      apiOrigin: 'https://evil.example',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('API_ORIGIN_MISMATCH');
  });

  it('reports NO_RESPONSE when the extension goes quiet mid-session', async () => {
    installFakeWindow((_id, msg) => (msg['type'] === 'hello' ? helloResponse(msg) : 'silent'));
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    await detectExtension();
    const res = await queryCapability({ timeoutMs: 50 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NO_RESPONSE');
  });
});

describe('telemetry stream (fake chrome)', () => {
  afterEach(() => {
    removeFakeWindow();
    resetExtensionBridge();
    configureExtensionBridge({ extensionIds: [] });
  });

  it('opens a versioned port and forwards telemetry, ignoring unknown events', async () => {
    resetExtensionBridge();
    const { ports } = installFakeWindow((_id, msg) =>
      msg['type'] === 'hello' ? helloResponse(msg) : null,
    );
    configureExtensionBridge({ extensionIds: [EXT_ID] });

    const seen: TelemetryPayload[] = [];
    const off = onTelemetry((t) => seen.push(t));
    await detectExtension();
    await new Promise((r) => setTimeout(r, 10));

    expect(ports).toHaveLength(1);
    expect(ports[0]?.name).toBe(eventPortName());

    ports[0]?.emit({ channel: 'some.other.lib', event: 'telemetry', payload: {} });
    ports[0]?.emit({ channel: PROTOCOL_CHANNEL, v: 1, event: 'not-a-thing', payload: {} });
    ports[0]?.emit({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      event: 'telemetry',
      payload: { positionMs: 1234, durationMs: 5000, playing: true, rate: 1, at: 42 },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.positionMs).toBe(1234);
    expect(seen[0]?.playing).toBe(true);
    off();
  });
});

/**
 * THE END OF AN ITEM, crossing from the extension to the page.
 *
 * The extension half has always shipped: content.ts posts `mediaEnded`,
 * background.ts broadcasts an `ended` port event carrying the `mediaKey` of
 * whatever the room was on. This side had no 'ended' in its event union, no arm
 * in handleEvent and no `onEnded` at all, so the message was dropped at the
 * boundary and an extension-driven room stopped dead after one item.
 */
describe('ended stream (fake chrome)', () => {
  afterEach(() => {
    removeFakeWindow();
    resetExtensionBridge();
    configureExtensionBridge({ extensionIds: [] });
  });

  /** Opens the shared port with an `ended` subscriber attached. */
  async function withEndedPort(): Promise<{ ports: FakePort[]; seen: EndedPayload[]; off: () => void }> {
    resetExtensionBridge();
    const { ports } = installFakeWindow((_id, msg) =>
      msg['type'] === 'hello' ? helloResponse(msg) : null,
    );
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const seen: EndedPayload[] = [];
    const off = onEnded((e) => seen.push(e));
    await detectExtension();
    await new Promise((r) => setTimeout(r, 10));
    return { ports, seen, off };
  }

  it('opens the port for an ended subscriber alone and forwards the payload', async () => {
    const { ports, seen, off } = await withEndedPort();

    // An `ended` listener is a listener: it must keep the port open by itself,
    // with no telemetry subscriber propping it up.
    expect(ports).toHaveLength(1);

    ports[0]?.emit({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      event: 'ended',
      payload: { positionMs: 59_000, durationMs: 60_000, mediaKey: 'youtube:abc', at: 42 },
    });

    expect(seen).toEqual([
      { positionMs: 59_000, durationMs: 60_000, mediaKey: 'youtube:abc', at: 42 },
    ]);
    off();
  });

  it('normalises a payload with junk fields instead of trusting it', async () => {
    const { ports, seen, off } = await withEndedPort();

    ports[0]?.emit({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      event: 'ended',
      payload: { positionMs: 'soon', durationMs: null, mediaKey: 7, at: 'now' },
    });

    // A mediaKey that is not a usable string becomes null, which can never
    // match an item on the stage — the safe direction: ignore, not skip.
    expect(seen[0]?.mediaKey).toBeNull();
    expect(seen[0]?.positionMs).toBe(0);
    expect(seen[0]?.durationMs).toBe(0);
    expect(typeof seen[0]?.at).toBe('number');
    off();
  });

  it('does not fire for a foreign or unknown event on the same port', async () => {
    const { ports, seen, off } = await withEndedPort();
    ports[0]?.emit({ channel: 'some.other.lib', event: 'ended', payload: { mediaKey: 'x' } });
    ports[0]?.emit({ channel: PROTOCOL_CHANNEL, v: 1, event: 'finished', payload: {} });
    expect(seen).toEqual([]);
    off();
  });
});
