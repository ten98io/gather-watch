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
 *   - handoff / intent / release, already turned into plain-language results,
 *   - and, in its own store, WHAT THE DRIVEN PLAYER IS DOING — position,
 *     length, and what the source can honestly be said to support.
 *
 * It deliberately does NOT: speak the wire protocol (the bridge does), render
 * anything, or decide copy for the install funnel beyond the one sentence each
 * state carries.
 *
 * WHY TELEMETRY IS A SECOND STORE AND NOT A FIELD ON THIS ONE. Telemetry
 * arrives about once a second while a tab is driven; session status changes
 * perhaps twice a session. Folding the numbers into `ExtensionDriverSnapshot`
 * would re-render every consumer of `useExtensionDriver` — the stage shell and
 * the transport bar — at 1 Hz for a value most of them never read. Two stores,
 * one shared port (the bridge owns the port's lifetime and counts listeners
 * across both), so a component subscribes to the concern it renders.
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
  onCapability,
  onStatus,
  onTelemetry,
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
  TelemetryPayload,
} from '@/lib/extension-bridge';
import { providerById } from '@/lib/providers';
import type { ProviderCapability } from '@/lib/providers';

/* ════════════════════════════ user-facing copy ════════════════════════════ */

/**
 * Protocol code → a sentence. Same rule as lib/labels.ts: a raw code
 * ('API_ORIGIN_MISMATCH') must never reach the screen. This map lives here
 * rather than in labels.ts because it is the only consumer; move it there if a
 * second one appears.
 */
export const EXTENSION_ERROR_MESSAGE: Record<ProtocolErrorCode, string> = {
  UNSUPPORTED_VERSION: 'Your Gather extension is a different version — update it to keep watching.',
  UNSUPPORTED_TYPE: 'Your Gather extension is too old for this room — update it.',
  BAD_REQUEST: 'Gather couldn’t hand this room to the extension.',
  FORBIDDEN_ORIGIN: 'The extension didn’t accept this page — open the room from your Gather site.',
  API_ORIGIN_MISMATCH: 'That extension is set up for a different Gather server.',
  NOT_CONNECTED: 'The extension isn’t in this room yet.',
  INTERNAL: 'The extension ran into a problem.',
  NOT_INSTALLED: 'Gather plays through its browser extension — add it to watch together.',
  NO_RESPONSE: 'The extension didn’t answer — try again.',
  UNAVAILABLE: 'The extension isn’t available right now.',
};

/** Shown when a request fails for a reason we have no specific sentence for. */
const GENERIC_FAILURE = 'Gather couldn’t reach the extension.';

const NOT_INSTALLED_MESSAGE = EXTENSION_ERROR_MESSAGE.NOT_INSTALLED;
const UNSUPPORTED_BROWSER_MESSAGE =
  'This browser can’t run the Gather extension. Use Chrome on a computer, or the Gather app on your phone.';

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
  const configured = process.env.NEXT_PUBLIC_GATHER_EXTENSION_INSTALL_URL;
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
  const id = parseExtensionIds(process.env.NEXT_PUBLIC_GATHER_EXTENSION_ID)[0];
  return id === undefined ? null : `${CHROME_WEB_STORE_DETAIL}${id}`;
}

/* ═══════════════════════ can this browser install it? ════════════════════ */

/**
 * Phones and tablets. Chromium ships there with no extension surface at all,
 * and `CriOS` (Chrome on iOS) is WebKit underneath — both are caught here
 * before the Chromium test below can call them installable.
 */
const HANDHELD_UA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i;

/** Every desktop Chromium build names itself in the agent string; Safari and
 *  Firefox never do. Edge (`Edg/`) and Opera (`OPR/`) also carry `Chrome/`,
 *  but matching them directly survives a future build that drops it. */
const CHROMIUM_UA = /(?:Chrome|Chromium|Edg|OPR)\/\d/;

