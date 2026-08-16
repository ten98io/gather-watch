import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { API_ORIGIN, WEB_ORIGINS } from '../src/config';
import {
  EventPortRegistry,
  MAX_EVENT_PORTS,
  ProtocolFault,
  isAllowedOrigin,
  runScreenedRequest,
  screenEventPort,
  screenExternal,
  senderOrigin,
} from '../src/external';
import type { EventPortLike, ExternalHost, ScreenResult, TrustedSender } from '../src/external';
import {
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  buildRequest,
  eventMessage,
  eventPortName,
} from '../src/protocol';

const ALLOWED = 'http://localhost:3000';

const senderFrom = (origin: string, tabId?: number): TrustedSender => ({
  origin,
  url: `${origin}/room/abc`,
  ...(tabId === undefined ? {} : { tab: { id: tabId } }),
});

const handoffPayload = {
  roomId: 'room_1',
  roomName: 'Friday',
  accessToken: 'eyJhbGciOiJIUzI1NiJ9.body.sig',
  apiOrigin: API_ORIGIN,
  intent: null,
  target: 'auto',
};

function makeHost(): ExternalHost & { calls: string[] } {
  const calls: string[] = [];
  const status = {
    connected: true,
    roomId: 'room_1',
    roomName: 'Friday',
    driving: true,
    provider: null,
    hasMedia: true,
  };
  return {
    calls,
    hello: () => {
      calls.push('hello');
      return {
        extensionVersion: '0.1.0',
        protocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: 1,
        capabilities: ['handoff'],
      };
    },
    status: () => {
      calls.push('status');
      return status;
    },
    capability: async () => {
      calls.push('capability');
      return { hasMedia: true, targetKnown: true, canDrive: true, provider: null };
    },
    handoff: async (input) => {
      calls.push(`handoff:${input.roomId}:${input.target}:${String(input.senderTabId)}`);
      return status;
    },
    intent: async () => {
      calls.push('intent');
      return status;
    },
    release: async () => {
      calls.push('release');
      return status;
    },
  };
}

/* ── ORIGIN VALIDATION — the point of the whole module ── */

describe('origin allowlist', () => {
  it('accepts exactly the configured origins', () => {
    for (const origin of WEB_ORIGINS) expect(isAllowedOrigin(origin)).toBe(true);
  });

  it('rejects everything else — no suffix, prefix or subdomain matching', () => {
    for (const origin of [
      'https://evil.example',
      'https://playin.app.evil.example',
      'https://evilplayin.app',
      'https://playin.app.co',
      'https://staging.playin.app',
      'http://playin.app',
      'https://playin.app:8443',
      'http://localhost:3001',
      'http://localhost',
      'file://',
      'null',
      '',
    ]) {
      expect(isAllowedOrigin(origin), origin).toBe(false);
    }
    expect(isAllowedOrigin(null)).toBe(false);
  });

  it('derives the origin from browser-populated fields only', () => {
    expect(senderOrigin({ origin: 'https://playin.app' })).toBe('https://playin.app');
    expect(senderOrigin({ url: 'https://playin.app/room/x' })).toBe('https://playin.app');
    // Opaque origin (sandboxed iframe) → no origin → not allowed.
    expect(senderOrigin({ origin: 'null', url: 'about:blank' })).toBeNull();
    expect(senderOrigin({})).toBeNull();
  });
});

describe('screenExternal — a disallowed origin is rejected', () => {
  const request = buildRequest('r1', 'handoff', handoffPayload);

  it('refuses a handoff from a hostile origin, silently, before any handler runs', async () => {
    const host = makeHost();
    for (const origin of [
      'https://evil.example',
      'https://staging.playin.app',
      'http://localhost:8080',
      'https://playin.app.evil.example',
    ]) {
      const screened = screenExternal(request, senderFrom(origin, 7));
      expect(screened.action, origin).toBe('reject');
      if (screened.action !== 'reject') throw new Error('expected reject');
      expect(screened.reason).toBe('forbidden-origin');
      // Silence: a non-allowlisted page must not even learn we are installed.
      expect(screened.response).toBeNull();
    }
    expect(host.calls).toEqual([]);
  });

  it('ignores a payload that lies about its own origin', () => {
    const lying = {
      ...buildRequest('r1', 'handoff', handoffPayload),
      origin: ALLOWED,
      sender: { origin: ALLOWED },
    };
    const screened = screenExternal(lying, senderFrom('https://evil.example'));
    expect(screened.action).toBe('reject');
  });

  it('accepts the same request from an allowlisted origin', () => {
    const screened = screenExternal(request, senderFrom(ALLOWED, 7));
    expect(screened.action).toBe('handle');
  });

  it('re-checks the origin on every message, not once per page', () => {
    // Same id, same payload: allowed then hostile → allowed then refused.
    expect(screenExternal(request, senderFrom(ALLOWED, 7)).action).toBe('handle');
    expect(screenExternal(request, senderFrom('https://evil.example', 7)).action).toBe('reject');
  });
});

