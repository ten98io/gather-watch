/**
 * Background service worker (MV3): owns the room connection for the
 * extension. A room arrives one of two ways —
 *
 *   1. the popup guest-joins with an invite code (no account needed), or
 *   2. the **web app hands the room off** over the externally-connectable
 *      channel (`external.ts`), passing the room id + a room-scoped access
 *      token, so the extension drives as the signed-in member.
 *
 * Either way: sync.state → expected position (clock math via the socket's
 * ClockEstimator) → `drive` messages to the driven tab's content script, and
 * telemetry flows back out to the web app over its event port.
 *
 * Mode B requests — this tab, a window, or a whole screen — are resolved to a
 * stream id here and forwarded to the offscreen document, which owns the only
 * extension context allowed to call getUserMedia. This worker never touches a
 * MediaStream itself.
 *
 * Session state is mirrored into `chrome.storage.session` so a terminated
 * service worker resumes the room instead of silently dropping it. That
 * storage area is TRUSTED_CONTEXTS-only by default (no content-script read)
 * and is wiped when the browser closes.
 */
import { RoomSocket } from '@playin/api-client';
import { normalizeInviteCode } from '@playin/contracts';
import type { PlaybackState, RestreamState } from '@playin/contracts';

import { API_URL, WEB_ORIGINS, WS_URL, originOfUrl } from './config';
import { ElasticDriver, mediaKeyOf, profileForContent, voiceActiveFrom } from './driver';
import type { DriverTelemetry, PresenceLike } from './driver';
import {
  EventPortRegistry,
  ProtocolFault,
  runScreenedRequest,
  screenEventPort,
  screenExternal,
} from './external';
import type { ExternalHost, HandoffInput } from './external';
import { electFrame, pruneClaims } from './frameElection';
import type { FrameClaim } from './frameElection';
import { expectedPositionMs, parseMetrics } from './mediaDriver';
import {
  EXTENSION_CAPABILITIES,
  PROTOCOL_MIN_VERSION,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  errorResponse,
  eventMessage,
  okResponse,
  redactProvider,
} from './protocol';
import type {
  CapabilityResult,
  HelloResult,
  MediaIntent,
  ProviderSummary,
  SessionStatus,
  TelemetryPayload,
} from './protocol';
import { providerForUrl } from './providers';

interface Session {
  roomId: string;
  roomName: string;
  accessToken: string;
  socket: RoomSocket;
  drivenTabId: number | null;
  playback: PlaybackState | null;
  restream: RestreamState | null;
  /** How the room arrived: 'popup' (invite code) or 'web' (handoff). */
  source: 'popup' | 'web';
  /** 'auto' keeps adopting the user's content tab; 'sender' is pinned. */
  target: 'auto' | 'sender';
  /** Elastic sync for this room: owns the drift controller and its anchor. */
  driver: ElasticDriver;
  /** Room presence, kept only to answer "is anybody on mic?" (see driver.ts). */
  presence: Map<string, PresenceLike>;
  /** `tabId:frameId` the driver's learned state belongs to; a change resets it. */
  driverTarget: string | null;
}

let session: Session | null = null;
let lastTelemetry: TelemetryPayload | null = null;
/**
 * Which surface family the offscreen document was last told to capture, or
 * null when we have started nothing. It is what the popup asks for, so a popup
 * that was destroyed by the picker taking focus can still tell whether the
 * share it started is live. It is NOT proof the capture survived: the
 * offscreen document has no stop message yet, and nothing here can observe a
 * track the user ended from Chrome's own sharing bar.
 */
let sharingSource: ShareSource | null = null;
let provider: Record<string, unknown> | null = null;
/** Cleared on disconnect — a stacked interval per reconnect was a real leak. */
let driveTimer: ReturnType<typeof setInterval> | null = null;

const ports = new EventPortRegistry();

/* ── Tab bookkeeping (browser-derived; the page never names a tab) ── */

/** Per-tab provider, reported by each tab's content script on load. */
const tabProviders = new Map<number, ProviderSummary>();
/** Last time a tab reported a media element (telemetry implies one exists). */
const tabMediaSeenAt = new Map<number, number>();
/** The last content tab the *user* focused — the 'auto' handoff target. */
let lastContentTabId: number | null = null;

const MEDIA_FRESH_MS = 4000;

/** A tab we may drive: http(s), and not the Playin web app itself. */
function isDrivableTabUrl(url: string | undefined): boolean {
  const origin = originOfUrl(url ?? '');
  if (origin === null) return false;
  return !WEB_ORIGINS.includes(origin);
}

