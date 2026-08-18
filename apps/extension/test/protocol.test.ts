import { describe, expect, it } from 'vitest';
import {
  EXTENSION_CAPABILITIES,
  MAX_TOKEN_LENGTH,
  PROTOCOL_CHANNEL,
  PROTOCOL_MIN_VERSION,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  buildRequest,
  decodeRequest,
  errorResponse,
  eventMessage,
  eventPortName,
  isSafeHttpUrl,
  negotiateVersion,
  okResponse,
  originOf,
  parseEventPortName,
  readEnvelope,
  readEvent,
  readResponse,
  redactProvider,
} from '../src/protocol';
import type { HandoffPayload } from '../src/protocol';

const validHandoff = {
  roomId: 'room_01HZX',
  roomName: 'Friday night',
  accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.sig-part_~+/=',
  apiOrigin: 'http://localhost:4000',
  intent: {
    providerId: 'netflix',
    contentUrl: 'https://www.netflix.com/watch/80100172',
    positionMs: 12_345,
    rate: 1,
    playing: true,
  },
  target: 'auto',
};

/* ── envelope ── */

describe('readEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    const env = readEnvelope(buildRequest('r1', 'hello', { appVersion: '1.2.3' }));
    expect(env).not.toBeNull();
    expect(env?.type).toBe('hello');
    expect(env?.id).toBe('r1');
    expect(env?.v).toBe(PROTOCOL_VERSION);
  });

  it('ignores anything that is not ours (no reply, ever)', () => {
    expect(readEnvelope(null)).toBeNull();
    expect(readEnvelope('hello')).toBeNull();
    expect(readEnvelope([])).toBeNull();
    expect(readEnvelope({ type: 'hello', id: 'r1' })).toBeNull();
    expect(readEnvelope({ channel: 'other.lib', v: 1, id: 'r1', type: 'hello' })).toBeNull();
  });

  it('ignores envelopes whose id could not be correlated back', () => {
    expect(readEnvelope({ channel: PROTOCOL_CHANNEL, v: 1, id: '', type: 'hello' })).toBeNull();
    expect(readEnvelope({ channel: PROTOCOL_CHANNEL, v: 1, id: 'a b', type: 'hello' })).toBeNull();
    expect(
      readEnvelope({ channel: PROTOCOL_CHANNEL, v: 1, id: 'x'.repeat(65), type: 'hello' }),
    ).toBeNull();
    expect(readEnvelope({ channel: PROTOCOL_CHANNEL, v: 1, id: 'r1', type: 7 })).toBeNull();
  });
});

/* ── version negotiation ── */

describe('negotiateVersion', () => {
  it('accepts versions inside the supported range', () => {
    expect(negotiateVersion(PROTOCOL_VERSION)).toBe(PROTOCOL_VERSION);
    expect(negotiateVersion(PROTOCOL_MIN_VERSION)).toBe(PROTOCOL_MIN_VERSION);
  });

  it('refuses a future version rather than guessing its dialect', () => {
    expect(negotiateVersion(PROTOCOL_VERSION + 1)).toBeNull();
  });

  it('refuses versions below the supported floor', () => {
    expect(negotiateVersion(PROTOCOL_MIN_VERSION - 1)).toBeNull();
    expect(negotiateVersion(0)).toBeNull();
  });

  it('refuses non-integer and non-numeric versions', () => {
    expect(negotiateVersion('1')).toBeNull();
    expect(negotiateVersion(1.5)).toBeNull();
    expect(negotiateVersion(undefined)).toBeNull();
    expect(negotiateVersion(Number.NaN)).toBeNull();
  });
});

/* ── decode ── */

