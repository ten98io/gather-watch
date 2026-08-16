'use client';

/**
 * useExtensionDriver — the room's view of "the extension is the player".
 *
 * This is the layer directly above `lib/extension-bridge.ts`. It owns:
 *
 *   - one detection pass per page (installed? compatible? what can it do?),
 *   - a discriminated state a component can render with no protocol knowledge,
 *   - whether the extension is *actually driving* right now, kept live from
 *     the bridge's status port,
 *   - the forced re-check the install funnel needs (docs/WEB_SLIMMING.md, "the
 *     room comes alive the moment the extension is added"),
 *   - handoff / intent / release, already turned into plain-language results.
 *
 * It deliberately does NOT: speak the wire protocol (the bridge does),
 * subscribe to telemetry (the sync engine owns that stream — one subscriber
 * per concern keeps the port's lifetime obvious), render anything, or decide
 * copy for the install funnel beyond the one sentence each state carries.
 *
 * ── Constraints a future reader would otherwise trip on ───────────────────
 *
 * The store is a module singleton on purpose. `detectExtension` memoises
 * globally and `{ force: true }` calls `resetExtensionBridge()`, which closes
 * the shared event port; two live stores would reset each other's detection
 * mid-flight. `createExtensionDriverStore` exists so tests get isolated
 * instances with short timeouts — not so the app can hold two.
 *
 * Detection never starts at import time or during render. It starts from
 * `subscribe`, which React calls in a passive effect, which is what keeps this
 * module SSR-clean: on the server `getServerSnapshot` answers `detecting` and
 * nothing else runs.
 *
 * `getServerSnapshot` must return the SAME object every call. Returning a
 * fresh literal makes React re-render forever.
 *
 * A forced re-check deliberately does NOT drop the UI back to `detecting`.
 * The last known phase stays on screen and `checking` goes true, so clicking
 * "I've installed it" does not flash the funnel away and back.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  DEFAULT_DETECT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  detectExtension,
  getExtensionStatus,
  handoffRoom,
  isExtensionChannelSupported,
  onStatus,
  parseExtensionIds,
  stopDriving,
  updateIntent,
} from '@/lib/extension-bridge';
import type {
  BridgeError,
  BridgeResult,
  ExtensionInfo,
  HandoffRoomInput,
  MediaIntent,
  ProtocolErrorCode,
  ProviderSummary,
  SessionStatus,
} from '@/lib/extension-bridge';

/* ════════════════════════════ user-facing copy ════════════════════════════ */

/**
 * Protocol code → a sentence. Same rule as lib/labels.ts: a raw code
 * ('API_ORIGIN_MISMATCH') must never reach the screen. This map lives here
 * rather than in labels.ts because it is the only consumer; move it there if a
 * second one appears.
 */
export const EXTENSION_ERROR_MESSAGE: Record<ProtocolErrorCode, string> = {
  UNSUPPORTED_VERSION: 'Your Playin extension is a different version — update it to keep watching.',
  UNSUPPORTED_TYPE: 'Your Playin extension is too old for this room — update it.',
  BAD_REQUEST: 'Playin couldn’t hand this room to the extension.',
  FORBIDDEN_ORIGIN: 'The extension didn’t accept this page — open the room from your Playin site.',
  API_ORIGIN_MISMATCH: 'That extension is set up for a different Playin server.',
  NOT_CONNECTED: 'The extension isn’t in this room yet.',
  INTERNAL: 'The extension ran into a problem.',
  NOT_INSTALLED: 'Playin plays through its browser extension — add it to watch together.',
  NO_RESPONSE: 'The extension didn’t answer — try again.',
  UNAVAILABLE: 'The extension isn’t available right now.',
};

/** Shown when a request fails for a reason we have no specific sentence for. */
const GENERIC_FAILURE = 'Playin couldn’t reach the extension.';

const NOT_INSTALLED_MESSAGE = EXTENSION_ERROR_MESSAGE.NOT_INSTALLED;
const UNSUPPORTED_BROWSER_MESSAGE =
  'This browser can’t run the Playin extension. Use Chrome on a computer, or the Playin app on your phone.';

/** Turn a bridge failure into something a person can read. */
export function describeExtensionError(error: BridgeError, fallback = GENERIC_FAILURE): string {
  const copy: string | undefined = EXTENSION_ERROR_MESSAGE[error.code];
  return copy ?? fallback;
}

/* ═══════════════════════════════ install link ═════════════════════════════ */

const CHROME_WEB_STORE_DETAIL = 'https://chromewebstore.google.com/detail/';

/**
 * Where the install funnel should send the user, or null when this build has
 * no id and no URL configured — render nothing rather than a dead link.
 *
 * Both lookups are literal `process.env.NEXT_PUBLIC_*` member accesses because
 * that is the only form Next inlines at build time.
 */
