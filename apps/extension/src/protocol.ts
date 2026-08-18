/**
 * Gather web ↔ extension message protocol — versioned, typed and PURE.
 *
 * This module is the single definition of what may cross the external
 * boundary. It contains no chrome API access and no I/O, so every rule in it
 * is unit-testable in node (see test/protocol.test.ts). The security policy
 * that *uses* these rules lives in `external.ts`; the threat model is written
 * down there.
 *
 * Shape of every message on the wire (structured-cloned, never JSON.parse'd):
 *
 *   request   { channel:'gather.ext', v:1, id:'r7', type:'handoff', payload:{…} }
 *   response  { channel:'gather.ext', v:1, id:'r7', ok:true,  type:'handoff', payload:{…} }
 *             { channel:'gather.ext', v:1, id:'r7', ok:false, type:'error',   error:{…} }
 *   event     { channel:'gather.ext', v:1, event:'telemetry', payload:{…} }   (port only)
 *
 * Rules that must not be relaxed:
 *  - `channel` is checked first; anything else is IGNORED, never answered.
 *    Other libraries on the same page may use the same externally-connectable
 *    channel, and answering their messages would be a bug, not a feature.
 *  - An unknown `type` inside a well-formed envelope is a NO-OP that answers
 *    with UNSUPPORTED_TYPE. It never throws and never partially applies.
 *  - Versions are negotiated down (see `negotiateVersion`), never up. A newer
 *    web app talking to an older extension gets a typed refusal carrying the
 *    supported range so it can degrade, rather than a silent hang.
 *  - Every field is bounds-checked here, before any handler sees it. Handlers
 *    receive validated data or nothing.
 */

/* ────────────────────────────── constants ────────────────────────────── */

export const PROTOCOL_CHANNEL = 'gather.ext';
/** Bumped when the message set changes incompatibly. */
export const PROTOCOL_VERSION = 1;
/** Oldest version this build still answers. */
export const PROTOCOL_MIN_VERSION = 1;
/** Long-lived event port name: `gather.ext.events.v1`. */
export const EVENT_PORT_PREFIX = 'gather.ext.events.v';

export const MAX_ID_LENGTH = 64;
export const MAX_ROOM_ID_LENGTH = 128;
export const MAX_ROOM_NAME_LENGTH = 200;
/** A room-scoped access JWT; generous but bounded (memory + storage guard). */
export const MAX_TOKEN_LENGTH = 4096;
export const MAX_URL_LENGTH = 2048;
export const MAX_PROVIDER_ID_LENGTH = 32;
/** Rate bounds mirror contracts' PlaybackState (0.25–4). */
export const MIN_RATE = 0.25;
export const MAX_RATE = 4;
/** ~115 days; anything beyond is a nonsense position, not a media offset. */
export const MAX_POSITION_MS = 1e10;

const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const ROOM_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** JWT / base64url charset only: no whitespace, no control chars, no quotes. */
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/* ──────────────────────────────── errors ─────────────────────────────── */

export const ProtocolErrorCode = {
  UnsupportedVersion: 'UNSUPPORTED_VERSION',
  UnsupportedType: 'UNSUPPORTED_TYPE',
  BadRequest: 'BAD_REQUEST',
  ForbiddenOrigin: 'FORBIDDEN_ORIGIN',
  ApiOriginMismatch: 'API_ORIGIN_MISMATCH',
  NotConnected: 'NOT_CONNECTED',
  Internal: 'INTERNAL',
} as const;
export type ProtocolErrorCode = (typeof ProtocolErrorCode)[keyof typeof ProtocolErrorCode];

export interface ProtocolError {
  code: ProtocolErrorCode;
  /** Human-readable, never contains a token or a URL from another origin. */
  message: string;
  /** Present on UNSUPPORTED_VERSION so the caller can downgrade. */
  supported: { min: number; max: number } | null;
}

/* ─────────────────────────────── payloads ────────────────────────────── */

