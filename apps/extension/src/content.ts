/**
 * Content script — runs in EVERY frame (manifest `all_frames: true`), because
 * on most sites the player lives in an iframe. A frame does not decide it is
 * the player: it *claims*, the background elects exactly one winner per tab
 * (see frameElection.ts), and only the winner is driven.
 *
 * Detection is deliberately paranoid about modern sites:
 *   - open shadow roots are traversed (web-component players)
 *   - SPA route changes are watched (YouTube/Netflix never reload)
 *   - the element being swapped in place is noticed (cached node detaches)
 * The "largest visible video/audio" heuristic is still the base; scoring in
 * mediaDriver.ts layers duration/readiness/play-state on top so an ad slot or
 * a muted hero loop cannot outrank the feature.
 *
 * All decisions come from the pure modules; this file is DOM plumbing only.
 *
 * Protocol with the background worker:
 *   ← { kind: 'drive', playing, positionMs, rate, elastic? }
 *          Apply the room's decision. `elastic` (driver.ts's
 *          {@link ElasticDirective}) is the decision itself and wins whenever
 *          it is present and well-formed; `playing`/`positionMs`/`rate` are
 *          the legacy shape, kept so an OLD build of this script still
 *          reproduces that decision under its own fixed bands. See drive().
 *   ← { kind: 'driveOff' }                            release the element now
 *   ← { kind: 'frameRole', role: 'driver' | 'idle' }  election result, and the
 *                                                     ONLY grant to drive
 *   ← { kind: 'overlay', state }                      show/refresh the room
 *                                                     overlay (top frame only)
 *   ← { kind: 'overlayOff' }                          take the overlay away
 *   ← { kind: 'castNative' } → { clicked, reason }    press the site's own
 *                                                     cast button
 *   → { kind: 'frameClaim', metrics, url }            election input
 *   → { kind: 'telemetry', positionMs, durationMs, playing, rate }
 *   → { kind: 'userIntent', intent, positionMs }      the user's own hand on
 *                                 the SITE's player (driver frame, driven only)
 *   → { kind: 'mediaEnded', positionMs, durationMs }  the item ran out — a
 *                                 fact, never an intent (driver frame, driven)
 *   → { kind: 'provider' }                            this tab's page changed
 *                                 (top frame, on load and on every route); the
 *                                 worker re-reads the URL from the browser
 *   → { kind: 'overlay:state' } → the room for THIS tab, or null when it is
 *                                 not the tab in the room
 *   → { kind: 'overlay:chat' | 'overlay:leave' | 'overlay:open-app' }
 *                                 sent by the overlay itself (see overlay/)
 */
import { performNativeCast } from './cast';
import type { CastResult, CastTarget } from './cast';
import { WEB_ORIGINS } from './config';
import {
  MediaEndDetector,
  UserIntentDetector,
  appliesVerbatim,
  elasticDecision,
  parseElasticDirective,
} from './driver';
import type { ElasticDirective } from './driver';
import {
  applyDecision,
  decideDrive,
  isPlausibleMain,
  mediaIsUsable,
  pickBestMedia,
  readTelemetry,
  toMetrics,
} from './mediaDriver';
import type { MediaElementLike, MediaMetrics, MediaProbe } from './mediaDriver';
// Types only — erased at compile time, so this does NOT pull the overlay in.
// The module itself is imported dynamically; see showRoomOverlay below.
import type { OverlayHandle, OverlayRoomState, OverlaySend, OverlayStorage } from './overlay';
import {
  PROTOCOL_MIN_VERSION,
  PROTOCOL_VERSION,
  buildAnnounce,
  isAnnounceRequest,
} from './protocol';
import { providerForUrl } from './providers';
import { watchNavigation } from './spaWatch';
import type { NavigationWatcher } from './spaWatch';

/** Heartbeat: navigation poll + claim refresh + telemetry when driving. */
const HEARTBEAT_MS = 1000;
/**
 * Re-send an unchanged claim at least this often. Upstream this is both the
 * election TTL heartbeat and the "this tab has media" freshness signal, so it
 * has to beat the background's staleness window, not just the 20s TTL.
 */