export function extensionInstallUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_PLAYIN_EXTENSION_INSTALL_URL;
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
  const id = parseExtensionIds(process.env.NEXT_PUBLIC_PLAYIN_EXTENSION_ID)[0];
  return id === undefined ? null : `${CHROME_WEB_STORE_DETAIL}${id}`;
}

/* ══════════════════════════════════ state ═════════════════════════════════ */

/** Why there is no driver: one of these is installable, the other is not. */
export type ExtensionUnavailableReason = 'not-installed' | 'unsupported-browser';

/** We do not know yet. Bounded — detection always settles. */
export interface ExtensionDriverDetecting {
  phase: 'detecting';
}

export interface ExtensionDriverUnavailable {
  phase: 'unavailable';
  reason: ExtensionUnavailableReason;
  message: string;
  installUrl: string | null;
  /** false where no extension can ever be installed (Safari, Firefox, phones). */
  canInstall: boolean;
}

export interface ExtensionDriverIncompatible {
  phase: 'incompatible';
  message: string;
  installedVersion: string | null;
  protocolVersion: number | null;
  installUrl: string | null;
}

export interface ExtensionDriverReady {
  phase: 'ready';
  extensionVersion: string | null;
  protocolVersion: number;
  capabilities: readonly string[];
  /** The extension is driving a tab right now. */
  driving: boolean;
  /** The extension has joined this room's sync stream. */
  connected: boolean;
  roomId: string | null;
  roomName: string | null;
  provider: ProviderSummary | null;
  hasMedia: boolean;
  /** A plain-language problem that does not change the phase. */
  notice: string | null;
}

export type ExtensionDriverState =
  | ExtensionDriverDetecting
  | ExtensionDriverUnavailable
  | ExtensionDriverIncompatible
  | ExtensionDriverReady;

export interface ExtensionDriverSnapshot {
  state: ExtensionDriverState;
  /** A detection pass is in flight. The state stays renderable throughout. */
  checking: boolean;
}

/** Result of an action, already translated. Never carries a protocol code. */
export type ExtensionActionResult = { ok: true } | { ok: false; message: string };

/**
 * Capability strings the extension advertises (apps/extension/src/protocol.ts
 * EXTENSION_CAPABILITIES). A convenience against typos, not a gate — an
 * unknown string simply never matches.
 */
export const EXTENSION_CAPABILITY = {
  handoff: 'handoff',
  telemetry: 'telemetry',
  capability: 'capability',
  release: 'release',
  modeB: 'modeB',
  modeBDesktop: 'modeB.desktop',
} as const;

/* ═══════════════════════════════ wire reading ═════════════════════════════ */

function isRecord(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

/** Port events are unvalidated at the bridge boundary; normalise here. */
function readProvider(raw: unknown): ProviderSummary | null {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) return null;
  return {
    id,
    name: typeof raw['name'] === 'string' ? raw['name'] : id,
    tier: typeof raw['tier'] === 'string' ? raw['tier'] : 'generic',
  };
}

function readSession(raw: unknown): SessionStatus {
  const r = isRecord(raw) ? raw : {};
  return {
    connected: r['connected'] === true,
    roomId: typeof r['roomId'] === 'string' ? r['roomId'] : null,
    roomName: typeof r['roomName'] === 'string' ? r['roomName'] : null,
    driving: r['driving'] === true,
    provider: readProvider(r['provider']),
    hasMedia: r['hasMedia'] === true,
  };
}

function sameProvider(a: ProviderSummary | null, b: ProviderSummary | null): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && a.name === b.name && a.tier === b.tier;
}

/** Status pings are frequent enough that re-rendering on an identical one is
 *  waste; identity of the snapshot is what React watches. */
function sessionUnchanged(state: ExtensionDriverReady, session: SessionStatus): boolean {
  return (
    state.connected === session.connected &&
    state.driving === session.driving &&
    state.roomId === session.roomId &&
    state.roomName === session.roomName &&
    state.hasMedia === session.hasMedia &&
    sameProvider(state.provider, session.provider) &&
    state.notice === null
  );
}

/* ══════════════════════════════════ store ═════════════════════════════════ */

export const DEFAULT_STATUS_TIMEOUT_MS = 2500;

const SERVER_SNAPSHOT: ExtensionDriverSnapshot = { state: { phase: 'detecting' }, checking: true };

export interface ExtensionDriverStoreOptions {
  /** Bound on one detection pass. Tests shorten it; the UI never waits long. */
  detectTimeoutMs?: number;
  /** Bound on the follow-up `status` probe. Shorter than the bridge default
   *  because by then the phase is already rendered — this only refines it. */
  statusTimeoutMs?: number;
}