/**
 * What the room believes is playing. `contentUrl` is a CLASSIFICATION HINT
 * ONLY — it is fed to `providerForUrl` and nothing else. It is never
 * navigated to, never fetched, never used to choose an API endpoint.
 */
export interface MediaIntent {
  /** Known provider id hint (e.g. 'netflix'), or null when unknown. */
  providerId: string | null;
  /** http(s) only, bounded; classification hint, never a fetch/navigate target. */
  contentUrl: string | null;
  positionMs: number;
  rate: number;
  playing: boolean;
}

export interface HandoffPayload {
  roomId: string;
  roomName: string | null;
  /** Room-scoped access token. Only ever sent to the extension's own
   *  configured API origin — see external.ts. */
  accessToken: string;
  /** The API origin the page thinks it is talking to. Used ONLY as an
   *  equality check against the extension's build-time config; never adopted. */
  apiOrigin: string;
  intent: MediaIntent | null;
  /** Which tab to drive. The page can never name a tab id — it may only
   *  choose between browser-derived targets. */
  target: HandoffTarget;
}

export type HandoffTarget = 'auto' | 'sender';

export interface HelloPayload {
  /** Optional, for diagnostics only. Bounded and otherwise unused. */
  appVersion: string | null;
}

export interface IntentPayload {
  intent: MediaIntent;
}

/** Provider summary as disclosed to the page — see `redactProvider`. */
export interface ProviderSummary {
  id: string;
  name: string;
  tier: string;
}

export interface HelloResult {
  extensionVersion: string;
  protocolVersion: number;
  minProtocolVersion: number;
  /** Feature flags, for forward compatibility. */
  capabilities: readonly string[];
}

export interface SessionStatus {
  /** Extension holds a live room connection. */
  connected: boolean;
  roomId: string | null;
  roomName: string | null;
  /** A tab is currently being driven. */
  driving: boolean;
  provider: ProviderSummary | null;
  hasMedia: boolean;
}

export interface CapabilityResult {
  /** A media element was seen in the candidate tab. */
  hasMedia: boolean;
  /** The extension has a target tab it could drive right now. */
  targetKnown: boolean;
  canDrive: boolean;
  provider: ProviderSummary | null;
}

export interface TelemetryPayload {
  positionMs: number;
  durationMs: number;
  playing: boolean;
  rate: number;
  /** Extension-side clock at capture (Date.now()). */
  at: number;
}

/**
 * The driven item ran out. Deliberately NOT a telemetry sample and
 * deliberately not a pause: telemetry is a heartbeat the page samples, and a
 * pause is something a person did. This is the one event that says the media
 * has no more frames — what a room advances on.
 */
export interface EndedPayload {
  /** Where the player stopped. */
  positionMs: number;
  /** The item's full length; 0 when it was never known. The page needs it to
   *  clamp a projection that would otherwise run past the end of the item. */
  durationMs: number;
  /** Which item ended, as the extension's driver keys it (`mediaKeyOf`), so a
   *  page that has already moved on can ignore a late end. null when the room
   *  had no ref. */
  mediaKey: string | null;
  /** Extension-side clock when the end was seen (Date.now()). */
  at: number;
}

/* ──────────────────────────── request union ──────────────────────────── */

export type ProtocolRequest =
  | { type: 'hello'; payload: HelloPayload }
  | { type: 'status'; payload: Record<string, never> }
  | { type: 'capability'; payload: Record<string, never> }
  | { type: 'handoff'; payload: HandoffPayload }
  | { type: 'intent'; payload: IntentPayload }
  | { type: 'release'; payload: Record<string, never> };

export type ProtocolRequestType = ProtocolRequest['type'];

export const REQUEST_TYPES: readonly ProtocolRequestType[] = [
  'hello',
  'status',
  'capability',
  'handoff',
  'intent',
  'release',
];

export type ProtocolEventType = 'telemetry' | 'status' | 'capability' | 'ended';

