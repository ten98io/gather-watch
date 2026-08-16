/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE WEB ↔ EXTENSION HANDOFF CHANNEL — security boundary
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An externally-connectable extension is an attack surface: any page the
 * manifest lists can send it messages, and the extension runs with
 * `<all_urls>` host permissions. Everything below exists to make that
 * asymmetry safe. `protocol.ts` decides what is *well-formed*; this module
 * decides what is *allowed*.
 *
 * ── Trust ──────────────────────────────────────────────────────────────────
 * Trusted (browser-populated, unforgeable by the page):
 *   `sender.origin`, `sender.url`, `sender.tab.id`, `port.sender.*`.
 * Untrusted (anything inside `message`): every field, including any field
 *   that *claims* to be an origin, a URL, a tab id or a token audience.
 *
 * ── Threat model ───────────────────────────────────────────────────────────
 *
 * T1. A malicious site messages the extension to drive the user's tabs.
 *     → Two independent gates. The manifest's `externally_connectable.matches`
 *       is the browser-level gate (explicit hosts, no `*.gather.watch` wildcard,
 *       dev localhost pinned to :3000). `screenExternal` re-checks
 *       `sender.origin` against `WEB_ORIGINS` on EVERY message and EVERY port
 *       connect — not once at connect time, not cached per port. A manifest
 *       edit alone can never widen the real allowlist.
 *
 * T2. The page lies about its origin (`{origin:'https://gather.watch'}` in the
 *     payload) to pass the check.
 *     → Payload origins are never read. Only `sender.origin` is, and Chrome
 *       sets it. When absent (pre-Chrome-80) we derive it from `sender.url`,
 *       which is equally browser-populated.
 *
 * T3. The page redirects the room token to an attacker endpoint by sending
 *     `apiOrigin: 'https://evil.example'`.
 *     → `apiOrigin` is a *checked-and-discarded* field: it must equal the
 *       build-time `API_ORIGIN` (src/config.ts) or the handoff is refused,
 *       and it is never propagated to a handler. Every request the extension
 *       makes with the token is built from `API_URL`, a build-time constant.
 *       The token therefore cannot reach any other host.
 *
 * T4. The page turns the extension into a fetch proxy / SSRF gadget
 *     ("fetch this URL for me with your host permissions").
 *     → No message type takes a URL to fetch. The only page-supplied URL in
 *       the protocol is `intent.contentUrl`, which is scheme-restricted to
 *       http(s) at decode time and is passed to exactly one function,
 *       `providerForUrl` (a pure regex classifier). It is never fetched,
 *       never navigated to, never used to build an API path.
 *
 * T5. The page exfiltrates the token, cookies, or other origins' data.
 *     → No response payload ever contains the access token, a cookie, or any
 *       credential; `SessionStatus` carries ids and booleans only. The
 *       extension requests no `cookies` permission. Tokens live in memory and
 *       in `chrome.storage.session`, whose default access level is
 *       TRUSTED_CONTEXTS — content scripts cannot read it.
 *
 * T6. The page harvests browsing history ("what is in the user's other tabs?").
 *     → Capability answers disclose a *redacted* provider only
 *       (`redactProvider`): known ids from a fixed public list, or the
 *       constant 'This page'. A raw hostname, URL or tab title never crosses
 *       the boundary, and no message returns a tab list.
 *
 * T7. The page picks the victim tab (`{tabId: 42}`) to drive an unrelated tab.
 *     → Tab ids are never accepted from the page. `target` chooses between
 *       browser-derived targets only: 'sender' (`sender.tab.id`) or 'auto'
 *       (the last content tab the *user* focused, tracked by the background
 *       from `chrome.tabs` events).
 *
 * T8. The page injects code ("run this selector/script on netflix.com").
 *     → Nothing here evals, `new Function`s, or passes page data to
 *       `chrome.scripting`. The content script's behaviour is fixed at build
 *       time; the protocol carries data, never behaviour.
 *
 * T9. Prototype pollution / clone tricks through the message object.
 *     → Payloads are read by explicit property access and copied into freshly
 *       built literals; no page-supplied key is ever used as an assignment
 *       target. Messages arrive via structured clone (no `JSON.parse`
 *       reviver, no getters survive).
 *
 * T10. Flooding / resource exhaustion.
 *     → Unknown types are refused before any handler runs; strings are
 *       length-capped at decode; the event-port registry is capped at
 *       MAX_EVENT_PORTS and drops the oldest port rather than growing.
 *
 * T11. Fingerprinting by a non-allowlisted origin ("is Gather installed?").
 *     → Refused origins get *silence*, not an error reply. Only allowlisted
 *       origins learn that the extension exists.
 *
 * A note on what is deliberately NOT here: there is no "run arbitrary
 * command", no "open URL", no "read storage" and no "list tabs" message. The
 * protocol's surface is the security surface, so it stays small.
 */