const CLAIM_REFRESH_MS = 3000;
/** Floor between full DOM scans — mutation-heavy pages fire constantly. */
const RESCAN_MIN_MS = 2000;
/** Shadow-root recursion depth and element budget for one scan. */
const MAX_SHADOW_DEPTH = 8;
const MAX_SCAN_ELEMENTS = 8000;

/**
 * Whether this frame currently applies commands, and whether it is allowed to
 * at all. The two are not the same and the difference is load-bearing:
 *   `role`   — the election's answer to "may this frame drive?". It changes on
 *              a `frameRole` message and on nothing else, in either direction.
 *              A frame starts idle, so a frame nobody elected drives nothing.
 *   `driven` — whether a command has arrived since. `driveOff` clears it
 *              ("release the element now"); it does not grant or revoke the
 *              role, which is the background's to say.
 * Every drive path checks the role, so being demoted actually stops this frame
 * instead of pausing it until the next command arrives.
 */
let driven = false;
let role: 'driver' | 'idle' = 'idle';
let lastCommand: {
  playing: boolean;
  positionMs: number;
  rate: number;
  /** null when the worker sent no block, or sent one we cannot trust. */
  elastic: ElasticDirective | null;
} | null = null;

let cachedMedia: HTMLMediaElement | null = null;
let scanDirty = true;
let lastScanAt = 0;
let lastClaimKey: string | null = null;
let lastClaimAt = 0;

/** Turns transport events on the driven element into user intent — and
 *  swallows the ones our own applied commands cause. Pure; lives in driver.ts. */
const userIntent = new UserIntentDetector();
/** The other half of that judgement: the end of the media, which the intent
 *  detector deliberately refuses to call a pause. Pure; lives in driver.ts. */
const mediaEnd = new MediaEndDetector();
/**
 * Bumped every time the element this frame drives is REPLACED. It is half of
 * the key an end is reported once per (the element's own `currentSrc` is the
 * other half), because two different players can be at the same source and one
 * player can be handed two sources.
 */
