/**
 * The web half of the Gather web ↔ extension handoff channel.
 *
 * The web app is the interface; the extension is the driver (docs/
 * EXTENSION_FIRST.md, Part 2). This module is the only place the web app
 * talks to the extension. It:
 *
 *   - detects whether the extension is installed, in bounded time,
 *   - hands a room over (room id + room-scoped access token + media intent),
 *   - asks what the extension can do with the user's current tab,
 *   - streams telemetry back from the driven tab,
 *   - reports when the driven item RAN OUT, so the room can auto-advance,
 *   - relinquishes the room.
 *
 * ── Rules this file obeys ─────────────────────────────────────────────────
 *
 * SSR-safe. Next renders this on the server too, so every `window` /
 * `chrome` access goes through `runtime()` and returns the "no extension"
 * answer on the server. Nothing runs at import time.
 *
 * Never hangs. `chrome.runtime.sendMessage` to a missing extension can call
 * back late, never, or throw synchronously depending on the browser, so every
 * call is raced against a short timeout and settles exactly once. On
 * non-Chromium browsers there is no `chrome.runtime` at all and detection
 * returns instantly.
 *
 * Never throws at the caller. Everything returns a Result; a missing
 * extension is an ordinary `{ ok: false, error: { code: 'NOT_INSTALLED' } }`,
 * not an exception, so callers can render the install prompt and move on.
 *
 * ── Security notes for whoever wires the UI ───────────────────────────────
 *
 * The access token passed to `handoffRoom` is room-scoped and short-lived.
 * The extension refuses a handoff whose `apiOrigin` is not the origin its own
 * build talks to, so a token can never be steered elsewhere by this call.
 * Pass `API_URL`'s origin — nothing else.
 *
 * The extension id is discovered from the extension's own content script
 * (a same-origin `window.postMessage` announcement) when no build-time id is
 * configured, because an unpacked dev build's id is machine-specific. A
 * build-time id (`NEXT_PUBLIC_GATHER_EXTENSION_ID`) always wins over an
 * announcement: in production, configure it. An announcement can only be
 * spoofed by script already running on this origin, which is a strictly
 * worse-off position than this channel.
 *
 * ── Duplication ──────────────────────────────────────────────────────────
 *
 * The protocol below is duplicated from `apps/extension/src/protocol.ts`
 * because the two apps share no package (adding one would mean a workspace
 * install). The two copies MUST be changed together; the version constants
 * are the tripwire — a mismatch produces a typed UNSUPPORTED_VERSION refusal
 * rather than silent misbehaviour.
 */
import type { MediaRef } from '@gather/contracts';

/* ══════════════════════════ protocol (duplicated) ═════════════════════════ */

export const PROTOCOL_CHANNEL = 'gather.ext';
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_MIN_VERSION = 1;
export const EVENT_PORT_PREFIX = 'gather.ext.events.v';
export const ANNOUNCE_EVENT = 'announce';
export const ANNOUNCE_REQUEST_EVENT = 'announce.request';

export type ProtocolRequestType =
  | 'hello'
  | 'status'
  | 'capability'
  | 'handoff'
  | 'intent'
  | 'release';

export type ProtocolEventType = 'telemetry' | 'status' | 'capability' | 'ended';

export type ProtocolErrorCode =
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_TYPE'
  | 'BAD_REQUEST'
  | 'FORBIDDEN_ORIGIN'
  | 'API_ORIGIN_MISMATCH'
  | 'NOT_CONNECTED'
  | 'INTERNAL'
  /* web-side only */
  | 'NOT_INSTALLED'
  | 'NO_RESPONSE'
  | 'UNAVAILABLE';

export interface BridgeError {
  code: ProtocolErrorCode;
  message: string;
}

/** A discriminated result rather than a throw: every bridge call crosses into
 *  a browser extension that may not be installed, so failure is an ordinary
 *  outcome the caller renders, not an exception. */
export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: BridgeError };