import { API_ORIGIN, WEB_ORIGINS } from './config';
import {
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  decodeRequest,
  errorResponse,
  negotiateVersion,
  originOf,
  parseEventPortName,
  readEnvelope,
  supportedRange,
} from './protocol';
import type {
  CapabilityResult,
  HandoffTarget,
  HelloResult,
  MediaIntent,
  ProtocolErrorResponse,
  ProtocolEventMessage,
  ProtocolRequest,
  SessionStatus,
} from './protocol';

/** Ports are cheap but not free; a page that leaks connects cannot grow this. */
export const MAX_EVENT_PORTS = 8;

/* ───────────────────────────── origin policy ─────────────────────────── */

/** The browser-populated part of a sender we are willing to look at. */
export interface TrustedSender {
  origin?: string | undefined;
  url?: string | undefined;
  tab?: { id?: number | undefined } | undefined;
}

/**
 * Resolve the sender's real origin. Prefers `sender.origin` (Chrome 80+),
 * falls back to the origin of `sender.url` — both are set by the browser.
 * Returns null for opaque/unparseable senders, which then fail the allowlist.
 */
export function senderOrigin(sender: TrustedSender): string | null {
  const direct = typeof sender.origin === 'string' ? sender.origin.toLowerCase() : null;
  if (direct !== null && direct.length > 0 && direct !== 'null') {
    // `sender.origin` is already a serialised origin; normalise via URL so a
    // trailing slash or odd casing cannot slip past a string compare.
    return originOf(direct) ?? null;
  }
  return originOf(sender.url);
}

/** Exact-match origin allowlist. No wildcards, no suffix matching, ever. */
export function isAllowedOrigin(origin: string | null): boolean {
  if (origin === null) return false;
  return WEB_ORIGINS.includes(origin);
}

/* ─────────────────────────────── host port ───────────────────────────── */

/** Validated handoff, with `apiOrigin` already checked and dropped. */
export interface HandoffInput {
  roomId: string;
  roomName: string | null;
  accessToken: string;
  intent: MediaIntent | null;
  target: HandoffTarget;
  /** Browser-derived; null when the message did not come from a tab. */
  senderTabId: number | null;
}

/**
 * Throw this from a host method to answer with a specific protocol code
 * instead of the catch-all INTERNAL. Messages are surfaced to the page, so
 * they must stay free of tokens and of any other origin's data.
 */
export class ProtocolFault extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolFault';
    this.code = code;
  }
}

/** What the background worker must provide for the channel to do anything. */
export interface ExternalHost {
  hello(): HelloResult;
  status(): SessionStatus;
  capability(): Promise<CapabilityResult>;
  handoff(input: HandoffInput): Promise<SessionStatus>;
  intent(intent: MediaIntent): Promise<SessionStatus>;
  release(): Promise<SessionStatus>;
}

/* ─────────────────────────────── screening ───────────────────────────── */

export type ScreenResult =
  /** Not a Gather message — stay silent, leave the channel to its owner. */
  | { action: 'ignore'; reason: string }
  /** Refused. `response` null means refuse silently (see T11). */
  | { action: 'reject'; reason: string; response: ProtocolErrorResponse | null }
  | {
      action: 'handle';
      v: number;
      id: string;
      origin: string;
      senderTabId: number | null;
      request: ProtocolRequest;
    };

/**
 * The whole gate, in one pure function: envelope → origin → version →
 * payload → policy. Nothing reaches a handler that has not passed all five.
 *
 * Order matters. The envelope is read first only so that a refusal can be
 * correlated by the caller; reading it is pure and side-effect-free. Origin
 * is checked before anything is *decoded*, and long before anything is *done*.
 */