describe('decodeRequest', () => {
  it('decodes every known type', () => {
    for (const type of ['hello', 'status', 'capability', 'release'] as const) {
      const decoded = decodeRequest(type, {});
      expect(decoded.ok).toBe(true);
    }
    const handoff = decodeRequest('handoff', validHandoff);
    expect(handoff.ok).toBe(true);
    const intent = decodeRequest('intent', { intent: validHandoff.intent });
    expect(intent.ok).toBe(true);
  });

  it('treats an unknown type as a typed no-op, never a throw', () => {
    const decoded = decodeRequest('drive.arbitrary.code', { evil: true });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.code).toBe(ProtocolErrorCode.UnsupportedType);
    expect(() => decodeRequest('', undefined)).not.toThrow();
    expect(() => decodeRequest('handoff', undefined)).not.toThrow();
    expect(() => decodeRequest('intent', null)).not.toThrow();
  });

  it('round-trips a handoff payload with every field preserved', () => {
    const decoded = decodeRequest('handoff', validHandoff);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.request.type !== 'handoff') throw new Error('expected handoff');
    const p: HandoffPayload = decoded.request.payload;
    expect(p.roomId).toBe(validHandoff.roomId);
    expect(p.roomName).toBe(validHandoff.roomName);
    expect(p.accessToken).toBe(validHandoff.accessToken);
    expect(p.apiOrigin).toBe(validHandoff.apiOrigin);
    expect(p.target).toBe('auto');
    expect(p.intent?.providerId).toBe('netflix');
    expect(p.intent?.positionMs).toBe(12_345);
  });

  it('defaults an absent target to auto and refuses an unknown one', () => {
    const { target, ...noTarget } = validHandoff;
    void target;
    const decoded = decodeRequest('handoff', noTarget);
    if (!decoded.ok || decoded.request.type !== 'handoff') throw new Error('expected handoff');
    expect(decoded.request.payload.target).toBe('auto');
    expect(decodeRequest('handoff', { ...validHandoff, target: 'tabId:42' }).ok).toBe(false);
  });

  it('rejects malformed handoff fields', () => {
    const cases: Array<Record<string, unknown>> = [
      { ...validHandoff, roomId: '' },
      { ...validHandoff, roomId: 'room id with spaces' },
      { ...validHandoff, roomId: 'x'.repeat(129) },
      { ...validHandoff, accessToken: '' },
      { ...validHandoff, accessToken: 'has space' },
      { ...validHandoff, accessToken: 'a'.repeat(MAX_TOKEN_LENGTH + 1) },
      { ...validHandoff, accessToken: 42 },
      { ...validHandoff, apiOrigin: 'not-a-url' },
      { ...validHandoff, apiOrigin: 'javascript:alert(1)' },
      { ...validHandoff, roomName: 12 },
    ];
    for (const payload of cases) {
      const decoded = decodeRequest('handoff', payload);
      expect(decoded.ok, JSON.stringify(payload).slice(0, 80)).toBe(false);
      if (!decoded.ok) expect(decoded.code).toBe(ProtocolErrorCode.BadRequest);
    }
  });

  it('rejects a non-http content URL (no scheme the extension could open)', () => {
    for (const contentUrl of [
      'javascript:fetch("//evil")',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'chrome-extension://abc/manifest.json',
      'chrome://settings',
      'x'.repeat(3000),
    ]) {
      const decoded = decodeRequest('intent', {
        intent: { ...validHandoff.intent, contentUrl },
      });
      expect(decoded.ok, contentUrl.slice(0, 40)).toBe(false);
    }
  });

  it('rejects out-of-range playback values', () => {
    const bad = [
      { ...validHandoff.intent, rate: 0 },
      { ...validHandoff.intent, rate: 64 },
      { ...validHandoff.intent, positionMs: -1 },
      { ...validHandoff.intent, positionMs: Number.POSITIVE_INFINITY },
      { ...validHandoff.intent, positionMs: Number.NaN },
      { ...validHandoff.intent, playing: 'yes' },
      { ...validHandoff.intent, providerId: 'NOT lowercase' },
    ];
    for (const intent of bad) {
      expect(decodeRequest('intent', { intent }).ok).toBe(false);
    }
  });

  it('accepts a null intent and null optional strings', () => {
    const decoded = decodeRequest('handoff', { ...validHandoff, intent: null, roomName: null });
    if (!decoded.ok || decoded.request.type !== 'handoff') throw new Error('expected handoff');
    expect(decoded.request.payload.intent).toBeNull();
    expect(decoded.request.payload.roomName).toBeNull();
  });
});

/* ── responses / events ── */