export interface ExtensionDriverStore {
  getSnapshot: () => ExtensionDriverSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Re-detect with `{ force: true }`. Safe to call at any time. */
  refresh: () => void;
  handoff: (input: HandoffRoomInput) => Promise<ExtensionActionResult>;
  sendIntent: (intent: MediaIntent) => Promise<ExtensionActionResult>;
  release: () => Promise<ExtensionActionResult>;
  /** Drop listeners, the status port and any in-flight pass. Tests/teardown. */
  dispose: () => void;
}

export function createExtensionDriverStore(
  options: ExtensionDriverStoreOptions = {},
): ExtensionDriverStore {
  const detectTimeoutMs = options.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
  const statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;

  const listeners = new Set<() => void>();
  let snapshot: ExtensionDriverSnapshot = SERVER_SNAPSHOT;
  let generation = 0;
  let inFlight = false;
  let queuedForce = false;
  let started = false;
  let disposed = false;
  let offStatus: (() => void) | null = null;

  function getSnapshot(): ExtensionDriverSnapshot {
    return snapshot;
  }

  function setState(state: ExtensionDriverState, checking: boolean): void {
    if (disposed) return;
    if (snapshot.state === state && snapshot.checking === checking) return;
    snapshot = { state, checking };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One bad subscriber must not stop the others.
      }
    }
  }

  function unavailableState(): ExtensionDriverUnavailable {
    const canInstall = isExtensionChannelSupported();
    return {
      phase: 'unavailable',
      reason: canInstall ? 'not-installed' : 'unsupported-browser',
      message: canInstall ? NOT_INSTALLED_MESSAGE : UNSUPPORTED_BROWSER_MESSAGE,
      installUrl: canInstall ? extensionInstallUrl() : null,
      canInstall,
    };
  }

  function stateFromInfo(info: ExtensionInfo): ExtensionDriverState {
    if (!info.installed) return unavailableState();
    if (info.compatible === false) {
      return {
        phase: 'incompatible',
        message: EXTENSION_ERROR_MESSAGE.UNSUPPORTED_VERSION,
        installedVersion: info.version ?? null,
        protocolVersion: info.protocolVersion ?? null,
        installUrl: extensionInstallUrl(),
      };
    }
    // Carry the live session across a re-check of the same build, so a forced
    // refresh does not blink "not driving" for one round-trip.
    const previous = snapshot.state;
    const version = info.version ?? null;
    const carry =
      previous.phase === 'ready' && previous.extensionVersion === version ? previous : null;
    return {
      phase: 'ready',
      extensionVersion: version,
      protocolVersion: info.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: info.capabilities ?? [],
      driving: carry?.driving ?? false,
      connected: carry?.connected ?? false,
      roomId: carry?.roomId ?? null,
      roomName: carry?.roomName ?? null,
      provider: carry?.provider ?? null,
      hasMedia: carry?.hasMedia ?? false,
      notice: null,
    };
  }

  function applySession(session: SessionStatus): void {
    const current = snapshot.state;
    if (current.phase !== 'ready') return;
    if (sessionUnchanged(current, session)) return;
    setState(
      {
        ...current,
        connected: session.connected,
        driving: session.driving,
        roomId: session.roomId,
        roomName: session.roomName,
        provider: session.provider,
        hasMedia: session.hasMedia,
        notice: null,
      },
      snapshot.checking,
    );
  }

  function noteOnReady(message: string): void {
    const current = snapshot.state;
    if (current.phase !== 'ready' || current.notice === message) return;
    setState({ ...current, notice: message }, snapshot.checking);
  }

  /** A mid-session refusal that means the *phase* was wrong, not just the call. */
  function demote(code: ProtocolErrorCode): boolean {
    const current = snapshot.state;
    if (code === 'NOT_INSTALLED') {
      setState(unavailableState(), snapshot.checking);
      detachStatus();
      return true;
    }
    if (code === 'UNSUPPORTED_VERSION') {
      setState(
        {
          phase: 'incompatible',
          message: EXTENSION_ERROR_MESSAGE.UNSUPPORTED_VERSION,
          installedVersion: current.phase === 'ready' ? current.extensionVersion : null,
          protocolVersion: current.phase === 'ready' ? current.protocolVersion : null,
          installUrl: extensionInstallUrl(),
        },
        snapshot.checking,
      );
      detachStatus();
      return true;
    }
    return false;
  }

  function attachStatus(): void {
    if (disposed || offStatus !== null || listeners.size === 0) return;
    if (snapshot.state.phase !== 'ready') return;
    offStatus = onStatus((status) => {
      applySession(readSession(status));
    });
  }

  function detachStatus(): void {
    if (offStatus === null) return;
    const off = offStatus;
    offStatus = null;
    // The bridge closes the shared event port once its last listener leaves.
    off();
  }

  async function probeStatus(token: number): Promise<void> {
    const res = await getExtensionStatus({ timeoutMs: statusTimeoutMs });
    if (disposed || token !== generation) return;
    applyResult(res);
  }

  function applyResult(res: BridgeResult<SessionStatus>): ExtensionActionResult {
    if (res.ok) {
      applySession(readSession(res.value));
      return { ok: true };
    }
    const message = describeExtensionError(res.error);
    if (!demote(res.error.code)) noteOnReady(message);
    return { ok: false, message };
  }

  async function pass(force: boolean, token: number): Promise<void> {
    // A forced re-check calls resetExtensionBridge(), which disconnects the
    // shared event port — and the bridge only opens a port when a listener is
    // ADDED, so a listener registered before the reset is left on a dead port
    // with no reconnect. Drop ours here and re-attach below, or status stops
    // flowing silently the moment the user clicks "check again".
    if (force) detachStatus();
    let next: ExtensionDriverState;
    try {
      const info = await detectExtension(
        force ? { force: true, timeoutMs: detectTimeoutMs } : { timeoutMs: detectTimeoutMs },
      );
      next = stateFromInfo(info);
    } catch {
      // detectExtension already swallows its own failures; belt and braces so
      // the UI can never be stranded on a spinner.
      next = unavailableState();
    }
    inFlight = false;
    if (disposed || token !== generation) return;
    setState(next, false);
    if (next.phase === 'ready') {
      attachStatus();
      void probeStatus(token);
    } else {
      detachStatus();
    }
    if (queuedForce) {
      queuedForce = false;
      begin(true);
    }
  }

  function begin(force: boolean): void {
    if (disposed) return;
    if (inFlight) {
      // A recheck asked for during a pass must not be lost — the user may have
      // installed the extension while the first pass was still running.
      if (force) queuedForce = true;
      return;
    }
    inFlight = true;
    generation += 1;
    const token = generation;
    setState(snapshot.state, true);
    void pass(force, token);
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (!started) {
      started = true;
      begin(false);
    } else {
      attachStatus();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) detachStatus();
    };
  }

  async function handoff(input: HandoffRoomInput): Promise<ExtensionActionResult> {
    return applyResult(await handoffRoom(input));
  }

  async function sendIntent(intent: MediaIntent): Promise<ExtensionActionResult> {
    return applyResult(await updateIntent(intent));
  }

  async function release(): Promise<ExtensionActionResult> {
    return applyResult(await stopDriving());
  }

  function dispose(): void {
    disposed = true;
    // Orphans any in-flight pass: its token can no longer match.
    generation += 1;
    inFlight = false;
    queuedForce = false;
    detachStatus();
    listeners.clear();
  }

  return {
    getSnapshot,
    subscribe,
    refresh: () => {
      begin(true);
    },
    handoff,
    sendIntent,
    release,
    dispose,
  };
}