/**
 * Advertised in `hello`. Additive only — a capability that ever shipped keeps
 * its name forever, because pages branch on the absence of one to decide what
 * to do themselves. `modeB` is tab capture; `modeB.desktop` additionally means
 * this build can share a whole screen or a single window, which is what lets a
 * page stop offering its own `getDisplayMedia` path.
 */
export const EXTENSION_CAPABILITIES: readonly string[] = [
  'handoff',
  'telemetry',
  'capability',
  'release',
  'modeB',
  'modeB.desktop',
  /** This build reports the end of the driven item (`ended` port event). */
  'ended',
];

/* ─────────────────────────── wire message types ──────────────────────── */

export interface ProtocolRequestMessage {
  channel: typeof PROTOCOL_CHANNEL;
  v: number;
  id: string;
  type: string;
  payload: unknown;
}

export interface ProtocolOkResponse {
  channel: typeof PROTOCOL_CHANNEL;
  v: number;
  id: string;
  ok: true;
  type: string;
  payload: unknown;
}

export interface ProtocolErrorResponse {
  channel: typeof PROTOCOL_CHANNEL;
  v: number;
  id: string;
  ok: false;
  type: 'error';
  error: ProtocolError;
}

export type ProtocolResponse = ProtocolOkResponse | ProtocolErrorResponse;

export interface ProtocolEventMessage {
  channel: typeof PROTOCOL_CHANNEL;
  v: number;
  event: ProtocolEventType;
  payload: unknown;
}

/* ───────────────────────────── primitives ────────────────────────────── */

