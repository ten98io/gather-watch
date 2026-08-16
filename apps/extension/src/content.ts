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
 *   ← { kind: 'driveOff' }                            release the element
 *   ← { kind: 'frameRole', role: 'driver' | 'idle' }  election result
 *   ← { kind: 'castNative' } → { clicked, reason }    press the site's own
 *                                                     cast button
 *   → { kind: 'frameClaim', metrics, url }            election input
 *   → { kind: 'telemetry', positionMs, durationMs, playing, rate }
 *   → { kind: 'provider', provider }                  (top frame, on route)
 */
import { performNativeCast } from './cast';
import type { CastResult, CastTarget } from './cast';
import { WEB_ORIGINS } from './config';
import { appliesVerbatim, elasticDecision, parseElasticDirective } from './driver';
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
import {
  PROTOCOL_MIN_VERSION,
  PROTOCOL_VERSION,
  buildAnnounce,
  isAnnounceRequest,
} from './protocol';
import { providerForUrl } from './providers';
import { watchNavigation } from './spaWatch';

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
  cachedMedia = pickBestMedia(candidates)?.el ?? null;
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

function reportProvider(): void {
  if (window.top !== window) return; // one provider per tab, from the top frame
  void chrome.runtime
    .sendMessage({ kind: 'provider', provider: providerForUrl(location.href) })
    .catch(() => undefined);
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
  if (!driven || lastCommand === null) return;
  const el = currentMedia();
  if (el === null) return;
  const media = el as MediaElementLike;

  const directive = lastCommand.elastic;
  if (directive !== null && appliesVerbatim(directive)) {
    applyDecision(media, elasticDecision(directive));
    return;
  }

  applyDecision(
    media,
    decideDrive(readTelemetry(media), lastCommand.positionMs, {
      playing: lastCommand.playing,
      rate: lastCommand.rate,
    }),
  );
}

function sendTelemetry(): void {
  const el = currentMedia();
  if (el === null) return;
  const t = readTelemetry(el as MediaElementLike);
  void chrome.runtime.sendMessage({ kind: 'telemetry', ...t }).catch(() => undefined);
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
const nav = watchNavigation(
  {
    history,
    currentUrl: () => location.href,
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
  },
  () => {
    cachedMedia = null;
    scanDirty = true;
    lastScanAt = 0;
    driven = false;
    lastCommand = null;
    reportProvider();
    reportClaim(true);
  },
);

// The element is often replaced in place without any navigation at all.
const observer = new MutationObserver((records) => {
  for (const record of records) {
    if (record.addedNodes.length > 0 || record.removedNodes.length > 0) {
      scanDirty = true;
      return;
    }
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });

// Media events do not bubble, but capture-phase listeners on the document see
// them (including from open shadow roots) — the fastest re-claim signal.
for (const type of ['loadedmetadata', 'durationchange', 'emptied', 'play', 'pause'] as const) {
  document.addEventListener(
    type,
    () => {
      scanDirty = true;
      scheduleClaim();
    },
    true,
  );
}

window.addEventListener('pagehide', () => {
  nav.dispose();
  observer.disconnect();
});

setInterval(() => {
  nav.check();
  reportClaim();
  if (role === 'driver') sendTelemetry();
}, HEARTBEAT_MS);

// ---------------------------------------------------------------------------
// Extension-id announcement — Playin's own origins, top frame only
// ---------------------------------------------------------------------------

/**
 * The web app needs this extension's id to open the externally-connectable
 * channel, and an unpacked dev build's id is machine-specific — so there is
 * no id to hardcode. Announcing it same-origin is the only discovery path
 * that works everywhere.
 *
 * What crosses: the extension id (public — it is in the store URL), its
 * version, and the supported protocol range. Never a token, a session, a tab
 * or anything about another origin. It happens ONLY on the allowlisted Playin
 * origins and only from the top frame, so no third-party site — and no
 * embedded frame — ever learns the extension is installed this way.
 */
function announceToPlayin(): void {
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
    announceToPlayin();
  });
  announceToPlayin();
}

reportProvider();
reportClaim(true);