/** What the room believes is playing. `contentUrl` is a classification hint
 *  only — the extension never fetches or navigates to it. */
export interface MediaIntent {
  providerId: string | null;
  contentUrl: string | null;
  positionMs: number;
  rate: number;
  playing: boolean;
}

export type HandoffTarget = 'auto' | 'sender';

export interface ProviderSummary {
  id: string;
  name: string;
  tier: string;
}

export interface HelloResult {
  extensionVersion: string;
  protocolVersion: number;
  minProtocolVersion: number;
  capabilities: readonly string[];
}

export interface SessionStatus {
  connected: boolean;
  roomId: string | null;
  roomName: string | null;
  driving: boolean;
  provider: ProviderSummary | null;
  hasMedia: boolean;
}

export interface CapabilityResult {
  hasMedia: boolean;
  targetKnown: boolean;
  canDrive: boolean;
  provider: ProviderSummary | null;
}

export interface TelemetryPayload {
  positionMs: number;
  durationMs: number;
  playing: boolean;
  rate: number;
  at: number;
}

/**
 * The driven item ran out. The extension's content script makes exactly ONE
 * such judgement per item and the worker deliberately does not de-duplicate
 * (apps/extension/src/background.ts, `case 'mediaEnded'`), so the de-duplication
 * this room needs is the WEB's job — see StagePane's `advancedKeyRef`.
 */
export interface EndedPayload {
  /** Where the player stopped. */
  positionMs: number;
  /** The item's full length; 0 when it was never known. */
  durationMs: number;
  /** Which item ended, keyed by {@link extensionMediaKey}. null when the
   *  extension's room had no ref — never a match for an item on our stage. */
  mediaKey: string | null;
  /** Extension-side clock when the end was seen (Date.now()). */
  at: number;
}

/**
 * Identity of a room item, in the EXTENSION's spelling.
 *
 * A mirror of `mediaKeyOf` in apps/extension/src/driver.ts, and part of the
 * duplication contract at the top of this file: `EndedPayload.mediaKey` is
 * produced by that function, so this is the only way the web can tell "the
 * item that ended" from "an item we already moved on from".
 *
 * Deliberately NOT `lib/player/adapter.ts`'s `mediaKey`, which appends the
 * playback `seq` — that is a media+EPOCH key, and every play/pause/seek mints
 * a fresh epoch. This one changes when the ITEM changes and at no other time.
 */
export function extensionMediaKey(ref: MediaRef | null): string | null {
  if (ref === null) return null;
  switch (ref.kind) {
    case 'hls':
      return `hls:${ref.assetId}`;
    case 'youtube':
      return `youtube:${ref.videoId}`;
    case 'vimeo':
      return `vimeo:${ref.videoId}`;
    case 'soundcloud':
      return `soundcloud:${ref.url}`;
    case 'url':
      return `url:${ref.url}`;
    case 'embed':
      return `embed:${ref.provider}:${ref.embedUrl}`;
    case 'page':
      return `page:${ref.url}`;
  }
}

export interface AnnouncePayload {
  extensionId: string;
  extensionVersion: string;
  protocolVersion: number;
  minProtocolVersion: number;
}

export interface ProtocolRequestMessage {
  channel: typeof PROTOCOL_CHANNEL;
  v: number;
  id: string;
  type: ProtocolRequestType;
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
  error: { code: ProtocolErrorCode; message: string; supported: { min: number; max: number } | null };
}

export type ProtocolResponse = ProtocolOkResponse | ProtocolErrorResponse;

export interface ProtocolEventMessage {
  channel: typeof PROTOCOL_CHANNEL;
  v: number;
  event: ProtocolEventType;
  payload: unknown;
}