/* ── screening: envelope, version, payload, policy ── */

describe('screenExternal', () => {
  it('ignores non-Playin messages without answering them', () => {
    for (const raw of [null, 'ping', { type: 'redux/INIT' }, { channel: 'other', id: 'r', type: 'x' }]) {
      const screened = screenExternal(raw, senderFrom(ALLOWED));
      expect(screened.action).toBe('ignore');
    }
  });

  it('refuses an unsupported protocol version with the supported range', () => {
    const screened = screenExternal(
      buildRequest('r2', 'hello', {}, PROTOCOL_VERSION + 1),
      senderFrom(ALLOWED),
    );
    expect(screened.action).toBe('reject');
    if (screened.action !== 'reject' || screened.response === null) throw new Error('expected body');
    expect(screened.response.error.code).toBe(ProtocolErrorCode.UnsupportedVersion);
    expect(screened.response.error.supported).toEqual({ min: 1, max: PROTOCOL_VERSION });
    expect(screened.response.id).toBe('r2');
  });

  it('answers an unknown message type with UNSUPPORTED_TYPE and does nothing', async () => {
    const host = makeHost();
    const screened = screenExternal(
      { channel: 'playin.ext', v: 1, id: 'r3', type: 'exec', payload: { cmd: 'rm -rf' } },
      senderFrom(ALLOWED),
    );
    expect(screened.action).toBe('reject');
    if (screened.action !== 'reject' || screened.response === null) throw new Error('expected body');
    expect(screened.response.error.code).toBe(ProtocolErrorCode.UnsupportedType);
    expect(host.calls).toEqual([]);
  });

  it('refuses a handoff whose apiOrigin is not this build’s API origin', () => {
    for (const apiOrigin of [
      'https://evil.example',
      'http://localhost:4001',
      'https://api.playin.app',
      'javascript:alert(1)',
    ]) {
      const screened = screenExternal(
        buildRequest('r4', 'handoff', { ...handoffPayload, apiOrigin }),
        senderFrom(ALLOWED),
      );
      expect(screened.action, apiOrigin).toBe('reject');
      if (screened.action !== 'reject') throw new Error('expected reject');
      expect(['api-origin-mismatch', ProtocolErrorCode.BadRequest]).toContain(screened.reason);
    }
  });

  it('accepts the configured API origin in any equivalent spelling', () => {
    const screened = screenExternal(
      buildRequest('r5', 'handoff', { ...handoffPayload, apiOrigin: `${API_ORIGIN}/` }),
      senderFrom(ALLOWED),
    );
    expect(screened.action).toBe('handle');
  });

  it('takes the tab id from the browser, never from the page', async () => {
    const host = makeHost();
    const screened = screenExternal(
      buildRequest('r6', 'handoff', { ...handoffPayload, target: 'sender', tabId: 999 }),
      senderFrom(ALLOWED, 42),
    );
    if (screened.action !== 'handle') throw new Error('expected handle');
    await runScreenedRequest(screened, host);
    expect(host.calls).toEqual(['handoff:room_1:sender:42']);
  });
});

/* ── dispatch ── */