function isRecord(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

function str(u: unknown, max: number): string | null {
  return typeof u === 'string' && u.length > 0 && u.length <= max ? u : null;
}

function nullableStr(u: unknown, max: number): { ok: true; value: string | null } | { ok: false } {
  if (u === null || u === undefined) return { ok: true, value: null };
  const s = str(u, max);
  return s === null ? { ok: false } : { ok: true, value: s };
}

function num(u: unknown, min: number, max: number): number | null {
  return typeof u === 'number' && Number.isFinite(u) && u >= min && u <= max ? u : null;
}

/**
 * http(s) origin check for page-supplied URLs. Rejects `javascript:`,
 * `data:`, `file:`, `chrome-extension:` and anything unparseable — the page
 * must never be able to hand the extension a scheme it could be tricked into
 * opening or fetching.
 */
export function isSafeHttpUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/** Normalise an http(s) URL to a bare origin, or null when it is not one. */
export function originOf(value: string | undefined): string | null {
  if (value === undefined || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

/* ───────────────────────── version negotiation ───────────────────────── */

/**
 * Resolve the version to speak with a caller requesting `requested`.
 * Returns null when no common version exists. Negotiation is downward only:
 * a caller asking for a future version is refused (with the supported range)
 * rather than answered in a dialect it may not understand.
 */
export function negotiateVersion(requested: unknown): number | null {
  if (typeof requested !== 'number' || !Number.isInteger(requested)) return null;
  if (requested < PROTOCOL_MIN_VERSION) return null;
  if (requested > PROTOCOL_VERSION) return null;
  return requested;
}

export function supportedRange(): { min: number; max: number } {
  return { min: PROTOCOL_MIN_VERSION, max: PROTOCOL_VERSION };
}

/* ──────────────────────────── envelope read ──────────────────────────── */

export interface EnvelopeHead {
  v: unknown;
  id: string;
  type: string;
  payload: unknown;
}

/**
 * Recognise a Gather envelope. Returns null for anything that is not one —
 * including well-formed messages from other libraries sharing this channel —
 * so the caller can stay silent instead of answering strangers.
 */
export function readEnvelope(raw: unknown): EnvelopeHead | null {
  if (!isRecord(raw)) return null;
  if (raw['channel'] !== PROTOCOL_CHANNEL) return null;
  const id = str(raw['id'], MAX_ID_LENGTH);
  const type = str(raw['type'], 64);
  // A malformed id cannot be correlated by the caller, so a reply would be
  // useless noise: treat it as not-ours.
  if (id === null || !ID_RE.test(id) || type === null) return null;
  return { v: raw['v'], id, type, payload: raw['payload'] };
}

/* ─────────────────────────── payload decoders ────────────────────────── */

export type DecodedRequest =
  | { ok: true; request: ProtocolRequest }
  | { ok: false; code: ProtocolErrorCode; message: string };

function decodeIntent(raw: unknown): MediaIntent | null {
  if (!isRecord(raw)) return null;
  const providerId = nullableStr(raw['providerId'], MAX_PROVIDER_ID_LENGTH);
  if (!providerId.ok) return null;
  if (providerId.value !== null && !PROVIDER_ID_RE.test(providerId.value)) return null;
  const contentUrl = nullableStr(raw['contentUrl'], MAX_URL_LENGTH);
  if (!contentUrl.ok) return null;
  if (contentUrl.value !== null && !isSafeHttpUrl(contentUrl.value)) return null;
  const positionMs = num(raw['positionMs'], 0, MAX_POSITION_MS);
  if (positionMs === null) return null;
  const rate = num(raw['rate'], MIN_RATE, MAX_RATE);
  if (rate === null) return null;
  if (typeof raw['playing'] !== 'boolean') return null;
  return {
    providerId: providerId.value,
    contentUrl: contentUrl.value,
    positionMs,
    rate,
    playing: raw['playing'],
  };
}

function decodeHandoff(raw: unknown): DecodedRequest {
  const bad = (message: string): DecodedRequest => ({
    ok: false,
    code: ProtocolErrorCode.BadRequest,
    message,
  });
  if (!isRecord(raw)) return bad('handoff payload must be an object');

  const roomId = str(raw['roomId'], MAX_ROOM_ID_LENGTH);
  if (roomId === null || !ROOM_ID_RE.test(roomId)) return bad('invalid roomId');

  const roomName = nullableStr(raw['roomName'], MAX_ROOM_NAME_LENGTH);
  if (!roomName.ok) return bad('invalid roomName');

  const accessToken = str(raw['accessToken'], MAX_TOKEN_LENGTH);
  if (accessToken === null || !TOKEN_RE.test(accessToken)) return bad('invalid accessToken');

  const apiOrigin = str(raw['apiOrigin'], MAX_URL_LENGTH);
  if (apiOrigin === null || originOf(apiOrigin) === null) return bad('invalid apiOrigin');

  const rawIntent = raw['intent'];
  let intent: MediaIntent | null = null;
  if (rawIntent !== null && rawIntent !== undefined) {
    intent = decodeIntent(rawIntent);
    if (intent === null) return bad('invalid intent');
  }

  const rawTarget = raw['target'];
  let target: HandoffTarget = 'auto';
  if (rawTarget !== undefined && rawTarget !== null) {
    if (rawTarget !== 'auto' && rawTarget !== 'sender') return bad('invalid target');
    target = rawTarget;
  }

  return {
    ok: true,
    request: {
      type: 'handoff',
      payload: { roomId, roomName: roomName.value, accessToken, apiOrigin, intent, target },
    },
  };
}

/**
 * Decode a validated envelope body into a typed request. Unknown types are a
 * no-op refusal (UNSUPPORTED_TYPE), never a throw.
 */
export function decodeRequest(type: string, payload: unknown): DecodedRequest {
  switch (type) {
    case 'hello': {
      const appVersion = isRecord(payload)
        ? nullableStr(payload['appVersion'], 64)
        : { ok: true as const, value: null };
      if (!appVersion.ok) {
        return { ok: false, code: ProtocolErrorCode.BadRequest, message: 'invalid appVersion' };
      }
      return { ok: true, request: { type: 'hello', payload: { appVersion: appVersion.value } } };
    }
    case 'status':
      return { ok: true, request: { type: 'status', payload: {} } };
    case 'capability':
      return { ok: true, request: { type: 'capability', payload: {} } };
    case 'release':
      return { ok: true, request: { type: 'release', payload: {} } };
    case 'handoff':
      return decodeHandoff(payload);
    case 'intent': {
      const intent = isRecord(payload) ? decodeIntent(payload['intent']) : null;
      if (intent === null) {
        return { ok: false, code: ProtocolErrorCode.BadRequest, message: 'invalid intent' };
      }
      return { ok: true, request: { type: 'intent', payload: { intent } } };
    }
    default:
      return {
        ok: false,
        code: ProtocolErrorCode.UnsupportedType,
        message: `unknown message type: ${type.slice(0, 32)}`,
      };
  }
}

/* ─────────────────────────── message builders ────────────────────────── */

export function buildRequest(
  id: string,
  type: ProtocolRequestType,
  payload: unknown,
  v: number = PROTOCOL_VERSION,
): ProtocolRequestMessage {
  return { channel: PROTOCOL_CHANNEL, v, id, type, payload };
}

export function okResponse(
  v: number,
  id: string,
  type: string,
  payload: unknown,
): ProtocolOkResponse {
  return { channel: PROTOCOL_CHANNEL, v, id, ok: true, type, payload };
}

export function errorResponse(
  v: number,
  id: string,
  code: ProtocolErrorCode,
  message: string,
  supported: { min: number; max: number } | null = null,
): ProtocolErrorResponse {
  return { channel: PROTOCOL_CHANNEL, v, id, ok: false, type: 'error', error: { code, message, supported } };
}

export function eventMessage(
  event: ProtocolEventType,
  payload: unknown,
  v: number = PROTOCOL_VERSION,
): ProtocolEventMessage {
  return { channel: PROTOCOL_CHANNEL, v, event, payload };
}

/** Recognise a response addressed to us. Returns null for foreign messages. */
export function readResponse(raw: unknown): ProtocolResponse | null {
  if (!isRecord(raw)) return null;
  if (raw['channel'] !== PROTOCOL_CHANNEL) return null;
  const id = str(raw['id'], MAX_ID_LENGTH);
  if (id === null) return null;
  const v = typeof raw['v'] === 'number' ? raw['v'] : PROTOCOL_VERSION;
  if (raw['ok'] === true) {
    return {
      channel: PROTOCOL_CHANNEL,
      v,
      id,
      ok: true,
      type: typeof raw['type'] === 'string' ? raw['type'] : '',
      payload: raw['payload'],
    };
  }
  if (raw['ok'] === false) {
    const err = isRecord(raw['error']) ? raw['error'] : {};
    const code = typeof err['code'] === 'string' ? err['code'] : ProtocolErrorCode.Internal;
    const message = typeof err['message'] === 'string' ? err['message'] : 'extension error';
    const sup = isRecord(err['supported']) ? err['supported'] : null;
    return {
      channel: PROTOCOL_CHANNEL,
      v,
      id,
      ok: false,
      type: 'error',
      error: {
        code: code as ProtocolErrorCode,
        message,
        supported:
          sup !== null && typeof sup['min'] === 'number' && typeof sup['max'] === 'number'
            ? { min: sup['min'], max: sup['max'] }
            : null,
      },
    };
  }
  return null;
}

/** Recognise a port event. Returns null for foreign messages. */
export function readEvent(raw: unknown): ProtocolEventMessage | null {
  if (!isRecord(raw)) return null;
  if (raw['channel'] !== PROTOCOL_CHANNEL) return null;
  const event = raw['event'];
  if (event !== 'telemetry' && event !== 'status' && event !== 'capability' && event !== 'ended') {
    return null;
  }
  return {
    channel: PROTOCOL_CHANNEL,
    v: typeof raw['v'] === 'number' ? raw['v'] : PROTOCOL_VERSION,
    event,
    payload: raw['payload'],
  };
}

/* ───────────────────────────── disclosure ────────────────────────────── */

/**
 * Redact a provider before it crosses to the page.
 *
 * Known provider ids come from a fixed public list, so disclosing them tells
 * the page nothing it could not guess. An *arbitrary* hostname is browsing
 * history — `providerForUrl` puts the raw hostname in `name` for unknown
 * sites, and that must never leave the extension.
 */
export function redactProvider(provider: {
  id: string;
  name: string;
  tier: string;
}): ProviderSummary {
  if (provider.id === 'generic' || provider.id === 'unknown') {
    return { id: 'generic', name: 'This page', tier: 'generic' };
  }
  return { id: provider.id, name: provider.name, tier: provider.tier };
}

/* ─────────────────────────── id announcement ─────────────────────────── */

/**
 * `chrome.runtime.sendMessage(extensionId, …)` needs the extension's id, and
 * an unpacked dev build's id is machine-specific. So the content script — and
 * ONLY when it is running on an allowlisted Gather origin — announces the id
 * to the page over `window.postMessage`. That is a same-origin, same-tab
 * announcement of a value that is public anyway (it is in the store URL); no
 * token, session or tab data rides on it, and the page cannot ask for
 * anything by replying.
 */
export const ANNOUNCE_EVENT = 'announce';
export const ANNOUNCE_REQUEST_EVENT = 'announce.request';

export interface AnnouncePayload {
  extensionId: string;
  extensionVersion: string;
  protocolVersion: number;
  minProtocolVersion: number;
}

/** Chrome extension ids are exactly 32 chars from a–p. */
const EXTENSION_ID_RE = /^[a-p]{32}$/;

export function isExtensionId(value: string): boolean {
  return EXTENSION_ID_RE.test(value);
}

export function buildAnnounce(payload: AnnouncePayload): Record<string, unknown> {
  return { channel: PROTOCOL_CHANNEL, v: PROTOCOL_VERSION, event: ANNOUNCE_EVENT, payload };
}

export function buildAnnounceRequest(): Record<string, unknown> {
  return { channel: PROTOCOL_CHANNEL, v: PROTOCOL_VERSION, event: ANNOUNCE_REQUEST_EVENT };
}

export function isAnnounceRequest(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    raw['channel'] === PROTOCOL_CHANNEL &&
    raw['event'] === ANNOUNCE_REQUEST_EVENT
  );
}

/** Read an announcement, rejecting anything that is not a plausible id. */
export function readAnnounce(raw: unknown): AnnouncePayload | null {
  if (!isRecord(raw)) return null;
  if (raw['channel'] !== PROTOCOL_CHANNEL || raw['event'] !== ANNOUNCE_EVENT) return null;
  const payload = raw['payload'];
  if (!isRecord(payload)) return null;
  const extensionId = str(payload['extensionId'], 64);
  if (extensionId === null || !isExtensionId(extensionId)) return null;
  const protocolVersion = num(payload['protocolVersion'], 0, 1000);
  const minProtocolVersion = num(payload['minProtocolVersion'], 0, 1000);
  if (protocolVersion === null || minProtocolVersion === null) return null;
  return {
    extensionId,
    extensionVersion: str(payload['extensionVersion'], 32) ?? '0.0.0',
    protocolVersion,
    minProtocolVersion,
  };
}

/* ──────────────────────────── port helpers ───────────────────────────── */

/** `gather.ext.events.v1` → 1. Returns null for foreign port names. */
export function parseEventPortName(name: string): number | null {
  if (!name.startsWith(EVENT_PORT_PREFIX)) return null;
  const raw = name.slice(EVENT_PORT_PREFIX.length);
  if (!/^\d{1,3}$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

export function eventPortName(v: number = PROTOCOL_VERSION): string {
  return `${EVENT_PORT_PREFIX}${v}`;
}