let mediaEpoch = 0;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Walk `root` and every OPEN shadow root beneath it, collecting media. */
function collectMedia(): HTMLMediaElement[] {
  const found: HTMLMediaElement[] = [];
  let budget = MAX_SCAN_ELEMENTS;
  const visit = (root: ParentNode, depth: number): void => {
    for (const el of root.querySelectorAll('video, audio')) {
      found.push(el as HTMLMediaElement);
    }
    if (depth >= MAX_SHADOW_DEPTH) return;
    for (const el of root.querySelectorAll('*')) {
      if (budget <= 0) return;
      budget -= 1;
      const shadow = (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
      if (shadow !== null) visit(shadow, depth + 1);
    }
  };
  visit(document, 0);
  return found;
}

function probe(el: HTMLMediaElement): MediaProbe {
  const rect = el.getBoundingClientRect();
  return {
    tagName: el.tagName,
    area: rect.width * rect.height,
    duration: el.duration,
    readyState: el.readyState,
    paused: el.paused,
    muted: el.muted,
    currentSrc: el.currentSrc.length > 0 ? el.currentSrc : el.src,
    srcObjectPresent: el.srcObject !== null && el.srcObject !== undefined,
  };
}

function rescan(now: number): HTMLMediaElement | null {
  lastScanAt = now;
  scanDirty = false;
  const candidates = collectMedia().map((el) => ({ el, metrics: toMetrics(probe(el)) }));
  const next = pickBestMedia(candidates)?.el ?? null;
  // A swapped element (ad roll, SPA route) starts a fresh intent history: the
  // old element's expectations and baseline describe a player that is gone.
  // The end latch is the same story, and its key moves with the epoch.
  if (next !== cachedMedia) {
    userIntent.reset();
    mediaEnd.reset();
    mediaEpoch += 1;
  }
  cachedMedia = next;
  return cachedMedia;
}

/**
 * The frame's main media element. Re-scans when the cached node left the
 * document (SPA players swap the `<video>` in place) or when mutations have
 * piled up; otherwise reuses the cache — a deep scan is not free.
 */
function currentMedia(): HTMLMediaElement | null {
  const now = Date.now();
  const stale = scanDirty && now - lastScanAt >= RESCAN_MIN_MS;
  if (!stale && mediaIsUsable(cachedMedia)) return cachedMedia;
  return rescan(now);
}

function currentMetrics(): MediaMetrics | null {
  const el = currentMedia();
  return el === null ? null : toMetrics(probe(el));
}

// ---------------------------------------------------------------------------
// Claiming (election input)
// ---------------------------------------------------------------------------

function claimKey(m: MediaMetrics | null): string {
  if (m === null) return 'none';
  return [m.tag, Math.round(m.area), Math.round(m.durationSec), m.readyState, m.paused ? 0 : 1].join(':');
}

/** Report this frame's best candidate — or explicitly nothing, so a frame
 *  that lost its player stops being eligible immediately. */
function reportClaim(force = false): void {
  const metrics = currentMetrics();
  const payload = isPlausibleMain(metrics) ? metrics : null;
  const key = claimKey(payload);
  const now = Date.now();
  if (!force && key === lastClaimKey) {
    // Only frames that actually hold a player heartbeat; "I have nothing" is
    // reported once per change, not every second by every ad frame.
    if (payload === null || now - lastClaimAt < CLAIM_REFRESH_MS) return;
  }
  lastClaimKey = key;
  lastClaimAt = now;
  void chrome.runtime
    .sendMessage({ kind: 'frameClaim', metrics: payload, url: location.href })
    .catch(() => undefined);
}

let claimDebounce: ReturnType<typeof setTimeout> | null = null;
/** Coalesce burst signals (a player emits play/pause/durationchange in a
 *  clump) into one claim. */
function scheduleClaim(): void {
  if (claimDebounce !== null) return;
  claimDebounce = setTimeout(() => {
    claimDebounce = null;
    reportClaim(true);
  }, 300);
}

/**
 * Tell the worker this tab's page changed. It carries no classification: the
 * worker reads the tab's own URL from the browser (`chrome.tabs.get`), which
 * this page cannot forge and which is still there after MV3 recycles the
 * worker — a classification the worker could only have been TOLD is one it
 * loses on every recycle, for every tab already open.
 */
function reportProvider(): void {
  if (window.top !== window) return; // one report per tab, from the top frame
  void chrome.runtime.sendMessage({ kind: 'provider' }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------

/**
 * Apply the room's latest decision to this frame's element.
 *
 * The background worker's elastic driver holds the telemetry history, the
 * learned per-viewer anchor and the seek rate-limiter, so when it sends an
 * `elastic` block that decision is FINAL and goes to the element unaltered.
 * Never re-derive it here from `positionMs`: doing so corrects toward a raw
 * position the anchor deliberately moved away from, seeks on this frame's
 * schedule rather than the rate-limiter's, and overrides every deliberate
 * non-correction ('stalled', 'seek-suppressed', 'rate-locked') — each of which
 * means send the player nothing at all.
 *
 * Two cases still belong to this frame, and both land on mediaDriver's legacy
 * fixed bands: a message carrying no usable block (an older worker driving a
 * newer content script), and the worker's own 'no-telemetry' decision, which
 * says nothing is reporting back to it and we are on our own.
 */
function drive(): void {
  if (role !== 'driver' || !driven || lastCommand === null) return;
  const el = currentMedia();
  if (el === null) return;
  const media = el as MediaElementLike;

  const directive = lastCommand.elastic;
  if (directive !== null && appliesVerbatim(directive)) {
    const decision = elasticDecision(directive);
    // Marked BEFORE it is applied: the events a command causes fire after
    // applyDecision returns, and they must read as ours, not as the user's.
    userIntent.noteApplied(decision, Date.now());
    applyDecision(media, decision);
    return;
  }

  const decision = decideDrive(readTelemetry(media), lastCommand.positionMs, {
    playing: lastCommand.playing,
    rate: lastCommand.rate,
  });
  userIntent.noteApplied(decision, Date.now());
  applyDecision(media, decision);
}

function sendTelemetry(): void {
  const el = currentMedia();
  if (el === null) return;
  const t = readTelemetry(el as MediaElementLike);
  // The same reading is the intent detector's baseline for "material seek",
  // and the end detector's proof that a player it saw end is playing again.
  userIntent.notePosition(t.positionMs);
  mediaEnd.notePosition(t.positionMs, t.durationMs);
  void chrome.runtime.sendMessage({ kind: 'telemetry', ...t }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The room overlay — top frame, and only on the tab that is in a room
// ---------------------------------------------------------------------------

/**
 * The room UI, drawn on the site the user is actually watching.
 *
 * Two rules decide whether it exists at all, and they are the reason this file
 * asks rather than assumes:
 *   - the TOP frame only. This script runs in every frame of every page, and
 *     an overlay per iframe is the failure mode this extension already has the
 *     scars from.
 *   - a tab that is in a room. The background worker knows which tab that is
 *     (exactly one, the driven tab) and nothing here guesses: `overlay:state`
 *     answers with the room, or with null for every other tab in the browser.
 *
 * `./overlay` is imported DYNAMICALLY, so the panel, its stylesheet and its
 * state machine are never evaluated on the overwhelming majority of pages,
 * which are in no room. (The bundler still inlines the bytes into content.js —
 * MV3 content scripts must stay one self-contained file — but the module body
 * does not run until the first mount.)
 */
const isTopFrame = window.top === window;

let roomOverlay: OverlayHandle | null = null;
/** The state we want shown; null means "no room", which is also "no overlay". */
let wantedRoom: OverlayRoomState | null = null;
/** An import is not instant, and a second mount while it is in flight is how
 *  an overlay gets stacked on itself. */
let overlayLoading = false;

/**
 * The overlay's only route out. It resolves when the worker accepted the
 * message and rejects when it did not — the overlay puts a real sentence in
 * front of the user on a rejection, so silently resolving would be a lie.
 */
const overlaySend: OverlaySend = async (message) => {
  const reply: unknown = await chrome.runtime.sendMessage(message);
  const value = readReply(reply);
  if (value === undefined) throw new Error('The room did not take that.');
  return value;
};

/** Position and collapsed state, remembered per site. Failures are survivable
 *  — the overlay simply opens where it always opens. */
const overlayStorage: OverlayStorage = {
  read: async (key) => {
    const bag: Record<string, unknown> = await chrome.storage.local.get(key);
    return bag[key];
  },
  write: async (key, value) => {
    await chrome.storage.local.set({ [key]: value });
  },
};

/** The worker's `{ ok, value }` envelope. undefined = it refused, or is gone. */
function readReply(reply: unknown): unknown {
  if (typeof reply !== 'object' || reply === null) return undefined;
  const bag = reply as Record<string, unknown>;
  if (bag['ok'] !== true) return undefined;
  return bag['value'] ?? null;
}

async function showRoomOverlay(state: OverlayRoomState): Promise<void> {
  wantedRoom = state;
  if (roomOverlay !== null) {
    roomOverlay.update(state);
    return;
  }
  if (overlayLoading) return;
  overlayLoading = true;
  try {
    const { mountOverlay } = await import('./overlay');
    const wanted = wantedRoom;
    // The room may have ended, or another call may have mounted, while the
    // module was loading. Either way there is nothing to mount now.
    if (wanted === null || roomOverlay !== null) return;
    roomOverlay = mountOverlay({
      document,
      send: overlaySend,
      storage: overlayStorage,
      initialState: wanted,
    });
  } catch {
    // Nothing to show. The next refresh tries again.
  } finally {
    overlayLoading = false;
  }
}

function hideRoomOverlay(): void {
  wantedRoom = null;
  roomOverlay?.destroy();
  roomOverlay = null;
}

/**
 * Ask the worker whether this tab is in a room, and act on the answer.
 *
 * Called on load and after every route change, which is what makes the overlay
 * survive both a reload and an SPA navigation: an existing panel is updated in
 * place (never re-mounted, so navigating fifty times leaves one), and a tab
 * that is no longer the room's loses it.
 */
function refreshRoomOverlay(): void {
  if (!isTopFrame) return;
  void chrome.runtime
    .sendMessage({ kind: 'overlay:state' })
    .then((reply: unknown) => {
      const value = readReply(reply);
      if (typeof value === 'object' && value !== null) {
        void showRoomOverlay(value as OverlayRoomState);
      } else {
        hideRoomOverlay();
      }
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Casting — press the site's own control (never capture a protected surface)
// ---------------------------------------------------------------------------

function deepQuerySelector(selector: string): Element | null {
  let budget = MAX_SCAN_ELEMENTS;
  const visit = (root: ParentNode, depth: number): Element | null => {
    const direct = root.querySelector(selector);
    if (direct !== null) return direct;
    if (depth >= MAX_SHADOW_DEPTH) return null;
    for (const el of root.querySelectorAll('*')) {
      if (budget <= 0) return null;
      budget -= 1;
      const shadow = (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
      if (shadow === null) continue;
      const hit = visit(shadow, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  return visit(document, 0);
}

function castTarget(selector: string): CastTarget | null {
  const el = deepQuerySelector(selector);
  if (el === null) return null;
  const rect = el.getBoundingClientRect();
  return {
    visible: rect.width > 0 && rect.height > 0,
    click: () => {
      (el as HTMLElement).click?.();
    },
  };
}

async function castNative(): Promise<CastResult> {
  const provider = providerForUrl(location.href);
  return performNativeCast(
    provider.cast,
    {
      query: castTarget,
      wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
    provider.name,
  );
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    msg: { kind?: string } & Record<string, unknown>,
    _sender,
    sendResponse: (response: unknown) => void,
  ) => {
    switch (msg.kind) {
      case 'drive':
        // A command is not a licence. Only the elected frame drives, so a frame
        // that was demoted — or was never elected at all — drops the command
        // instead of taking the element back from whoever holds it.
        if (role !== 'driver') return false;
        driven = true;
        lastCommand = {
          playing: msg['playing'] === true,
          positionMs: typeof msg['positionMs'] === 'number' ? msg['positionMs'] : 0,
          rate: typeof msg['rate'] === 'number' ? msg['rate'] : 1,
          elastic: parseElasticDirective(msg['elastic']),
        };
        drive();
        return false;
      case 'driveOff':
        driven = false;
        lastCommand = null;
        return false;
      case 'frameRole':
        role = msg['role'] === 'driver' ? 'driver' : 'idle';
        if (role === 'idle') {
          driven = false;
          lastCommand = null;
        }
        return false;
      case 'overlay': {
        // One room, one overlay, in the tab's own document — never in an
        // iframe, which would put a second copy on the page.
        if (!isTopFrame) return false;
        const state = msg['state'];
        if (typeof state !== 'object' || state === null) hideRoomOverlay();
        else void showRoomOverlay(state as OverlayRoomState);
        return false;
      }
      case 'overlayOff':
        hideRoomOverlay();
        return false;
      case 'castNative':
        castNative()
          .then((res) => sendResponse(res))
          .catch((err: unknown) =>
            sendResponse({
              clicked: false,
              selector: null,
              reason: err instanceof Error ? err.message : 'Cast failed',
            }),
          );
        return true; // async response
      default:
        return false;
    }
  },
);

// Route changes: same document, different content. Re-detect from scratch.
const navHost = {
  history,
  currentUrl: () => location.href,
  addEventListener: (type: string, listener: () => void) =>
    window.addEventListener(type, listener),
  removeEventListener: (type: string, listener: () => void) =>
    window.removeEventListener(type, listener),
};

function onRouteChange(): void {
  cachedMedia = null;
  scanDirty = true;
  lastScanAt = 0;
  // The element this frame was driving is gone; the ROLE is not ours to
  // revoke, so the election is left to say whether this frame still wins.
  driven = false;
  lastCommand = null;
  // Whatever ended on the old route ended there. The listener survives the
  // route (one document, one registration) — the judgement does not.
  mediaEnd.reset();
  reportProvider();
  reportClaim(true);
  // A route change can mean the tab left the room's content, or that the
  // site replaced the page under a panel that is still standing.
  refreshRoomOverlay();
}

/** Null until {@link armPage} makes one — and null again after a teardown,
 *  because a disposed watcher never fires and is not worth keeping. */
let nav: NavigationWatcher | null = null;

// The element is often replaced in place without any navigation at all.
const observer = new MutationObserver((records) => {
  for (const record of records) {
    if (record.addedNodes.length > 0 || record.removedNodes.length > 0) {
      scanDirty = true;
      return;
    }
  }
});

// Media events do not bubble, but capture-phase listeners on the document see
// them (including from open shadow roots) — the fastest re-claim signal.
for (const type of [
  'loadedmetadata',
  'durationchange',
  'emptied',
  'play',
  'pause',
  'ended',
] as const) {
  document.addEventListener(
    type,
    () => {
      scanDirty = true;
      scheduleClaim();
    },
    true,
  );
}

/**
 * A gesture on the SITE's own controls is room intent, not drift to correct
 * away. Only the elected, driven frame may speak for the user, and only about
 * the element it is driving — the same element identity the claim/election
 * path keys on, so an ad roll swapping in a new element cannot fabricate a
 * pause from that element's events. The detector swallows what our own
 * commands caused; the worker applies the room's permission model (and its
 * stall judgement) before anything reaches the room.
 */
function onTransportEvent(type: 'play' | 'pause' | 'seeked', ev: Event): void {
  if (role !== 'driver' || !driven) return;
  const el = cachedMedia;
  if (el === null || !el.isConnected) return;
  // composedPath, when the event crossed an open shadow root; target otherwise.
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  if ((path[0] ?? ev.target) !== el) return;
  const found = userIntent.observe({
    type,
    positionMs: el.currentTime * 1000,
    ended: el.ended,
    atMs: Date.now(),
  });
  if (found === null) return;
  void chrome.runtime
    .sendMessage({ kind: 'userIntent', intent: found.intent, positionMs: found.positionMs })
    .catch(() => undefined);
}

for (const type of ['play', 'pause', 'seeked'] as const) {
  document.addEventListener(type, (ev) => onTransportEvent(type, ev), true);
}

/**
 * The media ran out. That is a fact about the item, not a gesture, so it never
 * touches the intent detector — which drops the pause the end causes, on
 * purpose (driver.ts, "arrival, not intent"). The two paths meet nowhere: this
 * one cannot emit a `userIntent`, and the intent path cannot emit an end.
 *
 * It carries the duration with it, because the room needs both — the end to
 * advance on, and the duration to clamp its projection of an item that has no
 * more frames to play.
 *
 * The same gates as intent, for the same reasons: only the elected, driven
 * frame speaks, and only about the element it is driving. The listener itself
 * is registered once on the document, in capture phase, so it sees ends from
 * open shadow roots, is not duplicated by an SPA route change (the document
 * outlives the route), and cannot go stale — what a route change invalidates
 * is the STATE, and that is reset with the rest of it.
 */
function onMediaEnded(ev: Event): void {
  if (role !== 'driver' || !driven) return;
  const el = cachedMedia;
  if (el === null || !el.isConnected) return;
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  if ((path[0] ?? ev.target) !== el) return;
  const t = readTelemetry(el as MediaElementLike);
  const src = el.currentSrc.length > 0 ? el.currentSrc : el.src;
  const found = mediaEnd.observe({
    // Element identity AND source: a player handed the next track reports that
    // track's end too, while the same track's second 'ended' is swallowed.
    sourceKey: `${String(mediaEpoch)}:${src}`,
    positionMs: t.positionMs,
    durationMs: t.durationMs,
    // The element's own word, read now rather than when the event was queued.
    ended: el.ended,
  });
  if (found === null) return;
  void chrome.runtime
    .sendMessage({
      kind: 'mediaEnded',
      positionMs: found.positionMs,
      durationMs: found.durationMs,
    })
    .catch(() => undefined);
}

document.addEventListener('ended', (ev) => onMediaEnded(ev), true);

/**
 * Everything in this document that is TAKEN DOWN when the page goes away —
 * and PUT BACK when it comes back.
 *
 * `pagehide` fires for both of those, and the difference is `persisted`: a
 * document entering the back/forward cache is not destroyed, it is frozen and
 * handed back intact on `pageshow`. The teardown used to have no partner, so a
 * tab that went Back and then Forward again came back with a navigation
 * watcher that had been disposed — `check()` returns immediately once disposed
 * and the history methods have been unpatched — and a disconnected mutation
 * observer. The 1 Hz heartbeat kept calling into both, so nothing threw and
 * nothing worked: SPA route changes stopped being noticed for the life of that
 * tab, and the overlay, torn down on the way out, never came back.
 *
 * Both are idempotent, because `pageshow` also fires on an ordinary first load
 * (with `persisted` false), and a second arm would patch `history` twice.
 */
let armed = false;

function armPage(): void {
  if (armed) return;
  armed = true;
  // A disposed watcher never fires again — this takes a fresh one, anchored at
  // the URL the page actually came back on.
  nav = watchNavigation(navHost, onRouteChange);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // The document was frozen, not reloaded, so the DOM may be exactly as it was
  // — but this frame's claim has long since expired out of the election, and
  // the worker may have been recycled and restored since.
  scanDirty = true;
  reportProvider();
  reportClaim(true);
  // Nothing is injected by asking: this is "is this tab in a room?", and the
  // answer for almost every page in almost every tab is "no".
  refreshRoomOverlay();
}

function disarmPage(): void {
  if (!armed) return;
  armed = false;
  nav?.dispose();
  nav = null;
  observer.disconnect();
  hideRoomOverlay();
}

window.addEventListener('pagehide', () => {
  disarmPage();
});

window.addEventListener('pageshow', (ev: Event) => {
  // A fresh document armed itself at module scope; only a restore from the
  // back/forward cache has a teardown to undo.
  if ((ev as PageTransitionEvent).persisted !== true) return;
  armPage();
});

setInterval(() => {
  nav?.check();
  reportClaim();
  if (role === 'driver') sendTelemetry();
}, HEARTBEAT_MS);

// ---------------------------------------------------------------------------
// Extension-id announcement — Gather's own origins, top frame only
// ---------------------------------------------------------------------------

/**
 * The web app needs this extension's id to open the externally-connectable
 * channel, and an unpacked dev build's id is machine-specific — so there is
 * no id to hardcode. Announcing it same-origin is the only discovery path
 * that works everywhere.
 *
 * What crosses: the extension id (public — it is in the store URL), its
 * version, and the supported protocol range. Never a token, a session, a tab
 * or anything about another origin. It happens ONLY on the allowlisted Gather
 * origins and only from the top frame, so no third-party site — and no
 * embedded frame — ever learns the extension is installed this way.
 */
function announceToGather(): void {
  try {
    window.postMessage(
      buildAnnounce({
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        protocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: PROTOCOL_MIN_VERSION,
      }),
      location.origin,
    );
  } catch {
    // Page navigated away mid-announce.
  }
}

if (window.top === window && WEB_ORIGINS.includes(location.origin)) {
  // The page may load after we did, so answer requests as well as announcing.
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    if (!isAnnounceRequest(ev.data)) return;
    announceToGather();
  });
  announceToGather();
}

armPage();