function isRecord(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

export function buildRequest(
  id: string,
  type: ProtocolRequestType,
  payload: unknown,
  v: number = PROTOCOL_VERSION,
): ProtocolRequestMessage {
  return { channel: PROTOCOL_CHANNEL, v, id, type, payload };
}

/** Read a response addressed to us. Returns null for foreign messages so a
 *  page sharing this channel with another library never confuses us. */
export function readResponse(raw: unknown): ProtocolResponse | null {
  if (!isRecord(raw)) return null;
  if (raw['channel'] !== PROTOCOL_CHANNEL) return null;
  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) return null;
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
    const sup = isRecord(err['supported']) ? err['supported'] : null;
    return {
      channel: PROTOCOL_CHANNEL,
      v,
      id,
      ok: false,
      type: 'error',
      error: {
        code: (typeof err['code'] === 'string' ? err['code'] : 'INTERNAL') as ProtocolErrorCode,
        message: typeof err['message'] === 'string' ? err['message'] : 'extension error',
        supported:
          sup !== null && typeof sup['min'] === 'number' && typeof sup['max'] === 'number'
            ? { min: sup['min'], max: sup['max'] }
            : null,
      },
    };
  }
  return null;
}

/** Read a port event. Unknown event names are ignored, not thrown on. */
export function readEvent(raw: unknown): ProtocolEventMessage | null {
  if (!isRecord(raw)) return null;
  if (raw['channel'] !== PROTOCOL_CHANNEL) return null;
  const event = raw['event'];
  if (
    event !== 'telemetry' &&
    event !== 'status' &&
    event !== 'capability' &&
    event !== 'ended'
  ) {
    return null;
  }
  return {
    channel: PROTOCOL_CHANNEL,
    v: typeof raw['v'] === 'number' ? raw['v'] : PROTOCOL_VERSION,
    event,
    payload: raw['payload'],
  };
}

const EXTENSION_ID_RE = /^[a-p]{32}$/;

export function isExtensionId(value: string): boolean {
  return EXTENSION_ID_RE.test(value);
}

export function buildAnnounceRequest(): Record<string, unknown> {
  return { channel: PROTOCOL_CHANNEL, v: PROTOCOL_VERSION, event: ANNOUNCE_REQUEST_EVENT };
}

export function readAnnounce(raw: unknown): AnnouncePayload | null {
  if (!isRecord(raw)) return null;
  if (raw['channel'] !== PROTOCOL_CHANNEL || raw['event'] !== ANNOUNCE_EVENT) return null;
  const payload = raw['payload'];
  if (!isRecord(payload)) return null;
  const extensionId = payload['extensionId'];
  if (typeof extensionId !== 'string' || !isExtensionId(extensionId)) return null;
  const protocolVersion = payload['protocolVersion'];
  const minProtocolVersion = payload['minProtocolVersion'];
  if (typeof protocolVersion !== 'number' || typeof minProtocolVersion !== 'number') return null;
  return {
    extensionId,
    extensionVersion:
      typeof payload['extensionVersion'] === 'string' ? payload['extensionVersion'] : '0.0.0',
    protocolVersion,
    minProtocolVersion,
  };
}

/**
 * Pick the version to speak given the extension's advertised range.
 * Returns null when the ranges do not overlap — the honest answer is "this
 * extension build and this web build cannot talk", not a guess.
 */
export function negotiateVersion(
  their: { protocolVersion: number; minProtocolVersion: number },
  ours: { max: number; min: number } = { max: PROTOCOL_VERSION, min: PROTOCOL_MIN_VERSION },
): number | null {
  const max = Math.min(ours.max, their.protocolVersion);
  const min = Math.max(ours.min, their.minProtocolVersion);
  return max >= min ? max : null;
}

export function eventPortName(v: number = PROTOCOL_VERSION): string {
  return `${EVENT_PORT_PREFIX}${v}`;
}

/* ══════════════════════════ chrome, structurally ══════════════════════════ */

interface ChromePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

interface ChromeRuntimeLike {
  sendMessage?: (
    extensionId: string,
    message: unknown,
    callback: (response?: unknown) => void,
  ) => void;
  connect?: (extensionId: string, connectInfo: { name: string }) => ChromePortLike;
  lastError?: { message?: string } | undefined;
}