function browserNavigator(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null;
  const nav = (window as unknown as { navigator?: unknown }).navigator;
  return isRecord(nav) ? nav : null;
}

/** Client Hints brands are Chromium-only, and always list Chromium itself
 *  alongside the vendor brand and the deliberately-fake padding brand. */
function brandsSayChromium(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((entry: unknown) => {
    if (!isRecord(entry)) return false;
    const brand = entry['brand'];
    return typeof brand === 'string' && /Chrom/i.test(brand);
  });
}

/**
 * Whether the extension could be added here at all — the difference between
 * showing the install link and telling the user their browser cannot run it.
 *
 * This must NOT be `isExtensionChannelSupported()` (i.e. `chrome.runtime`).
 * That object is injected into a page only by an already-installed extension
 * that lists this origin in `externally_connectable`; on ordinary desktop
 * Chrome with nothing installed it is undefined. Its absence is therefore
 * evidence about the *extension*, never about the browser — reading it the
 * other way told every single person the install funnel exists to convert
 * "this browser can’t run Gather" and hid the link from them.
 *
 * Its presence is still evidence, in the one direction it can be: a browser
 * that injects an extension channel plainly hosts extensions.
 *
 * Otherwise the user agent is all a page can know about the browser family
 * before any extension exists. It can be spoofed, and it cannot see an
 * enterprise policy that blocks the Web Store, so this answer is approximate
 * by construction — but it is approximate about the browser, which is the
 * question, instead of exact about something else.
 */