describe('runScreenedRequest', () => {
  const handle = (raw: unknown): Extract<ScreenResult, { action: 'handle' }> => {
    const screened = screenExternal(raw, senderFrom(ALLOWED, 5));
    if (screened.action !== 'handle') throw new Error('expected handle');
    return screened;
  };

  it('routes each request type to its host method', async () => {
    const host = makeHost();
    await runScreenedRequest(handle(buildRequest('a', 'hello', {})), host);
    await runScreenedRequest(handle(buildRequest('b', 'status', {})), host);
    await runScreenedRequest(handle(buildRequest('c', 'capability', {})), host);
    await runScreenedRequest(handle(buildRequest('d', 'release', {})), host);
    await runScreenedRequest(
      handle(
        buildRequest('e', 'intent', {
          intent: { providerId: null, contentUrl: null, positionMs: 0, rate: 1, playing: false },
        }),
      ),
      host,
    );
    expect(host.calls).toEqual(['hello', 'status', 'capability', 'release', 'intent']);
  });

  it('carries a ProtocolFault code out to the caller', async () => {
    const host = makeHost();
    host.intent = async () => {
      throw new ProtocolFault(ProtocolErrorCode.NotConnected, 'no room yet');
    };
    const screened = handle(
      buildRequest('g', 'intent', {
        intent: { providerId: null, contentUrl: null, positionMs: 0, rate: 1, playing: false },
      }),
    );
    await expect(runScreenedRequest(screened, host)).rejects.toMatchObject({
      code: ProtocolErrorCode.NotConnected,
    });
  });

  it('never leaks the access token back to the page', async () => {
    const host = makeHost();
    const payload = await runScreenedRequest(handle(buildRequest('f', 'handoff', handoffPayload)), host);
    expect(JSON.stringify(payload)).not.toContain(handoffPayload.accessToken);
  });
});

/* ── ports ── */

describe('screenEventPort', () => {
  it('accepts the versioned port name from an allowed origin', () => {
    expect(screenEventPort(eventPortName(), senderFrom(ALLOWED))).toEqual({
      ok: true,
      v: PROTOCOL_VERSION,
    });
  });

  it('rejects a port from a disallowed origin, silently', () => {
    const res = screenEventPort(eventPortName(), senderFrom('https://evil.example'));
    expect(res).toEqual({ ok: false, reason: 'forbidden-origin', silent: true });
  });

  it('ignores foreign port names', () => {
    expect(screenEventPort('devtools-page', senderFrom(ALLOWED)).ok).toBe(false);
  });

  it('refuses an unsupported port version audibly (so the page can downgrade)', () => {
    const res = screenEventPort(`playin.ext.events.v${PROTOCOL_VERSION + 1}`, senderFrom(ALLOWED));
    expect(res).toEqual({ ok: false, reason: 'unsupported-version', silent: false });
  });
});

describe('EventPortRegistry', () => {
  const makePort = (name = eventPortName()): EventPortLike & { sent: unknown[] } => {
    const sent: unknown[] = [];
    return {
      name,
      sent,
      postMessage: (m: unknown) => {
        sent.push(m);
      },
      disconnect: vi.fn(),
      onDisconnect: { addListener: () => undefined },
    };
  };

  it('broadcasts to every live port', () => {
    const registry = new EventPortRegistry();
    const a = makePort();
    const b = makePort();
    registry.add(a, 1);
    registry.add(b, 1);
    registry.broadcast((v) => eventMessage('telemetry', { positionMs: 1 }, v));
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('drops a port that throws instead of retrying it forever', () => {
    const registry = new EventPortRegistry();
    const dead = makePort();
    dead.postMessage = () => {
      throw new Error('port closed');
    };
    registry.add(dead, 1);
    registry.broadcast((v) => eventMessage('status', null, v));
    expect(registry.size).toBe(0);
  });

  it('is bounded — a page that leaks connects cannot grow it', () => {
    const registry = new EventPortRegistry();
    for (let i = 0; i < MAX_EVENT_PORTS + 5; i += 1) registry.add(makePort(), 1);
    expect(registry.size).toBe(MAX_EVENT_PORTS);
  });
});

/* ── manifest ↔ code allowlist ── */

describe('manifest externally_connectable', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../public/manifest.json', import.meta.url)), 'utf8'),
  ) as { externally_connectable: { matches: string[] } };

  it('has no host wildcard (a hijacked subdomain must not reach the extension)', () => {
    for (const pattern of manifest.externally_connectable.matches) {
      const host = pattern.replace(/^[a-z*]+:\/\//, '').replace(/\/.*$/, '');
      expect(host, pattern).not.toContain('*');
      expect(pattern.startsWith('*://'), pattern).toBe(false);
    }
  });

  it('every browser-gated origin is also accepted by the in-code allowlist', () => {
    for (const pattern of manifest.externally_connectable.matches) {
      const origin = pattern.replace(/\/\*$/, '');
      expect(isAllowedOrigin(origin), pattern).toBe(true);
    }
  });

  it('pins the dev origin to a port (any local server must not qualify)', () => {
    for (const pattern of manifest.externally_connectable.matches) {
      if (pattern.includes('localhost') || pattern.includes('127.0.0.1')) {
        expect(pattern, pattern).toMatch(/:\d+\/\*$/);
      }
    }
  });
});