function tabHasMedia(tabId: number | null): boolean {
  if (tabId === null) return false;
  const seen = tabMediaSeenAt.get(tabId);
  return seen !== undefined && Date.now() - seen < MEDIA_FRESH_MS;
}

async function resolveAutoTab(): Promise<number | null> {
  if (lastContentTabId !== null) {
    const tab = await chrome.tabs.get(lastContentTabId).catch(() => null);
    if (tab !== null && isDrivableTabUrl(tab.url)) return lastContentTabId;
    lastContentTabId = null;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (active?.id !== undefined && isDrivableTabUrl(active.url)) return active.id;
  return null;
}

function noteTab(tabId: number, url: string | undefined): void {
  if (isDrivableTabUrl(url)) lastContentTabId = tabId;
}

chrome.tabs.onActivated.addListener((info) => {
  void chrome.tabs
    .get(info.tabId)
    .then((tab) => {
      noteTab(info.tabId, tab.url);
      void adoptTabIfArmed();
    })
    .catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'complete') return;
  if (tab.active) noteTab(tabId, tab.url);
  void adoptTabIfArmed();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabProviders.delete(tabId);
  tabMediaSeenAt.delete(tabId);
  if (lastContentTabId === tabId) lastContentTabId = null;
  if (session !== null && session.drivenTabId === tabId) {
    session.drivenTabId = null;
    void persistSession();
    broadcastStatus();
  }
});

/** A room handed off before a content tab existed starts driving as soon as
 *  the user opens one. */
async function adoptTabIfArmed(): Promise<void> {
  if (session === null || session.target !== 'auto' || session.drivenTabId !== null) return;
  const tabId = await resolveAutoTab();
  if (tabId === null) return;
  session.drivenTabId = tabId;
  await persistSession();
  driveTab();
  broadcastStatus();
}

/* ── Frame election (the content script runs in EVERY frame) ── */

/**
 * `all_frames: true` means a tab reports several candidate players: the real
 * one in the provider's iframe, an autoplaying trailer, an ad slot, a sticky
 * preview. Driving all of them makes them fight each other's seeks, so each
 * frame only *claims* (see content.ts) and exactly one wins per tab.
 *
 * Claims are cheap to rebuild — every frame re-sends on a 1 Hz heartbeat —
 * so this map is deliberately NOT persisted across service-worker deaths.
 */
const tabClaims = new Map<number, Map<number, FrameClaim>>();
/** Elected frame per tab; null = nothing plausible, fall back to the top. */
const tabWinner = new Map<number, number | null>();

function claimsFor(tabId: number): Map<number, FrameClaim> {
  const existing = tabClaims.get(tabId);
  if (existing !== undefined) return existing;
  const created = new Map<number, FrameClaim>();
  tabClaims.set(tabId, created);
  return created;
}

/** Frame currently driven in this tab (0 = top frame fallback). */
function drivenFrameId(tabId: number): number {
  return tabWinner.get(tabId) ?? 0;
}

function sendToFrame(tabId: number, frameId: number, msg: Record<string, unknown>): void {
  void chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => undefined);
}

function setWinner(tabId: number, winner: number | null): void {
  const previous = tabWinner.get(tabId) ?? null;
  if (winner === previous) return;
  tabWinner.set(tabId, winner);
  if (previous !== null) {
    sendToFrame(tabId, previous, { kind: 'frameRole', role: 'idle' });
    sendToFrame(tabId, previous, { kind: 'driveOff' });
  }
  if (winner !== null) sendToFrame(tabId, winner, { kind: 'frameRole', role: 'driver' });
  if (session !== null && session.drivenTabId === tabId) driveTab();
}

function reelect(tabId: number): void {
  setWinner(
    tabId,
    electFrame([...claimsFor(tabId).values()], {
      now: Date.now(),
      incumbent: tabWinner.get(tabId) ?? null,
    }),
  );
}

/** Frames that unloaded without saying so stop being eligible. */
function expireClaims(): void {
  const now = Date.now();
  for (const [tabId, claims] of tabClaims) {
    if (pruneClaims(claims, now)) reelect(tabId);
  }
}

function onFrameClaim(tabId: number, frameId: number, msg: Record<string, unknown>): void {
  const claims = claimsFor(tabId);
  const metrics = parseMetrics(msg['metrics']);
  if (metrics === null) {
    claims.delete(frameId);
  } else {
    claims.set(frameId, {
      frameId,
      url: typeof msg['url'] === 'string' ? msg['url'] : '',
      metrics,
      at: Date.now(),
    });
    // A frame holding real media is proof the tab has media, whether or not
    // it wins the election.
    tabMediaSeenAt.set(tabId, Date.now());
  }
  reelect(tabId);
}