export function screenExternal(raw: unknown, sender: TrustedSender): ScreenResult {
  const envelope = readEnvelope(raw);
  if (envelope === null) return { action: 'ignore', reason: 'not-a-gather-envelope' };

  const origin = senderOrigin(sender);
  if (origin === null || !isAllowedOrigin(origin)) {
    // Silence, not an error: a non-allowlisted page must not even learn that
    // this extension is installed (T11).
    return { action: 'reject', reason: 'forbidden-origin', response: null };
  }

  const v = negotiateVersion(envelope.v);
  if (v === null) {
    return {
      action: 'reject',
      reason: 'unsupported-version',
      response: errorResponse(
        PROTOCOL_VERSION,
        envelope.id,
        ProtocolErrorCode.UnsupportedVersion,
        `protocol v${String(envelope.v)} is not supported`,
        supportedRange(),
      ),
    };
  }

  const decoded = decodeRequest(envelope.type, envelope.payload);
  if (!decoded.ok) {
    return {
      action: 'reject',
      reason: decoded.code,
      response: errorResponse(v, envelope.id, decoded.code, decoded.message),
    };
  }

  // T3: the token may only ever travel to the build-time API origin. The
  // page's claim is compared, then discarded — never adopted.
  if (decoded.request.type === 'handoff') {
    const claimed = originOf(decoded.request.payload.apiOrigin);
    if (claimed === null || claimed !== API_ORIGIN) {
      return {
        action: 'reject',
        reason: 'api-origin-mismatch',
        response: errorResponse(
          v,
          envelope.id,
          ProtocolErrorCode.ApiOriginMismatch,
          'this extension build talks to a different API origin',
        ),
      };
    }
  }

  return {
    action: 'handle',
    v,
    id: envelope.id,
    origin,
    senderTabId: typeof sender.tab?.id === 'number' ? sender.tab.id : null,
    request: decoded.request,
  };
}

/* ─────────────────────────────── dispatch ────────────────────────────── */

/**
 * Run a screened request. Pure dispatch — the caller turns a rejection into a
 * typed INTERNAL response (it holds the negotiated version and request id),
 * because an unanswered request in a service worker is a hung web UI.
 */
export async function runScreenedRequest(
  screened: Extract<ScreenResult, { action: 'handle' }>,
  host: ExternalHost,
): Promise<unknown> {
  const { request } = screened;
  switch (request.type) {
    case 'hello':
      return host.hello();
    case 'status':
      return host.status();
    case 'capability':
      return host.capability();
    case 'handoff': {
      const p = request.payload;
      return host.handoff({
        roomId: p.roomId,
        roomName: p.roomName,
        accessToken: p.accessToken,
        intent: p.intent,
        target: p.target,
        senderTabId: screened.senderTabId,
      });
    }
    case 'intent':
      return host.intent(request.payload.intent);
    case 'release':
      return host.release();
  }
}

/* ────────────────────────────── event ports ──────────────────────────── */

/** Structural view of `chrome.runtime.Port` (keeps this module testable). */
export interface EventPortLike {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onDisconnect: { addListener(callback: () => void): void };
}

export type PortScreenResult =
  | { ok: true; v: number }
  | { ok: false; reason: string; silent: boolean };

/**
 * Same gate as messages, applied to a `runtime.connect` from a page. The
 * origin is checked here AND on every message the port's owner sends —
 * a port is not a standing grant.
 */
export function screenEventPort(name: string, sender: TrustedSender): PortScreenResult {
  const origin = senderOrigin(sender);
  if (!isAllowedOrigin(origin)) return { ok: false, reason: 'forbidden-origin', silent: true };
  const requested = parseEventPortName(name);
  if (requested === null) return { ok: false, reason: 'foreign-port-name', silent: true };
  const v = negotiateVersion(requested);
  if (v === null) return { ok: false, reason: 'unsupported-version', silent: false };
  return { ok: true, v };
}

/**
 * Registry of live event ports. Bounded (T10); a port that throws on
 * postMessage (page navigated away mid-send) is dropped, never retried.
 */
export class EventPortRegistry {
  private readonly ports: Array<{ port: EventPortLike; v: number }> = [];

  get size(): number {
    return this.ports.length;
  }

  add(port: EventPortLike, v: number): void {
    while (this.ports.length >= MAX_EVENT_PORTS) {
      const oldest = this.ports.shift();
      try {
        oldest?.port.disconnect();
      } catch {
        // Already gone.
      }
    }
    this.ports.push({ port, v });
    port.onDisconnect.addListener(() => {
      this.remove(port);
    });
  }

  remove(port: EventPortLike): void {
    const i = this.ports.findIndex((p) => p.port === port);
    if (i >= 0) this.ports.splice(i, 1);
  }

  /** Fan an event out to every live port, at that port's negotiated version. */
  broadcast(build: (v: number) => ProtocolEventMessage): void {
    for (const entry of [...this.ports]) {
      try {
        entry.port.postMessage(build(entry.v));
      } catch {
        this.remove(entry.port);
      }
    }
  }

  closeAll(): void {
    for (const entry of [...this.ports]) {
      try {
        entry.port.disconnect();
      } catch {
        // Already gone.
      }
      this.remove(entry.port);
    }
  }
}