describe('response and event encoding', () => {
  it('round-trips an ok response', () => {
    const res = readResponse(okResponse(1, 'r9', 'status', { connected: true }));
    expect(res?.ok).toBe(true);
    expect(res?.id).toBe('r9');
    if (res?.ok === true) expect(res.payload).toEqual({ connected: true });
  });

  it('round-trips an error response with the supported range', () => {
    const res = readResponse(
      errorResponse(1, 'r9', ProtocolErrorCode.UnsupportedVersion, 'nope', { min: 1, max: 1 }),
    );
    expect(res?.ok).toBe(false);
    if (res?.ok === false) {
      expect(res.error.code).toBe(ProtocolErrorCode.UnsupportedVersion);
      expect(res.error.supported).toEqual({ min: 1, max: 1 });
    }
  });

  it('ignores foreign responses and events', () => {
    expect(readResponse({ channel: 'other', id: 'r1', ok: true })).toBeNull();
    expect(readResponse({ channel: PROTOCOL_CHANNEL, id: 'r1' })).toBeNull();
    expect(readEvent({ channel: PROTOCOL_CHANNEL, event: 'wat' })).toBeNull();
    expect(readEvent({ channel: 'other', event: 'telemetry' })).toBeNull();
  });

  it('round-trips telemetry events', () => {
    const ev = readEvent(eventMessage('telemetry', { positionMs: 10, durationMs: 20 }));
    expect(ev?.event).toBe('telemetry');
    expect(ev?.payload).toEqual({ positionMs: 10, durationMs: 20 });
  });

  /** The end of an item is its own event, not a telemetry sample and not a
   *  pause — a page that reads it as either cannot advance a queue. */
  it('round-trips the end of the driven item', () => {
    const payload = { positionMs: 5_400_000, durationMs: 5_400_000, mediaKey: 'url:x', at: 7 };
    const ev = readEvent(eventMessage('ended', payload));
    expect(ev?.event).toBe('ended');
    expect(ev?.payload).toEqual(payload);
  });
});

/* ── advertised capabilities ── */

describe('EXTENSION_CAPABILITIES', () => {
  /** Pages branch on the ABSENCE of a capability, so a name that shipped can
   *  never be renamed or dropped — only added to. */
  it('still advertises everything that has ever shipped', () => {
    for (const capability of ['handoff', 'telemetry', 'capability', 'release', 'modeB', 'ended']) {
      expect(EXTENSION_CAPABILITIES, capability).toContain(capability);
    }
  });

  it('advertises screen/window sharing separately from tab sharing', () => {
    expect(EXTENSION_CAPABILITIES).toContain('modeB.desktop');
    // A page that only sees 'modeB' must keep its own screen-share path: the
    // two are different capabilities, and one never implies the other.
    expect(EXTENSION_CAPABILITIES.indexOf('modeB')).toBeLessThan(
      EXTENSION_CAPABILITIES.indexOf('modeB.desktop'),
    );
  });

  it('lists every capability once', () => {
    expect(new Set(EXTENSION_CAPABILITIES).size).toBe(EXTENSION_CAPABILITIES.length);
  });
});

/* ── disclosure ── */

describe('redactProvider', () => {
  it('discloses known providers (a fixed public list)', () => {
    expect(redactProvider({ id: 'netflix', name: 'Netflix', tier: 'drm' })).toEqual({
      id: 'netflix',
      name: 'Netflix',
      tier: 'drm',
    });
  });

  it('never discloses an arbitrary hostname (that is browsing history)', () => {
    expect(redactProvider({ id: 'generic', name: 'intranet.acme.example', tier: 'generic' })).toEqual(
      { id: 'generic', name: 'This page', tier: 'generic' },
    );
    expect(redactProvider({ id: 'unknown', name: 'This page', tier: 'generic' }).name).toBe(
      'This page',
    );
  });
});

/* ── url helpers ── */

describe('url helpers', () => {
  it('isSafeHttpUrl allows only http(s)', () => {
    expect(isSafeHttpUrl('https://a.example/x')).toBe(true);
    expect(isSafeHttpUrl('http://localhost:3000')).toBe(true);
    expect(isSafeHttpUrl('ws://a.example')).toBe(false);
    expect(isSafeHttpUrl('javascript:1')).toBe(false);
    expect(isSafeHttpUrl('nonsense')).toBe(false);
  });

  it('originOf normalises to a bare origin', () => {
    expect(originOf('https://gather.watch/room/123?x=1')).toBe('https://gather.watch');
    expect(originOf('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(originOf('file:///tmp/x')).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

/* ── ports ── */

describe('event port naming', () => {
  it('round-trips the versioned port name', () => {
    expect(parseEventPortName(eventPortName())).toBe(PROTOCOL_VERSION);
    expect(parseEventPortName('gather.ext.events.v2')).toBe(2);
  });

  it('rejects foreign port names', () => {
    expect(parseEventPortName('gather.ext.events')).toBeNull();
    expect(parseEventPortName('some-other-port')).toBeNull();
    expect(parseEventPortName('gather.ext.events.vX')).toBeNull();
  });
});