/** A navigation (including an SPA route change) invalidates every claim. */
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url === undefined && change.status !== 'loading') return;
  claimsFor(tabId).clear();
  setWinner(tabId, null);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabClaims.delete(tabId);
  tabWinner.delete(tabId);
});

/* ── Guest join (popup path) ── */

interface GuestJoinWire {
  user: { id: string };
  room: { id: string; name: string };
  accessToken: string;
}

async function guestJoin(code: string): Promise<GuestJoinWire> {
  const res = await fetch(`${API_URL}/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteCode: normalizeInviteCode(code), displayName: 'Extension' }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(res.status === 404 ? 'Invite code not found' : `Join failed (${res.status}): ${text.slice(0, 120)}`);
  }
  return (await res.json()) as GuestJoinWire;
}

/* ── The drive loop: elastic sync (docs/EXTENSION_FIRST.md Part 1) ── */

/** Keep only the three presence fields the comfort band depends on. */
function notePresence(entry: { userId: string; state: string; micOn: boolean }): void {
  if (session === null) return;
  session.presence.set(entry.userId, {
    userId: entry.userId,
    state: entry.state,
    micOn: entry.micOn,
  });
}

/**
 * A live mic is the one spoiler vector media-anchored chat cannot close, so
 * the band tightens while anybody is talking and relaxes when they stop. The
 * driver ramps between the two — it never steps.
 */
function applyVoiceActivity(): void {
  if (session === null) return;
  session.driver.setVoiceActive(voiceActiveFrom(session.presence.values()));
}

/** The driven tab's latest telemetry, in the driver's shape. */
function localTelemetry(): DriverTelemetry | null {
  if (lastTelemetry === null) return null;
  return {
    positionMs: lastTelemetry.positionMs,
    durationMs: lastTelemetry.durationMs,
    playing: lastTelemetry.playing,
    rate: lastTelemetry.rate,
    atMs: lastTelemetry.at,
  };
}

/**
 * Keep the band and the capability flags pointed at what is actually playing.
 * Both facts arrive asynchronously (the provider from the tab's top frame, the
 * media tag from the winning frame's claim), so this runs every tick and is a
 * no-op once they have settled.
 */
function refreshDriverContext(tabId: number): void {
  if (session === null) return;
  const frameId = drivenFrameId(tabId);
  const targetKey = `${tabId}:${frameId}`;
  if (session.driverTarget !== targetKey) {
    // A different tab or a different elected frame: different element,
    // different player, and nothing we learned about the last one applies.
    session.driverTarget = targetKey;
    session.driver.reset();
    lastTelemetry = null;
  }
  const summary = tabProviders.get(tabId);
  const claim = tabClaims.get(tabId)?.get(frameId);
  session.driver.setProfile(
    profileForContent({
      providerId: summary?.id ?? null,
      mediaTag: claim?.metrics?.tag ?? null,
    }),
  );
  // Protected players charge a licence renegotiation for every seek, so the
  // driver seeks them far more reluctantly. We never do anything else to them.
  session.driver.setCapabilities({ isDrmProtected: summary?.tier === 'drm' });
}

/**
 * One correction pass. The elastic driver decides; this function only carries
 * the decision to the elected frame — and, crucially, says nothing at all when
 * the decision is "do nothing", because silence is what a viewer playing
 * smoothly at a stable offset should receive.
 */
function driveTab(): void {
  if (session === null || session.drivenTabId === null || session.playback === null) return;
  const p = session.playback;
  if (p.mediaRef === null) return;
  const tabId = session.drivenTabId;
  const now = Date.now();
  refreshDriverContext(tabId);

  const cmd = session.driver.tick(
    {
      expectedMs: expectedPositionMs(p, session.socket.clock.serverNow(now)),
      playing: p.playing,
      rate: p.rate,
      mediaKey: mediaKeyOf(p.mediaRef),
    },
    localTelemetry(),
    now,
  );

  // Inside the comfort band there is nothing to send. The exception is the
  // no-telemetry fallback, where the content script has to keep following the
  // room on its own local bands because nothing is reporting back to us.
  if (cmd.idle && cmd.reason !== 'no-telemetry') return;

  // Only the elected frame is driven; the top frame is the fallback while a
  // freshly loaded (or freshly revived) tab has not claimed yet.
  sendToFrame(tabId, drivenFrameId(tabId), {
    kind: 'drive',
    playing: p.playing,
    // Chosen so a content script running the OLD fixed bands reproduces this
    // exact decision — it seeks when, and only when, `seekToMs` is set.
    positionMs: cmd.wirePositionMs,
    rate: cmd.setRate ?? p.rate,
    // The explicit decision, for a content script that understands it.
    elastic: {
      transport: cmd.transport,
      seekToMs: cmd.seekToMs,
      setRate: cmd.setRate,
      driftMs: Math.round(cmd.driftMs),
      anchorOffsetMs: Math.round(cmd.anchorOffsetMs),
      reason: cmd.reason,
    },
  });
}

/* ── Session lifecycle ── */

interface OpenSessionInput {
  roomId: string;
  roomName: string;
  accessToken: string;
  tabId: number | null;
  source: 'popup' | 'web';
  target: 'auto' | 'sender';
}

/**
 * Open the room socket. Every request built here uses `API_URL`, the
 * build-time constant — the handed-over token can reach no other host.
 */
async function openSession(input: OpenSessionInput): Promise<void> {
  await disconnect();
  const socket = new RoomSocket(WS_URL, {
    replayFetch: async (roomId, sinceSeq) => {
      const res = await fetch(`${API_URL}/rooms/${roomId}/events?since=${sinceSeq}`, {
        headers: { authorization: `Bearer ${input.accessToken}` },
      });
      if (!res.ok) throw new Error(`replay failed: ${res.status}`);
      const body = (await res.json()) as { events: never[] };
      return body.events;
    },
  });

  session = {
    roomId: input.roomId,
    roomName: input.roomName,
    accessToken: input.accessToken,
    socket,
    drivenTabId: input.tabId,
    playback: null,
    restream: null,
    source: input.source,
    target: input.target,
    driver: new ElasticDriver(),
    presence: new Map(),
    driverTarget: null,
  };

  socket.on('sync.state', (ev) => {
    if (session === null) return;
    session.playback = ev.payload;
    driveTab();
  });
  socket.on('restream.state', (ev) => {
    if (session === null) return;
    session.restream = ev.payload;
  });
  // Presence is read for exactly one purpose: live voice tightens the comfort
  // band (docs/EXTENSION_FIRST.md Consequence B). Nothing else here reads it,
  // and it never leaves the worker.
  socket.on('presence.state', (ev) => {
    if (session === null) return;
    session.presence.clear();
    for (const entry of ev.payload.entries) notePresence(entry);
    applyVoiceActivity();
  });
  socket.on('presence.diff', (ev) => {
    if (session === null) return;
    for (const entry of ev.payload.upserts) notePresence(entry);
    for (const userId of ev.payload.removed) session.presence.delete(userId);
    applyVoiceActivity();
  });
  socket.connect(input.roomId as never, input.accessToken);

  // Follow-drift passes between state mutations. One timer, ever.
  startDriveTimer();
  await startKeepalive();

  await persistSession();
  broadcastStatus();
}

async function connect(code: string, tabId: number): Promise<void> {
  const joined = await guestJoin(code);
  await openSession({
    roomId: joined.room.id,
    roomName: joined.room.name,
    accessToken: joined.accessToken,
    tabId,
    source: 'popup',
    target: 'sender',
  });
}

/* ── Drive timer + MV3 keepalive ── */

const DRIVE_TICK_MS = 1000;
/** 30s is MV3's floor; anything smaller is silently clamped by Chrome. */
const KEEPALIVE_ALARM = 'playin.keepalive';
const KEEPALIVE_PERIOD_MINUTES = 0.5;

/**
 * The follow-drift pass. `setInterval` is correct *while the worker lives* —
 * it is precise enough for 1 Hz drift correction, which an alarm is not
 * (Chrome clamps alarms to 30s). What it cannot do is survive worker death,
 * so the alarm below revives the worker and this timer is re-armed on wake.
 */
function startDriveTimer(): void {
  if (driveTimer !== null) clearInterval(driveTimer);
  driveTimer = setInterval(() => {
    expireClaims();
    driveTab();
  }, DRIVE_TICK_MS);
}

function stopDriveTimer(): void {
  if (driveTimer === null) return;
  clearInterval(driveTimer);
  driveTimer = null;
}

async function startKeepalive(): Promise<void> {
  await chrome.alarms
    .create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES })
    .catch(() => undefined);
}

async function stopKeepalive(): Promise<void> {
  await chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => false);
}

/**
 * The worker was terminated and something woke it: restore the room (from
 * chrome.storage.session) and re-arm the drive timer, which did not survive.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  void restoreSession().then(() => {
    if (session === null) {
      void stopKeepalive();
      return;
    }
    if (driveTimer === null) startDriveTimer();
    driveTab();
  });
});

chrome.runtime.onSuspend.addListener(() => {
  stopDriveTimer();
});

async function disconnect(): Promise<void> {
  stopDriveTimer();
  if (session !== null) {
    if (session.drivenTabId !== null) {
      sendToFrame(session.drivenTabId, drivenFrameId(session.drivenTabId), { kind: 'driveOff' });
    }
    session.socket.close();
    session = null;
  }
  lastTelemetry = null;
  // The share belonged to that room. (The offscreen document is not torn down
  // here — it has no stop message; see OffscreenShareMessage.)
  sharingSource = null;
  await stopKeepalive();
  await persistSession();
}

/* ── chrome.storage.session mirror (survives service-worker death) ── */

const SESSION_KEY = 'playin.session.v1';

interface PersistedSession {
  roomId: string;
  roomName: string;
  accessToken: string;
  drivenTabId: number | null;
  source: 'popup' | 'web';
  target: 'auto' | 'sender';
}

async function persistSession(): Promise<void> {
  try {
    if (session === null) {
      await chrome.storage.session.remove(SESSION_KEY);
      return;
    }
    const value: PersistedSession = {
      roomId: session.roomId,
      roomName: session.roomName,
      accessToken: session.accessToken,
      drivenTabId: session.drivenTabId,
      source: session.source,
      target: session.target,
    };
    await chrome.storage.session.set({ [SESSION_KEY]: value });
  } catch {
    // Storage unavailable (or the worker is tearing down) — the in-memory
    // session still works for this worker's lifetime.
  }
}

async function restoreSession(): Promise<void> {
  if (session !== null) return;
  let stored: PersistedSession | undefined;
  try {
    const bag = await chrome.storage.session.get(SESSION_KEY);
    stored = bag[SESSION_KEY] as PersistedSession | undefined;
  } catch {
    return;
  }
  if (stored === undefined || typeof stored.accessToken !== 'string') return;
  await openSession({
    roomId: stored.roomId,
    roomName: stored.roomName,
    accessToken: stored.accessToken,
    tabId: stored.drivenTabId,
    source: stored.source === 'web' ? 'web' : 'popup',
    target: stored.target === 'sender' ? 'sender' : 'auto',
  }).catch(() => undefined);
}

/* ── Mode B (offscreen capture: this tab, a window, or a whole screen) ── */

/** What the user asked to share, in the user's terms — never an API name. */
export type ShareSurface = 'tab' | 'window' | 'screen';

/**
 * Which capture API produced the stream id. The offscreen document needs it to
 * choose `chromeMediaSource`, and the two id families are NOT interchangeable:
 * a tabCapture id used with `chromeMediaSource: 'desktop'` (or the reverse)
 * fails getUserMedia outright.
 */
export type ShareSource = 'tab' | 'desktop';

/** Picker tabs, in the order they are shown. 'audio' is not a surface — it is
 *  the request for Chrome's "Share audio" tick box. */
export type DesktopSource = 'screen' | 'window' | 'tab' | 'audio';

/** The background → offscreen contract. Absent/'tab' `source` is the original
 *  Mode B behaviour, so an older offscreen bundle keeps working. */
export interface OffscreenShareMessage {
  kind: 'startShare';
  streamId: string;
  roomId: string;
  accessToken: string;
  source: ShareSource;
  /**
   * Whether an audio track may be asked for AT ALL. Additive hint, and the
   * one fact only the picker knows: with a desktop stream id, requesting audio
   * the platform never granted rejects the whole getUserMedia call, and the id
   * is single-use — so there is no retry, and a receiver that guesses loses
   * the video too. Tab capture always grants audio.
   */
  canRequestAudioTrack: boolean;
}

/** What the picker handed back. An empty `streamId` means the user closed it. */
export interface DesktopPick {
  streamId: string;
  canRequestAudioTrack: boolean;
}

/** Everything a share needs from the room; the session supplies it. */
export interface ShareRoom {
  roomId: string;
  accessToken: string;
  /** The driven tab. Required for a tab share, irrelevant to the others. */
  tabId: number | null;
}

/** The capture surface of the browser, injected so `planShare` stays testable. */
export interface ShareDeps {
  /** Provider last reported by that tab's content script, if any. */
  providerOf(tabId: number): ProviderSummary | undefined;
  tabStreamId(tabId: number): Promise<string>;
  chooseDesktop(sources: readonly DesktopSource[]): Promise<DesktopPick>;
}

export type SharePlan =
  | { start: true; message: OffscreenShareMessage; note: string }
  | { start: false; note: string };

/** The popup shows `note` verbatim, so it is plain language, always present. */
export interface ShareResult {
  shared: boolean;
  /** The user closed the picker. A choice, not a failure — never an error. */
  cancelled: boolean;
  note: string;
}

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'WEB_RTC' as chrome.offscreen.Reason],
    justification: 'Screen, window or tab capture + WebRTC fan-out for Mode B room share',
  });
}

/**
 * Picker tabs for the surface the user asked for, that surface first: the
 * source order decides the picker's tab order, and everything stays offered so
 * a user who meant "that window" after all is one click away.
 *
 * 'audio' asks for the "Share audio" tick box. It is a request, never a
 * promise: Chrome delivers tab audio reliably, screen audio only where the OS
 * has system-audio capture (Windows/ChromeOS — macOS has none at all), and
 * window audio nowhere. The picker's answer comes back as
 * `canRequestAudioTrack`; video-only is a normal outcome, not an error.
 */
export function desktopSources(surface: 'window' | 'screen'): DesktopSource[] {
  const ordered: DesktopSource[] =
    surface === 'window' ? ['window', 'screen', 'tab'] : ['screen', 'window', 'tab'];
  return [...ordered, 'audio'];
}

/** Unknown or absent → 'tab', which is exactly what shipped before surfaces. */
export function parseShareSurface(value: unknown): ShareSurface {
  return value === 'window' || value === 'screen' ? value : 'tab';
}

function shareMessage(
  room: ShareRoom,
  streamId: string,
  source: ShareSource,
  canRequestAudioTrack: boolean,
): OffscreenShareMessage {
  return {
    kind: 'startShare',
    streamId,
    roomId: room.roomId,
    accessToken: room.accessToken,
    source,
    canRequestAudioTrack,
  };
}

/**
 * Decide what to capture. Throws only for the two states the user can fix
 * (no tab, protected tab); a closed picker returns `start: false` instead,
 * because dismissing a dialog is an answer, not a fault.
 */
export async function planShare(
  room: ShareRoom,
  surface: ShareSurface,
  deps: ShareDeps,
): Promise<SharePlan> {
  if (surface === 'tab') {
    if (room.tabId === null) throw new Error('no tab selected');
    // Capturing a protected surface is refused up front: output protection
    // black-frames it by design, and Playin never re-encodes protected media.
    // Mode A (everyone's own player, in sync) is the path that works.
    const summary = deps.providerOf(room.tabId);
    if (summary !== undefined && summary.tier === 'drm') {
      throw new Error(
        `${summary.name} is protected — capture would send a black frame. Everyone plays their own copy in sync instead.`,
      );
    }
    const streamId = await deps.tabStreamId(room.tabId);
    return {
      start: true,
      message: shareMessage(room, streamId, 'tab', true),
      note: 'Sharing this tab with the room.',
    };
  }

  // No equivalent refusal exists below this line, and inventing one would be a
  // lie: a screen or a window is opaque to us — we cannot see what is on it,
  // the user may open anything in it a second later, and the picker can even
  // hand back a tab we never classified. What is true is that the platform
  // enforces this itself: a protected player composites as black in any
  // capture of it. So the refusal above covers the one case we can genuinely
  // detect, and the rest is the OS's to answer, honestly, in the pixels.
  const pick = await deps.chooseDesktop(desktopSources(surface));
  if (pick.streamId.length === 0) {
    return { start: false, note: 'Nothing was shared — you closed the picker.' };
  }
  const what = surface === 'window' ? 'that window' : 'your screen';
  return {
    start: true,
    message: shareMessage(room, pick.streamId, 'desktop', pick.canRequestAudioTrack),
    note: pick.canRequestAudioTrack
      ? `Sharing ${what} with the room.`
      : `Sharing ${what} with the room — without its sound. Share a tab if the sound matters.`,
  };
}

/**
 * The real capture surface.
 *
 * `chooseDesktopMedia` is deliberately called WITHOUT a targetTab: passing one
 * binds the resulting stream to that tab's origin, and our consumer is the
 * offscreen document (an extension page), which would then be refused the
 * stream it just asked for. The cost is that the picker cannot be anchored to
 * a particular window from a service worker; Chrome shows it over the current
 * one.
 */
export const browserShareDeps: ShareDeps = {
  providerOf: (tabId) => tabProviders.get(tabId),
  tabStreamId: (tabId) => chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }),
  chooseDesktop: (sources) =>
    new Promise<DesktopPick>((resolve) => {
      chrome.desktopCapture.chooseDesktopMedia(
        [...sources],
        (streamId: string, options?: chrome.desktopCapture.StreamOptions) => {
          // A dismissed picker calls back with an empty id — the caller turns
          // that into a plain sentence, not a rejection.
          resolve({
            streamId: typeof streamId === 'string' ? streamId : '',
            canRequestAudioTrack: options?.canRequestAudioTrack === true,
          });
        },
      );
    }),
};

/**
 * The picker can stay open for as long as the user takes to choose, and this
 * worker may be terminated while it is open — in which case the callback never
 * arrives and the popup, which Chrome closed the moment the picker took focus,
 * is not there to care. The share is simply not started; the user presses the
 * button again.
 */
async function startShare(surface: ShareSurface = 'tab'): Promise<ShareResult> {
  if (session === null) throw new Error('connect to a room first');
  // Read the room BEFORE awaiting the picker: the user may disconnect while it
  // is open, and a share must never be started against a room that ended.
  const room: ShareRoom = {
    roomId: session.roomId,
    accessToken: session.accessToken,
    tabId: session.drivenTabId,
  };
  const plan = await planShare(room, surface, browserShareDeps);
  if (!plan.start) return { shared: false, cancelled: true, note: plan.note };
  if (session === null || session.roomId !== room.roomId) {
    return { shared: false, cancelled: false, note: 'That room ended before the share started.' };
  }
  await ensureOffscreen();
  await chrome.runtime.sendMessage(plan.message);
  sharingSource = plan.message.source;
  return { shared: true, cancelled: false, note: plan.note };
}

/* ── Casting: press the site's OWN control (never capture protected video) ── */

/**
 * The only DRM-legal route to a TV (docs/EXTENSION_FIRST.md, Part 3): ask the
 * elected frame to click the site's own cast button, so casting happens
 * inside the site's licensed session. When a site has no such control the
 * content script answers with a plain-language reason — the control is shown
 * with an explanation rather than silently vanishing.
 */
async function castActiveTab(): Promise<{ clicked: boolean; reason: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  if (tabId === undefined) throw new Error('no active tab');
  const res = (await chrome.tabs
    .sendMessage(tabId, { kind: 'castNative' }, { frameId: drivenFrameId(tabId) })
    .catch(() => undefined)) as { clicked?: boolean; reason?: string } | undefined;
  if (res === undefined) {
    return { clicked: false, reason: 'Playin is not running on this page yet — reload it and try again.' };
  }
  return { clicked: res.clicked === true, reason: res.reason ?? '' };
}

/* ── External channel (the web app) ── */

function currentProvider(tabId: number | null): ProviderSummary | null {
  if (tabId === null) return null;
  const known = tabProviders.get(tabId);
  return known === undefined ? null : redactProvider(known);
}

function statusOf(): SessionStatus {
  return {
    connected: session !== null,
    roomId: session?.roomId ?? null,
    roomName: session?.roomName ?? null,
    driving: session !== null && session.drivenTabId !== null,
    provider: currentProvider(session?.drivenTabId ?? null),
    hasMedia: tabHasMedia(session?.drivenTabId ?? null),
  };
}

function broadcastStatus(): void {
  const status = statusOf();
  ports.broadcast((v) => eventMessage('status', status, v));
}

const host: ExternalHost = {
  hello(): HelloResult {
    return {
      extensionVersion: chrome.runtime.getManifest().version,
      protocolVersion: PROTOCOL_VERSION,
      minProtocolVersion: PROTOCOL_MIN_VERSION,
      capabilities: EXTENSION_CAPABILITIES,
    };
  },

  status(): SessionStatus {
    return statusOf();
  },

  async capability(): Promise<CapabilityResult> {
    const tabId = session?.drivenTabId ?? (await resolveAutoTab());
    const hasMedia = tabHasMedia(tabId);
    return {
      hasMedia,
      targetKnown: tabId !== null,
      canDrive: tabId !== null && hasMedia,
      provider: currentProvider(tabId),
    };
  },

  async handoff(input: HandoffInput): Promise<SessionStatus> {
    // T7: the target is resolved here, from browser facts only.
    const tabId =
      input.target === 'sender'
        ? input.senderTabId
        : ((await resolveAutoTab()) ?? null);
    await openSession({
      roomId: input.roomId,
      roomName: input.roomName ?? 'Room',
      accessToken: input.accessToken,
      tabId,
      source: 'web',
      target: input.target,
    });
    if (input.intent !== null) applyIntentHint(input.intent);
    return statusOf();
  },

  async intent(intent: MediaIntent): Promise<SessionStatus> {
    if (session === null) {
      throw new ProtocolFault(ProtocolErrorCode.NotConnected, 'no room has been handed off yet');
    }
    applyIntentHint(intent);
    await adoptTabIfArmed();
    return statusOf();
  },

  async release(): Promise<SessionStatus> {
    await disconnect();
    broadcastStatus();
    return statusOf();
  },
};

/**
 * The only consumer of `intent.contentUrl` (T4): it classifies the provider
 * so the popup/web can name it. It is never fetched and never navigated to.
 */
function applyIntentHint(intent: MediaIntent): void {
  if (intent.contentUrl === null) return;
  const classified = providerForUrl(intent.contentUrl);
  provider = { ...classified };
}

chrome.runtime.onMessageExternal.addListener(
  (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
    const screened = screenExternal(msg, sender);
    if (screened.action === 'ignore') return false;
    if (screened.action === 'reject') {
      if (screened.response !== null) sendResponse(screened.response);
      return false;
    }
    runScreenedRequest(screened, host)
      .then((payload) => {
        sendResponse(okResponse(screened.v, screened.id, screened.request.type, payload));
      })
      .catch((err: unknown) => {
        sendResponse(
          errorResponse(
            screened.v,
            screened.id,
            err instanceof ProtocolFault ? err.code : ProtocolErrorCode.Internal,
            err instanceof Error ? err.message.slice(0, 200) : 'extension error',
          ),
        );
      });
    return true; // async response
  },
);

chrome.runtime.onConnectExternal.addListener((port) => {
  const screened = screenEventPort(port.name, port.sender ?? {});
  if (!screened.ok) {
    if (!screened.silent) {
      try {
        port.postMessage(
          errorResponse(
            PROTOCOL_VERSION,
            'port',
            ProtocolErrorCode.UnsupportedVersion,
            'unsupported protocol version',
          ),
        );
      } catch {
        // Port already gone.
      }
    }
    port.disconnect();
    return;
  }
  ports.add(port, screened.v);
  // Immediate snapshot so the page never renders an empty first frame.
  try {
    port.postMessage(eventMessage('status', statusOf(), screened.v));
  } catch {
    ports.remove(port);
  }
});

/* ── Internal channel (popup + content scripts) ── */

chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, sender, sendResponse) => {
  const respond = (p: Promise<unknown>): true => {
    p.then((v) => sendResponse({ ok: true, value: v ?? null })).catch((err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true; // async response
  };

  switch (msg['kind']) {
    case 'popup:connect': {
      const code = String(msg['code'] ?? '');
      return respond(
        (async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id === undefined) throw new Error('no active tab');
          await connect(code, tab.id);
          return { roomName: session?.roomName ?? '' };
        })(),
      );
    }
    case 'popup:disconnect':
      return respond(disconnect().then(() => broadcastStatus()));
    case 'popup:share':
      return respond(startShare(parseShareSurface(msg['surface'])));
    case 'popup:cast':
      return respond(castActiveTab());
    case 'frameClaim': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined && sender.frameId !== undefined) {
        onFrameClaim(tabId, sender.frameId, msg);
      }
      return false;
    }
    case 'popup:status':
      sendResponse({
        ok: true,
        value: {
          connected: session !== null,
          roomName: session?.roomName ?? null,
          playing: session?.playback?.playing ?? false,
          telemetry: lastTelemetry,
          provider,
          sharing: sharingSource !== null,
        },
      });
      return true;
    case 'telemetry': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) tabMediaSeenAt.set(tabId, Date.now());
      const payload: TelemetryPayload = {
        positionMs: typeof msg['positionMs'] === 'number' ? msg['positionMs'] : 0,
        durationMs: typeof msg['durationMs'] === 'number' ? msg['durationMs'] : 0,
        playing: msg['playing'] === true,
        rate: typeof msg['rate'] === 'number' ? msg['rate'] : 1,
        at: Date.now(),
      };
      // Only the driven tab's telemetry is the room's: other tabs may have
      // media too, and reporting theirs would be both wrong and a leak.
      if (session !== null && tabId !== undefined && tabId === session.drivenTabId) {
        lastTelemetry = payload;
        ports.broadcast((v) => eventMessage('telemetry', payload, v));
      }
      return false;
    }
    case 'provider': {
      const raw = msg['provider'] as Record<string, unknown> | undefined;
      provider = raw ?? null;
      const tabId = sender.tab?.id;
      if (tabId !== undefined && raw !== undefined) {
        tabProviders.set(tabId, {
          id: String(raw['id'] ?? 'generic'),
          name: String(raw['name'] ?? 'This page'),
          tier: String(raw['tier'] ?? 'generic'),
        });
        if (session !== null && tabId === session.drivenTabId) {
          const summary = currentProvider(tabId);
          ports.broadcast((v) => eventMessage('capability', summary, v));
        }
      }
      return false;
    }
    default:
      return false;
  }
});

// A worker that was terminated mid-room resumes it here (MV3 workers die).
void restoreSession();