/* ═══════════════════════════════════ hook ═════════════════════════════════ */

let shared: ExtensionDriverStore | null = null;

/** The one store the app uses. Created lazily — nothing runs at import time. */
export function extensionDriverStore(): ExtensionDriverStore {
  shared ??= createExtensionDriverStore();
  return shared;
}

function getServerSnapshot(): ExtensionDriverSnapshot {
  return SERVER_SNAPSHOT;
}

export interface ExtensionDriver {
  /** Render this directly; its identity only changes when something changed. */
  state: ExtensionDriverState;
  /** A detection pass is running. `state` stays renderable meanwhile. */
  checking: boolean;
  ready: boolean;
  /** The extension is driving playback right now. */
  driving: boolean;
  /** Re-check after an install prompt. Result arrives through `state`. */
  refresh: () => void;
  supports: (capability: string) => boolean;
  handoff: (input: HandoffRoomInput) => Promise<ExtensionActionResult>;
  sendIntent: (intent: MediaIntent) => Promise<ExtensionActionResult>;
  release: () => Promise<ExtensionActionResult>;
}

/**
 * Subscribe a component to the extension driver.
 *
 * Renders `detecting` on the server and on the first client paint, then
 * settles to `unavailable` / `incompatible` / `ready` within
 * `DEFAULT_DETECT_TIMEOUT_MS`. Every listener, timer and port is released on
 * unmount; the detection answer itself is cached, so a remount is instant.
 */
export function useExtensionDriver(): ExtensionDriver {
  const store = extensionDriverStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);

  const supports = useCallback(
    (capability: string): boolean =>
      snapshot.state.phase === 'ready' && snapshot.state.capabilities.includes(capability),
    [snapshot],
  );

  return useMemo(
    () => ({
      state: snapshot.state,
      checking: snapshot.checking,
      ready: snapshot.state.phase === 'ready',
      driving: snapshot.state.phase === 'ready' && snapshot.state.driving,
      refresh: store.refresh,
      supports,
      handoff: store.handoff,
      sendIntent: store.sendIntent,
      release: store.release,
    }),
    [snapshot, store, supports],
  );
}