/** SSR guard + capability guard in one. null ⇒ this browser has no channel. */
function runtime(): ChromeRuntimeLike | null {
  if (typeof window === 'undefined') return null;
  const chrome = (window as unknown as { chrome?: { runtime?: ChromeRuntimeLike } }).chrome;
  const rt = chrome?.runtime;
  if (rt === undefined || typeof rt.sendMessage !== 'function') return null;
  return rt;
}

/** True when this browser could host the channel at all (Chromium + the page
 *  is listed in the extension's `externally_connectable`). SSR-safe. */
export function isExtensionChannelSupported(): boolean {
  return runtime() !== null;
}

/* ═════════════════════════════ configuration ══════════════════════════════ */

export const DEFAULT_DETECT_TIMEOUT_MS = 1200;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const ANNOUNCE_TIMEOUT_MS = 400;

/** Comma-separated ids, e.g. the store id plus a dev unpacked id. */
export function parseExtensionIds(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (isExtensionId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

let configuredIds: string[] = parseExtensionIds(process.env.NEXT_PUBLIC_GATHER_EXTENSION_ID);

export interface BridgeConfig {
  /** Overrides the build-time id list (tests, or a runtime-configured build). */
  extensionIds?: readonly string[];
}

export function configureExtensionBridge(config: BridgeConfig): void {
  if (config.extensionIds !== undefined) {
    configuredIds = config.extensionIds.filter(isExtensionId);
    resetExtensionBridge();
  }
}

/* ═══════════════════════════════ transport ════════════════════════════════ */

let requestSeq = 0;

function nextId(): string {
  requestSeq += 1;
  return `w${String(requestSeq)}.${String(Date.now() % 1e6)}`;
}

/**
 * One message, one answer, bounded. Resolves null on every failure mode —
 * no extension, wrong id, thrown call, silent extension, late callback.
 */
function sendOnce(
  extensionId: string,
  message: unknown,
  timeoutMs: number,
): Promise<unknown | null> {
  const rt = runtime();
  const send = rt?.sendMessage;
  if (rt === null || send === undefined) return Promise.resolve(null);
  return new Promise<unknown | null>((resolve) => {
    let settled = false;
    const settle = (value: unknown | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    try {
      send(extensionId, message, (response?: unknown) => {
        // Reading lastError is what suppresses Chrome's console noise when
        // the extension is absent; it must be read inside the callback.
        const failed = rt.lastError !== undefined && rt.lastError !== null;
        settle(failed ? null : (response ?? null));
      });
    } catch {
      settle(null);
    }
  });
}

/**
 * Ask the extension's content script (running on this same page) for its id.
 * Same-origin postMessage only; ignores anything that is not a well-formed
 * announcement. Resolves null quickly when nothing answers.
 */
function discoverAnnouncedId(timeoutMs: number): Promise<AnnouncePayload | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  return new Promise<AnnouncePayload | null>((resolve) => {
    let settled = false;
    const onMessage = (ev: MessageEvent): void => {
      if (ev.source !== window) return;
      if (ev.origin !== window.location.origin) return;
      const announce = readAnnounce(ev.data);
      if (announce === null) return;
      settle(announce);
    };
    const settle = (value: AnnouncePayload | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    window.addEventListener('message', onMessage);
    try {
      window.postMessage(buildAnnounceRequest(), window.location.origin);
    } catch {
      settle(null);
    }
  });
}

/* ═══════════════════════════════ detection ════════════════════════════════ */

export interface ExtensionInfo {
  installed: boolean;
  version?: string;
  protocolVersion?: number;
  /** false when the installed build speaks no version this web build does. */
  compatible?: boolean;
  capabilities?: readonly string[];
  extensionId?: string;
}

const NOT_INSTALLED: ExtensionInfo = { installed: false };

let detection: Promise<ExtensionInfo> | null = null;
let activeId: string | null = null;
let negotiatedVersion = PROTOCOL_VERSION;

/** Drop cached detection + close the event port (tests, sign-out, reinstall). */
export function resetExtensionBridge(): void {
  detection = null;
  activeId = null;
  negotiatedVersion = PROTOCOL_VERSION;
  closePort();
}

async function helloTo(extensionId: string, timeoutMs: number): Promise<ExtensionInfo | null> {
  const raw = await sendOnce(
    extensionId,
    buildRequest(nextId(), 'hello', { appVersion: null }),
    timeoutMs,
  );
  const response = readResponse(raw);
  if (response === null || !response.ok) return null;
  const payload = response.payload;
  if (!isRecord(payload)) return null;
  const protocolVersion =
    typeof payload['protocolVersion'] === 'number' ? payload['protocolVersion'] : PROTOCOL_VERSION;
  const minProtocolVersion =
    typeof payload['minProtocolVersion'] === 'number' ? payload['minProtocolVersion'] : 1;
  const version = typeof payload['extensionVersion'] === 'string' ? payload['extensionVersion'] : '';
  const capabilities = Array.isArray(payload['capabilities'])
    ? payload['capabilities'].filter((c): c is string => typeof c === 'string')
    : [];
  const agreed = negotiateVersion({ protocolVersion, minProtocolVersion });
  return {
    installed: true,
    protocolVersion,
    compatible: agreed !== null,
    capabilities,
    extensionId,
    ...(version.length > 0 ? { version } : {}),
  };
}

async function detect(timeoutMs: number): Promise<ExtensionInfo> {
  if (runtime() === null) return NOT_INSTALLED;

  // Configured ids first: in production the id is known at build time and an
  // in-page announcement must never be able to redirect the handoff.
  for (const id of configuredIds) {
    const info = await helloTo(id, timeoutMs);
    if (info !== null) return adopt(info);
  }

  const announced = await discoverAnnouncedId(Math.min(ANNOUNCE_TIMEOUT_MS, timeoutMs));
  if (announced === null) return NOT_INSTALLED;
  const info = await helloTo(announced.extensionId, timeoutMs);
  return info === null ? NOT_INSTALLED : adopt(info);
}

function adopt(info: ExtensionInfo): ExtensionInfo {
  activeId = info.extensionId ?? null;
  const agreed = negotiateVersion({
    protocolVersion: info.protocolVersion ?? PROTOCOL_VERSION,
    minProtocolVersion: PROTOCOL_MIN_VERSION,
  });
  negotiatedVersion = agreed ?? PROTOCOL_VERSION;
  return info;
}

/**
 * Is the Gather extension installed, and can we talk to it?
 *
 * Bounded by `timeoutMs` (default 1.2s) and instant on browsers with no
 * extension channel at all. The answer is memoised; pass `{ force: true }`
 * after an install prompt to re-check.
 */
export function detectExtension(
  opts: { timeoutMs?: number; force?: boolean } = {},
): Promise<ExtensionInfo> {
  if (opts.force === true) resetExtensionBridge();
  if (detection === null) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
    detection = detect(timeoutMs).catch(() => NOT_INSTALLED);
  }
  return detection;
}

/* ════════════════════════════ typed requests ══════════════════════════════ */

function fail<T>(code: ProtocolErrorCode, message: string): BridgeResult<T> {
  return { ok: false, error: { code, message } };
}

async function request<T>(
  type: ProtocolRequestType,
  payload: unknown,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<BridgeResult<T>> {
  const info = await detectExtension();
  if (!info.installed || activeId === null) {
    return fail('NOT_INSTALLED', 'the Gather extension is not installed');
  }
  if (info.compatible === false) {
    return fail('UNSUPPORTED_VERSION', 'the installed Gather extension is a different version');
  }
  const raw = await sendOnce(
    activeId,
    buildRequest(nextId(), type, payload, negotiatedVersion),
    timeoutMs,
  );
  const response = readResponse(raw);
  if (response === null) {
    return fail('NO_RESPONSE', 'the extension did not answer');
  }
  if (!response.ok) {
    return { ok: false, error: { code: response.error.code, message: response.error.message } };
  }
  return { ok: true, value: response.payload as T };
}

/** Per-call escape hatch: a UI that must stay snappy can shorten the wait. */
export interface RequestOptions {
  timeoutMs?: number;
}

export interface HandoffRoomInput {
  roomId: string;
  roomName?: string | null;
  /** Room-scoped access token. Goes only to the extension's own API origin. */
  accessToken: string;
  /** The API origin this app talks to — must match the extension's build. */
  apiOrigin: string;
  intent?: MediaIntent | null;
  /** 'auto' (default) drives the user's content tab; 'sender' drives this tab. */
  target?: HandoffTarget;
}

/**
 * Hand this room to the extension: it joins the room's sync stream and drives
 * the user's content tab. Resolves with the extension's session status —
 * `driving: false` means it is armed but has no content tab yet (the user
 * should open the site they want to watch).
 */
export function handoffRoom(
  input: HandoffRoomInput,
  opts: RequestOptions = {},
): Promise<BridgeResult<SessionStatus>> {
  return request<SessionStatus>(
    'handoff',
    {
      roomId: input.roomId,
      roomName: input.roomName ?? null,
      accessToken: input.accessToken,
      apiOrigin: input.apiOrigin,
      intent: input.intent ?? null,
      target: input.target ?? 'auto',
    },
    opts.timeoutMs,
  );
}

/** Update what the room is playing without re-sending the token. */
export function updateIntent(
  intent: MediaIntent,
  opts: RequestOptions = {},
): Promise<BridgeResult<SessionStatus>> {
  return request<SessionStatus>('intent', { intent }, opts.timeoutMs);
}

/** What could the extension do with the user's current tab right now? */
export function queryCapability(opts: RequestOptions = {}): Promise<BridgeResult<CapabilityResult>> {
  return request<CapabilityResult>('capability', {}, opts.timeoutMs);
}

/** The extension's current session, without changing anything. */
export function getExtensionStatus(
  opts: RequestOptions = {},
): Promise<BridgeResult<SessionStatus>> {
  return request<SessionStatus>('status', {}, opts.timeoutMs);
}

/** Relinquish: stop driving and leave the room. */
export function stopDriving(opts: RequestOptions = {}): Promise<BridgeResult<SessionStatus>> {
  return request<SessionStatus>('release', {}, opts.timeoutMs);
}

/* ═══════════════════════════════ event port ═══════════════════════════════ */

type Listener<T> = (value: T) => void;

const telemetryListeners = new Set<Listener<TelemetryPayload>>();
const statusListeners = new Set<Listener<SessionStatus>>();
const capabilityListeners = new Set<Listener<ProviderSummary | null>>();
const endedListeners = new Set<Listener<EndedPayload>>();

let port: ChromePortLike | null = null;
let portOpening = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RECONNECT_ATTEMPTS = 3;

function hasListeners(): boolean {
  return (
    telemetryListeners.size > 0 ||
    statusListeners.size > 0 ||
    capabilityListeners.size > 0 ||
    endedListeners.size > 0
  );
}

function emit<T>(listeners: Set<Listener<T>>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch {
      // A bad listener must not kill the stream.
    }
  }
}

function handleEvent(raw: unknown): void {
  const event = readEvent(raw);
  if (event === null) return; // unknown/foreign events are ignored, never thrown on
  if (event.event === 'telemetry' && isRecord(event.payload)) {
    emit(telemetryListeners, {
      positionMs: typeof event.payload['positionMs'] === 'number' ? event.payload['positionMs'] : 0,
      durationMs: typeof event.payload['durationMs'] === 'number' ? event.payload['durationMs'] : 0,
      playing: event.payload['playing'] === true,
      rate: typeof event.payload['rate'] === 'number' ? event.payload['rate'] : 1,
      at: typeof event.payload['at'] === 'number' ? event.payload['at'] : Date.now(),
    });
    return;
  }
  if (event.event === 'status' && isRecord(event.payload)) {
    emit(statusListeners, event.payload as unknown as SessionStatus);
    return;
  }
  if (event.event === 'capability') {
    emit(capabilityListeners, (event.payload ?? null) as ProviderSummary | null);
    return;
  }
  if (event.event === 'ended' && isRecord(event.payload)) {
    // `mediaKey` is the load-bearing field: it is what lets a room that has
    // already moved on ignore a late end. An absent or non-string one becomes
    // null, which matches no item on any stage.
    const key = event.payload['mediaKey'];
    emit(endedListeners, {
      positionMs: typeof event.payload['positionMs'] === 'number' ? event.payload['positionMs'] : 0,
      durationMs: typeof event.payload['durationMs'] === 'number' ? event.payload['durationMs'] : 0,
      mediaKey: typeof key === 'string' && key.length > 0 ? key : null,
      at: typeof event.payload['at'] === 'number' ? event.payload['at'] : Date.now(),
    });
  }
}

function closePort(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  if (port !== null) {
    try {
      port.disconnect();
    } catch {
      // Already gone.
    }
    port = null;
  }
}

async function ensurePort(): Promise<void> {
  if (port !== null || portOpening || !hasListeners()) return;
  portOpening = true;
  try {
    const info = await detectExtension();
    const rt = runtime();
    if (
      !info.installed ||
      activeId === null ||
      info.compatible === false ||
      rt === null ||
      rt.connect === undefined ||
      !hasListeners()
    ) {
      return;
    }
    let opened: ChromePortLike;
    try {
      opened = rt.connect(activeId, { name: eventPortName(negotiatedVersion) });
    } catch {
      return;
    }
    port = opened;
    opened.onMessage.addListener(handleEvent);
    opened.onDisconnect.addListener(() => {
      port = null;
      scheduleReconnect();
    });
  } finally {
    portOpening = false;
  }
}

function scheduleReconnect(): void {
  if (!hasListeners() || reconnectTimer !== null) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
  reconnectAttempts += 1;
  const delay = 500 * 2 ** (reconnectAttempts - 1);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensurePort();
  }, delay);
}