export function canInstallExtension(): boolean {
  if (isExtensionChannelSupported()) return true;
  const nav = browserNavigator();
  if (nav === null) return false; // No window, or no navigator: claim nothing.
  const rawData = nav['userAgentData'];
  const data = isRecord(rawData) ? rawData : null;
  const ua = typeof nav['userAgent'] === 'string' ? nav['userAgent'] : '';
  if (data?.['mobile'] === true) return false;
  if (HANDHELD_UA.test(ua)) return false;
  if (data !== null && brandsSayChromium(data['brands'])) return true;
  return CHROMIUM_UA.test(ua);
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
    const canInstall = canInstallExtension();
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

/* ═════════════════════ what the driven player is doing ════════════════════ */

/**
 * The driven tab's own numbers, and what its source can honestly do.
 *
 * THIS IS THE WEB'S TRANSPORT WHILE THE EXTENSION DRIVES. When the extension
 * is the driver this page builds no adapter at all (StagePane nulls the adapter
 * kind), so every reading `PlayerControls` normally takes from a
 * `PlayerAdapter` — position, length, playing — has no source. The extension
 * has been streaming all of it once a second the whole time; it reached
 * `onTelemetry` and stopped there, with no caller, which is why an
 * extension-driven room showed a frozen counter, 00:00 for the length and a
 * scrubber that could not move.
 *
 * `positionMs` is the raw last reading, NOT a live clock: read it through
 * {@link extensionPositionMs}, which projects it forward the way the
 * extension's own driver does. A component that renders this field directly
 * shows a value that steps once a second and freezes whenever the tab stops
 * reporting.
 */
export interface ExtensionPlayback {
  /** The provider of the driven tab, or null when nothing is being driven. */
  provider: ProviderSummary | null;
  /**
   * This app's own honesty tier for that provider (lib/providers.ts).
   *
   * DERIVED FROM THE ID, NOT FROM THE WIRE. `ProviderSummary.tier` is the
   * extension's LEGACY vocabulary ('api' | 'drm' | 'generic', see `tierFor` in
   * apps/extension/src/providers.ts) and does not name the same axis. The two
   * registries carry the same ids on purpose, so the id is what we look up; a
   * provider this build has never heard of is 'generic', which is exactly what
   * an unrecognised host is.
   */
  capability: ProviderCapability;
  /** Protected media: never capture, mirror or re-encode it (docs/
   *  EXTENSION_FIRST.md Part 3). The wire tier is the only DRM signal that
   *  crosses the channel; the registry's 'extension' tier means the same thing
   *  for the services that have no embed at all. */
  drm: boolean;
  /** Position at `updatedAt` — project it, do not render it. 0 = nothing yet. */
  positionMs: number;
  /** The item's length. 0 = not known (and a live stream reads as 0: the
   *  content script sends 0 rather than Infinity, which no JSON channel could
   *  carry intact anyway). */
  durationMs: number;
  playing: boolean;
  rate: number;
  /** Extension-side `Date.now()` when the reading was CAPTURED — same machine,
   *  same clock, so it is comparable with ours. 0 = no frame has arrived. */
  updatedAt: number;
}

/**
 * Nothing is being driven. Frozen and shared so it is also a stable
 * `getServerSnapshot` answer — a fresh literal per call re-renders forever.
 */
export const NO_EXTENSION_PLAYBACK: ExtensionPlayback = Object.freeze({
  provider: null,
  capability: 'generic' as ProviderCapability,
  drm: false,
  positionMs: 0,
  durationMs: 0,
  playing: false,
  rate: 1,
  updatedAt: 0,
});

/**
 * How old a reading may be and still describe now. Mirrors the extension's own
 * `TELEMETRY_STALE_MS` (apps/extension/src/driver.ts) against a 1 Hz reporter:
 * four missed frames is a tab that has stopped talking, not one that is late.
 */
export const EXTENSION_TELEMETRY_STALE_MS = 4000;

/** Is the driven tab still reporting? False freezes the transport rather than
 *  letting it run on a reading from a minute ago. */
export function extensionTelemetryLive(playback: ExtensionPlayback, nowMs: number): boolean {
  return playback.updatedAt > 0 && nowMs - playback.updatedAt <= EXTENSION_TELEMETRY_STALE_MS;
}

/**
 * Where the driven player is NOW.
 *
 * The reading crossed a process boundary and the player kept playing while it
 * travelled, so the raw field is always a little behind — at 1 Hz, by up to a
 * second. Projecting at the rate it was running is the same correction the
 * extension's driver applies to its own samples (`projectedPositionMs`), and it
 * is what turns a value that steps once a second into a counter that moves.
 *
 * A stale or paused reading is not projected: it is reported as it stands,
 * because a counter that keeps climbing after the tab went quiet is a lie about
 * a player nobody is watching.
 */
export function extensionPositionMs(playback: ExtensionPlayback, nowMs: number): number {
  if (!playback.playing || !extensionTelemetryLive(playback, nowMs)) return playback.positionMs;
  const projected = playback.positionMs + Math.max(0, nowMs - playback.updatedAt) * playback.rate;
  // No item plays past its own end — the same terminal state the drift
  // controller applies to the room's projection.
  return playback.durationMs > 0 ? Math.min(projected, playback.durationMs) : projected;
}

/** A length only counts once a player has really measured it: 0 is "not known"
 *  everywhere in this app, and a live stream never had one to give. */
function readDuration(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function sameTelemetry(a: ExtensionPlayback, b: TelemetryPayload): boolean {
  return (
    a.positionMs === b.positionMs &&
    a.durationMs === readDuration(b.durationMs) &&
    a.playing === b.playing &&
    a.rate === b.rate &&
    a.updatedAt === b.at
  );
}

export interface ExtensionPlaybackStore {
  getSnapshot: () => ExtensionPlayback;
  /** React subscription (`useSyncExternalStore`). */
  subscribe: (listener: () => void) => () => void;
  /** Value subscription for code that must not re-render on every frame — the
   *  sync engine's duration report reads the stream this way. */
  observe: (cb: (playback: ExtensionPlayback) => void) => () => void;
  /** Drop listeners and the bridge subscriptions. Tests/teardown. */
  dispose: () => void;
}

/**
 * Isolated instance for tests. The app holds exactly one (see
 * {@link extensionPlaybackStore}) for the same reason the driver store is a
 * singleton: the bridge's event port is shared and counts listeners globally.
 */
export function createExtensionPlaybackStore(): ExtensionPlaybackStore {
  const listeners = new Set<() => void>();
  let snapshot: ExtensionPlayback = NO_EXTENSION_PLAYBACK;
  let offTelemetry: (() => void) | null = null;
  let offCapability: (() => void) | null = null;
  let disposed = false;

  function publish(next: ExtensionPlayback): void {
    if (disposed) return;
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One bad subscriber must not stop the others, or stall the stream.
      }
    }
  }

  function attach(): void {
    if (disposed || offTelemetry !== null || listeners.size === 0) return;
    offTelemetry = onTelemetry((t) => {
      // Identical frames arrive once a second from a paused tab; re-publishing
      // one would re-render every subscriber for no change at all.
      if (sameTelemetry(snapshot, t)) return;
      publish({
        ...snapshot,
        positionMs: Number.isFinite(t.positionMs) && t.positionMs > 0 ? t.positionMs : 0,
        durationMs: readDuration(t.durationMs),
        playing: t.playing,
        rate: Number.isFinite(t.rate) && t.rate > 0 ? t.rate : 1,
        updatedAt: t.at,
      });
    });
    offCapability = onCapability((raw) => {
      const provider = readProvider(raw);
      if (sameProvider(snapshot.provider, provider)) return;
      publish({
        ...snapshot,
        provider,
        capability: drivenCapability(provider),
        drm: drivenIsDrm(provider),
        // A different source is a different item: its predecessor's position
        // and length describe nothing here, and holding them would draw the
        // old scrubber over the new tab until the next frame lands.
        positionMs: 0,
        durationMs: 0,
        playing: false,
        rate: 1,
        updatedAt: 0,
      });
    });
  }

  function detach(): void {
    const telemetry = offTelemetry;
    const capability = offCapability;
    offTelemetry = null;
    offCapability = null;
    // The bridge closes the shared port once its last listener leaves.
    telemetry?.();
    capability?.();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    attach();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) detach();
    };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe,
    observe: (cb) => subscribe(() => cb(snapshot)),
    dispose: () => {
      disposed = true;
      detach();
      listeners.clear();
      snapshot = NO_EXTENSION_PLAYBACK;
    },
  };
}