function subscribe<T>(set: Set<Listener<T>>, listener: Listener<T>): () => void {
  set.add(listener);
  void ensurePort();
  return () => {
    set.delete(listener);
    if (!hasListeners()) closePort();
  };
}

/**
 * Stream playback telemetry from the tab the extension is driving.
 * Returns an unsubscribe function. Safe to call during SSR (it simply never
 * fires) and safe to call before the extension is detected.
 */
export function onTelemetry(cb: (telemetry: TelemetryPayload) => void): () => void {
  return subscribe(telemetryListeners, cb);
}

/** Session status pushes (connected / driving / provider changes). */
export function onStatus(cb: (status: SessionStatus) => void): () => void {
  return subscribe(statusListeners, cb);
}

/** The driven tab's provider changed (SPA navigation, tab switch). */
export function onCapability(cb: (provider: ProviderSummary | null) => void): () => void {
  return subscribe(capabilityListeners, cb);
}

/**
 * The item the extension was driving RAN OUT.
 *
 * This is the extension-side counterpart of `PlayerAdapter.on('ended')`: when
 * the extension drives, no adapter exists on this page, so without this
 * subscription an extension-driven room never auto-advances at all.
 *
 * Fires once per item, and NOT de-duplicated on either side (see
 * {@link EndedPayload}) — match `payload.mediaKey` against
 * {@link extensionMediaKey} of what the room is playing before acting on it.
 */
export function onEnded(cb: (ended: EndedPayload) => void): () => void {
  return subscribe(endedListeners, cb);
}