/**
 * This app's honesty tier for a driven source. Exported because the sentence a
 * component writes about the source ("plays in sync", "starts together") is
 * this answer, and it must not be re-derived from the wire tier by eye.
 */
export function drivenCapability(provider: ProviderSummary | null): ProviderCapability {
  if (provider === null) return 'generic';
  return providerById(provider.id)?.capability ?? 'generic';
}

/** Protected media. Either signal alone is enough: the wire says so, or this
 *  build's registry classifies the service as extension-only, which is the same
 *  fact wearing the other registry's vocabulary. */
export function drivenIsDrm(provider: ProviderSummary | null): boolean {
  if (provider === null) return false;
  return provider.tier === 'drm' || drivenCapability(provider) === 'extension';
}

let sharedPlayback: ExtensionPlaybackStore | null = null;

/** The one playback store the app uses. Lazy — nothing runs at import time. */
export function extensionPlaybackStore(): ExtensionPlaybackStore {
  sharedPlayback ??= createExtensionPlaybackStore();
  return sharedPlayback;
}

function getPlaybackServerSnapshot(): ExtensionPlayback {
  return NO_EXTENSION_PLAYBACK;
}

/**
 * Subscribe a component to the driven player.
 *
 * Renders {@link NO_EXTENSION_PLAYBACK} on the server and until the first frame
 * arrives, so a page with no extension — and every SSR pass — reads exactly as
 * "nothing is being driven" rather than as a player stopped at zero.
 */
export function useExtensionPlayback(): ExtensionPlayback {
  const store = extensionPlaybackStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, getPlaybackServerSnapshot);
}
