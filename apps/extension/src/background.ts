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
 * telemetry flows back out to the web app over its event port — as does the
 * end of the driven item, on its own `ended` event, because the item running
 * out is a fact about the media and never a person pausing it.
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
import { RoomSocket } from '@gather/api-client';
import { normalizeInviteCode } from '@gather/contracts';
import type {
  MemberRole,
  PlaybackState,
  QueueItem,
  QueueItemId,
  RestreamState,
  RoomPolicyLevel,
} from '@gather/contracts';

import { endedQueueItemId } from './advance';
import { API_URL, WEB_ORIGINS, WS_URL, originOfUrl } from './config';
import { ElasticDriver, mediaKeyOf, profileForContent, voiceActiveFrom } from './driver';
import type { DriverTelemetry, ElasticDriverState, PresenceLike } from './driver';
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
// Types only — the worker builds the overlay's state, it never draws anything,
// so none of the overlay's DOM code is pulled into this bundle.
import type {
  OverlayConnection,
  OverlayMessage,
  OverlayPerson,
  OverlayRoomState,
} from './overlay';
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
  EndedPayload,
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
  /**
   * The room's queue, kept for ONE purpose: `sync.advance` names the item that
   * ended, and `playback` carries an index but never an id (see
   * {@link reportEndedItem}). Nothing draws it — the overlay shows the room's
   * conversation, not its queue.
   *
   * It arrives with the join snapshot (the server answers a FIRST heartbeat
   * with presence + sync + queue) and on every queue mutation after that. A
   * session revived after MV3 recycles the worker gets no such snapshot,
   * because the presence entry it beats into is still alive — so the queue is
   * unknown until the next mutation, and an ending in that window is not
   * reported. The same recycle leaves `playback` null and stops the worker
   * driving at all, so this is not a new blind spot, and the honest silence is
   * the same one {@link endedQueueItemId} returns for any unknown item.
   */
  queue: QueueItem[];
  /** Version of that queue, so a snapshot reply cannot overwrite a newer
   *  broadcast it raced. Mirrors the web and mobile clients. */
  queueVersion: number;
  /** The last item this worker reported the end of. See {@link reportEndedItem}. */
  advancedItemId: QueueItemId | null;
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
  /** Who we are in this room; null when nothing told us (the handoff path). */
  userId: string | null;
  /** The room's playbackControl policy and OUR role in the room, read from the
   *  room's own record when the session opens (see {@link loadRoomAccess}).
   *  null = not known, and unknown DENIES: a member we cannot place in the
   *  permission model does not speak for the room. */
  playbackPolicy: RoomPolicyLevel | null;
  role: MemberRole | null;
  /** userId → display name, for the overlay. See {@link loadRoomNames}. */
  names: Map<string, string>;
  /** When that directory was last read, so a miss cannot become a fetch loop. */
  namesAt: number;
  /** The tail of the room's chat, oldest first — what the overlay shows. */
  chat: RoomChatLine[];
}

/** One chat line, kept by author ID so a name that arrives late fixes it. */
interface RoomChatLine {
  id: string;
  authorId: string;
  text: string;
}

let session: Session | null = null;
let lastTelemetry: TelemetryPayload | null = null;
/**
 * Which surface family is being captured, or null when nothing is. It is what
 * the popup asks for, so a popup that was destroyed by the picker taking focus
 * can still tell whether the share it started is live. It is cleared by every
 * way a share can end: the room ending, the user stopping it, the shared tab
 * closing, and Chrome's own sharing bar (which reaches us as `shareEnded`).
 */
let sharingSource: ShareSource | null = null;
/**
 * The tab whose pixels are going out, when the share is a tab capture. Closing
 * that tab ends the capture, and the extension must not go on claiming it is
 * sharing something that no longer exists.
 */
let sharingTabId: number | null = null;
/**
 * Which room the live share belongs to, mirrored to `chrome.storage.session`.
 *
 * It is persisted separately from the session because it has to answer a
 * question the in-memory session cannot: after MV3 recycles the worker the
 * session is gone but the offscreen document is still capturing, and
 * `openSession()` must decide whether the room it is opening is the one being
 * shared to (keep it running) or a different one (stop, or the old room keeps
 * receiving pixels while the user is somewhere else).
 */
let sharingRoomId: string | null = null;
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

/** A tab we may drive: http(s), and not the Gather web app itself. */
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
  // Its capture died with it. The offscreen document sees the track end too,
  // and both paths land on the same idempotent teardown.
  if (sharingTabId === tabId) void stopSharing();
  if (session !== null && session.drivenTabId === tabId) {
    session.drivenTabId = null;
    void persistSession();
    broadcastStatus();
    // The overlay went with it. That may have been the last surface, and the
    // beat should stop within the second rather than within the next fifteen.
    void presenceBeat();
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
  // The room now has a tab to live on; that tab gets the panel.
  pushOverlay();
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
/** Elected frame per tab; null = no frame here holds a plausible player. */
const tabWinner = new Map<number, number | null>();

/** A tab's own document. Chrome numbers it 0 and never renumbers it. */
const TOP_FRAME_ID = 0;

function claimsFor(tabId: number): Map<number, FrameClaim> {
  const existing = tabClaims.get(tabId);
  if (existing !== undefined) return existing;
  const created = new Map<number, FrameClaim>();
  tabClaims.set(tabId, created);
  return created;
}

/**
 * The frame this tab elected, or null when it elected nobody.
 *
 * There is deliberately NO fallback to the top frame, and that is the whole of
 * the rule: a frame is driven if and only if it was elected, and being elected
 * is the only thing that sends it `frameRole: 'driver'` — the one grant the
 * content script accepts. So "may this frame drive?" has a single answer, held
 * in one place, and both sides of the message channel read the same one.
 *
 * Falling back to frame 0 broke that twice over. It drove pages where no frame
 * had ever claimed plausibly (a page whose only media is a muted hero loop or
 * an ad slot scores below the claim floor — see mediaDriver's MIN_CLAIM_SCORE),
 * and it drove a frame that had never been told it was the driver, which is
 * exactly the gap a demoted frame used to slip back in through.
 *
 * Waiting costs almost nothing: every frame claims as soon as it loads and
 * re-claims on a few-second heartbeat, so a tab that really holds a player is
 * elected within a heartbeat — and a tab that holds none is never driven at
 * all, which is the honest outcome.
 */
function drivenFrameId(tabId: number): number | null {
  return tabWinner.get(tabId) ?? null;
}

function sendToFrame(tabId: number, frameId: number, msg: Record<string, unknown>): void {
  void chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => undefined);
}

/** Tell a frame it is the driver. The election is the only caller — see
 *  {@link drivenFrameId}. */
function grantDriver(tabId: number, frameId: number): void {
  sendToFrame(tabId, frameId, { kind: 'frameRole', role: 'driver' });
}

function setWinner(tabId: number, winner: number | null): void {
  const previous = tabWinner.get(tabId) ?? null;
  if (winner === previous) return;
  tabWinner.set(tabId, winner);
  if (previous !== null) {
    sendToFrame(tabId, previous, { kind: 'frameRole', role: 'idle' });
    sendToFrame(tabId, previous, { kind: 'driveOff' });
  }
  if (winner !== null) grantDriver(tabId, winner);
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
  // Re-state the grant to the frame that just claimed, when it is the one
  // holding it. A player iframe that re-navigates comes back as a fresh,
  // idle content script while the election still points at that frame id;
  // with the role as the only licence to drive, saying nothing here would
  // leave the room's own player permanently unable to follow.
  if (tabWinner.get(tabId) === frameId) grantDriver(tabId, frameId);
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
    throw new Error(res.status === 404 ? 'Invite code not found — or the room needs a password, which the popup cannot enter yet. Join from the web app instead.' : `Join failed (${res.status}): ${text.slice(0, 120)}`);
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
  noteUnknownName(entry.userId);
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
function refreshDriverContext(tabId: number, frameId: number): void {
  if (session === null) return;
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
 * The driven item ran out: name it and tell the ROOM, once.
 *
 * THE STALL THIS CLOSES. The end used to leave this worker in one direction
 * only — `ports.broadcast('ended')` → the web app's bridge → StagePane →
 * `sync.advance`. A user who connected from the POPUP has no Gather tab open,
 * so that chain has no middle, and their room sat on a finished item forever
 * with the extension merrily driving nothing. This worker already holds a room
 * socket (presence and re-stream ride it), so the report goes straight out.
 *
 * IT SENDS EVEN WHEN A WEB TAB IS LISTENING, so the extension has ONE path
 * rather than two. With both surfaces open the relayed web report and this one
 * both arrive; `sync.advance` is a compare-and-set, so the second finds the
 * room already off the item it names and is dropped. The alternative —
 * sending only while `ports.size === 0` — trades one frame per item for a
 * guess about another surface, and the guess is wrong in the ordinary case:
 * a port is open across a navigation the whole time the page's stage is
 * unmounted, and the web side drops an end whose media key disagrees with its
 * own. Every version of "somebody else will do it" is the advancer election
 * this mechanism was built to delete.
 *
 * ONCE PER ITEM, by remembering the last id reported rather than a set of all
 * of them: a set could never leave an item the room came BACK to, while one id
 * cannot latch, because the next item's id is a different one. The content
 * script already makes exactly one end judgement per item (driver.ts's
 * MediaEndDetector) and the server drops duplicates anyway — so this is
 * tidiness, and a loop is the only thing it must genuinely prevent.
 *
 * RESIDUAL, shared with the web and stated rather than hidden: the item is
 * resolved from the room's CURRENT playback, so an end that arrives after the
 * room has moved on for some other reason (a vote-skip landing in that
 * instant) would name the new item. Closing it needs the content script to
 * echo an item identity it was given, which is a protocol change; the queue
 * mutation that causes it is one the server already realigns playback across.
 */
function reportEndedItem(): void {
  const live = session;
  if (live === null) return;
  const endedItemId = endedQueueItemId({
    queueIndex: live.playback?.queueIndex ?? null,
    items: live.queue,
    mediaRef: live.playback?.mediaRef ?? null,
  });
  // Null is a real answer — the finished item is not in the room's queue, so
  // there is nothing honest to advance from. See advance.ts.
  if (endedItemId === null) return;
  if (live.advancedItemId === endedItemId) return;
  live.advancedItemId = endedItemId;
  live.socket.send('sync.advance', { endedItemId });
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
  const frameId = drivenFrameId(tabId);
  // No frame in this tab has claimed a plausible player (or every claim went
  // stale). There is nothing here to drive, and picking a frame anyway means
  // seeking an element nobody identified as the film. See drivenFrameId.
  if (frameId === null) {
    // Forget the driver context on the way out, not on the way back in. This
    // return skips refreshDriverContext, so if the election later lands on the
    // SAME frame id — an in-room navigation is the ordinary case — the target
    // key compares equal, nothing resets, and the worker drives the new page
    // using the anchor it learned on the old one and a telemetry sample that
    // predates the navigation.
    if (session.driverTarget !== null) {
      session.driverTarget = null;
      session.driver.reset();
      lastTelemetry = null;
    }
    return;
  }
  const now = Date.now();
  refreshDriverContext(tabId, frameId);

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

  // Only the elected frame is ever driven, and it has already been told it is
  // the driver — the command carries no authority of its own.
  sendToFrame(tabId, frameId, {
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

/* ── The room overlay, injected into the driven tab (content.ts mounts it) ── */

/**
 * The worker owns the room; the overlay only draws it. So everything the panel
 * shows is built here and pushed to ONE frame of ONE tab — the top frame of
 * the driven tab, which is the only place a person is watching the room's
 * content. Every other tab asking gets null, and shows nothing.
 */

/** The tail of the chat the overlay keeps. Older lines are memory, not UI. */
const OVERLAY_CHAT_MAX = 100;
/** Floor between reads of the member directory when a name is missing. */
const NAMES_REFRESH_MS = 30_000;

/** The last state pushed, so the 1 Hz tick only talks when something changed. */
let lastOverlayPush: { tabId: number; signature: string } | null = null;

function overlayConnection(): OverlayConnection {
  switch (session?.socket.status) {
    case 'open':
      return 'live';
    case 'reconnecting':
      return 'reconnecting';
    case 'closed':
      return 'offline';
    default:
      return 'connecting';
  }
}

/** Who is here, from presence. People marked offline are not here. */
function overlayPeople(): OverlayPerson[] {
  if (session === null) return [];
  const s = session;
  const out: OverlayPerson[] = [];
  for (const entry of s.presence.values()) {
    if (entry.state === 'offline') continue;
    out.push({
      id: entry.userId,
      // An unknown id renders as "Someone" rather than as an id — see
      // loadRoomNames for why one is usually known by now.
      name: s.names.get(entry.userId) ?? '',
      you: s.userId !== null && entry.userId === s.userId,
      micOn: entry.micOn,
      away: entry.state === 'away',
    });
  }
  return out;
}

function overlayMessages(): OverlayMessage[] {
  if (session === null) return [];
  const s = session;
  return s.chat.map((line) => ({
    id: line.id,
    author: s.names.get(line.authorId) ?? '',
    text: line.text,
    mine: s.userId !== null && line.authorId === s.userId,
  }));
}

/**
 * The driver's state at the resolution the overlay actually speaks in.
 *
 * `syncStatusLabel` says whole seconds and nothing finer, so sending raw
 * millisecond drift would change the pushed state every single tick to produce
 * the very same sentence. Rounding here is what lets the push below stay
 * silent while nothing a person can see has changed.
 */
function overlaySync(): ElasticDriverState | null {
  if (session === null) return null;
  const state = session.driver.state();
  return {
    ...state,
    anchorOffsetMs: Math.round(state.anchorOffsetMs / 1000) * 1000,
    driftMs: Math.round(state.driftMs / 1000) * 1000,
  };
}

/** The room as the overlay shows it — or null when this tab is not the tab
 *  the room is being watched in, which is every tab but one. */
function overlayStateFor(tabId: number | null): OverlayRoomState | null {
  if (session === null || tabId === null || tabId !== session.drivenTabId) return null;
  return {
    connection: overlayConnection(),
    roomName: session.roomName,
    people: overlayPeople(),
    messages: overlayMessages(),
    sync: overlaySync(),
  };
}

/** Send the room to the tab it is being watched in, and only when it changed. */
function pushOverlay(): void {
  const tabId = session?.drivenTabId ?? null;
  const state = overlayStateFor(tabId);
  if (tabId === null || state === null) return;
  const signature = JSON.stringify(state);
  if (lastOverlayPush?.tabId === tabId && lastOverlayPush.signature === signature) return;
  lastOverlayPush = { tabId, signature };
  sendToFrame(tabId, TOP_FRAME_ID, { kind: 'overlay', state });
}

/** A message with no words still says something; a deleted one says nothing. */
function chatLineOf(m: {
  id: string;
  authorId: string;
  kind: string;
  body: string;
  deletedAt: number | null;
}): RoomChatLine | null {
  if (m.deletedAt !== null) return null;
  const body = m.body.trim();
  const text = body.length > 0 ? body : wordlessLine(m.kind);
  if (text.length === 0) return null;
  return { id: m.id, authorId: m.authorId, text };
}

function wordlessLine(kind: string): string {
  switch (kind) {
    case 'gif':
      return 'Sent a GIF';
    case 'voice':
      return 'Sent a voice message';
    case 'attachment':
      return 'Sent a file';
    default:
      return '';
  }
}

/**
 * Names for the overlay.
 *
 * Presence and chat carry user ids and nothing else, and a panel that says
 * "Someone, Someone and Someone are here" is worse than no panel — so the
 * room's member list is read once when the room opens, and re-read (rarely)
 * when an id turns up that it cannot explain. Failing is survivable: the names
 * fall back to "Someone" and every other part of the room still works.
 */
async function loadRoomNames(): Promise<void> {
  if (session === null) return;
  const roomId = session.roomId;
  const token = session.accessToken;
  session.namesAt = Date.now();
  const res = await fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}/members`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (res === null || !res.ok) return;
  const body = (await res.json().catch(() => null)) as {
    members?: Array<{ user?: { id?: unknown; displayName?: unknown } }>;
  } | null;
  // The user may have left, or moved rooms, while this was in flight.
  if (session === null || session.roomId !== roomId) return;
  if (body === null || !Array.isArray(body.members)) return;
  for (const entry of body.members) {
    const id = entry.user?.id;
    const name = entry.user?.displayName;
    if (typeof id === 'string' && typeof name === 'string' && name.length > 0) {
      session.names.set(id, name);
    }
  }
  pushOverlay();
}

/** Somebody we have no name for. Re-read the directory, at most rarely. */
function noteUnknownName(userId: string): void {
  if (session === null || session.names.has(userId)) return;
  if (Date.now() - session.namesAt < NAMES_REFRESH_MS) return;
  void loadRoomNames();
}

/* ── The room's permission model, for intent this worker forwards ── */

/** Mirrors apps/web/lib/permissions.ts (canAct) — keep the two in sync. */
const ROLE_RANK: Record<MemberRole, number> = { guest: 0, member: 1, moderator: 2, host: 3 };
const LEVEL_MIN_RANK: Record<RoomPolicyLevel, number> = { everyone: 0, mods: 2, host: 3 };

/**
 * May this member drive the room's playback? The same gate the web app puts
 * in front of every transport send. Unknown policy or role denies — the
 * intent is then simply not forwarded, and the driver corrects the local
 * player exactly as it corrects any other viewer's.
 */
export function canControlPlayback(
  level: RoomPolicyLevel | null,
  role: MemberRole | null,
): boolean {
  if (level === null || role === null) return false;
  return ROLE_RANK[role] >= LEVEL_MIN_RANK[level];
}

function parsePolicyLevel(value: unknown): RoomPolicyLevel | null {
  return value === 'everyone' || value === 'mods' || value === 'host' ? value : null;
}

function parseMemberRole(value: unknown): MemberRole | null {
  return value === 'guest' || value === 'member' || value === 'moderator' || value === 'host'
    ? value
    : null;
}

/**
 * Read the room's playbackControl policy and our own membership from the
 * room's record — the token names us, so this works on the handoff path too,
 * where no page is allowed to tell this worker who the user is. Failing is
 * survivable: both fields stay null, null denies, and every other part of the
 * room still works.
 */
async function loadRoomAccess(): Promise<void> {
  if (session === null) return;
  const roomId = session.roomId;
  const res = await fetch(`${API_URL}/rooms/${encodeURIComponent(roomId)}`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }).catch(() => null);
  if (res === null || !res.ok) return;
  const body = (await res.json().catch(() => null)) as {
    room?: { policies?: { playbackControl?: unknown } };
    member?: { role?: unknown; userId?: unknown };
  } | null;
  // The user may have left, or moved rooms, while this was in flight.
  if (session === null || session.roomId !== roomId) return;
  session.playbackPolicy = parsePolicyLevel(body?.room?.policies?.playbackControl);
  session.role = parseMemberRole(body?.member?.role);
  // WHO WE ARE, from the same record and for the same reason: the token names
  // us. It is the only source on the handoff path — the web app deliberately
  // sends no user id, because a page may not tell this worker who it is
  // talking to — and a share signed with any other name reaches nobody (D2).
  const memberId = body?.member?.userId;
  if (typeof memberId === 'string' && memberId.length > 0 && session.userId !== memberId) {
    session.userId = memberId;
    // A revived worker must not have to fetch this again.
    await persistSession();
  }
}

/**
 * How long a caller waits for the room to say who we are before giving up.
 * Comfortably longer than a round trip, short enough that an unanswered
 * request costs a sentence rather than a control that never comes back.
 */
const IDENTITY_WAIT_MS = 4000;

/**
 * Our own user id, fetched if this session does not know it yet.
 *
 * The popup path learns it at guest join and the handoff path learns it from
 * {@link loadRoomAccess}, which openSession starts without waiting — so the
 * only caller that has to force the issue is one that cannot proceed without
 * it. Returns null when the room genuinely cannot place us, which is a
 * refusal, never a guess.
 */
async function ensureUserId(): Promise<string | null> {
  if (session === null) return null;
  if (session.userId !== null) return session.userId;
  // Bounded, because `loadRoomAccess` has no timeout of its own and this sits
  // in front of a button somebody just pressed. Losing the race is not an
  // error: the fetch may still land and fill the session in, and the caller's
  // own refusal already tells the person to try again in a moment.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    loadRoomAccess(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, IDENTITY_WAIT_MS);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return session?.userId ?? null;
}

/** Longest body the room accepts (contracts: ClientChatSend). */
const MAX_CHAT_BODY = 8000;

/**
 * Chat typed into the overlay. Only the tab that holds the room may send —
 * the panel exists in exactly one tab, and a message from anywhere else would
 * be a message from a tab that is not in this room.
 */
async function sendRoomChat(tabId: number | null, text: string): Promise<null> {
  if (session === null || tabId === null || tabId !== session.drivenTabId) {
    throw new Error('This tab is not in the room.');
  }
  const body = text.trim().slice(0, MAX_CHAT_BODY);
  if (body.length === 0) throw new Error('There was nothing to send.');
  session.socket.send('chat.send', {
    kind: 'text',
    body,
    gifUrl: null,
    attachment: null,
    replyTo: null,
    mentions: [],
  });
  return null;
}

/**
 * Open the room in the Gather web app. The first configured web origin is the
 * app's own (see config.ts) — the extension never navigates anywhere else.
 */
async function openRoomInWebApp(): Promise<null> {
  const origin = WEB_ORIGINS[0];
  if (session === null || origin === undefined) throw new Error('No room to open.');
  await chrome.tabs.create({ url: `${origin}/room/${encodeURIComponent(session.roomId)}` });
  return null;
}

/* ── Session lifecycle ── */

interface OpenSessionInput {
  roomId: string;
  roomName: string;
  accessToken: string;
  tabId: number | null;
  source: 'popup' | 'web';
  target: 'auto' | 'sender';
  /** Who we are in the room. Known on the popup path; null on a web handoff. */
  userId: string | null;
  /**
   * Did a PERSON open this room, or did a terminated worker wake up and resume
   * it? The only thing that turns on it is the absence clock (see
   * {@link absentSince}): a person doing something is a person being here, and
   * clears it — a worker waking by itself proves nothing and must not, or the
   * ~30s recycle cycle would reset the clock forever and the room would never
   * be released.
   */
  resumed: boolean;
}

/**
 * Open the room socket. Every request built here uses `API_URL`, the
 * build-time constant — the handed-over token can reach no other host.
 */
async function openSession(input: OpenSessionInput): Promise<void> {
  // A share belongs to the room it started in. Re-opening that same room — the
  // automatic restore after MV3 recycles the worker — must leave it running;
  // opening a DIFFERENT room must stop it, or the room the user just left goes
  // on receiving their screen. Anything else here would either kill shares on a
  // routine worker recycle or leak them across rooms.
  const shareRoom = await sharingRoom();
  if (shareRoom !== null && shareRoom !== input.roomId) await stopSharing();
  await closeSession();
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
    queue: [],
    queueVersion: -1,
    advancedItemId: null,
    restream: null,
    source: input.source,
    target: input.target,
    driver: new ElasticDriver(),
    presence: new Map(),
    driverTarget: null,
    userId: input.userId,
    playbackPolicy: null,
    role: null,
    names: new Map(),
    namesAt: 0,
    chat: [],
  };

  socket.on('sync.state', (ev) => {
    if (session === null) return;
    session.playback = ev.payload;
    driveTab();
    pushOverlay();
  });
  // The queue, for naming the item that ends. Version-guarded exactly as the
  // web and mobile clients guard it: the snapshot reply is written from a room
  // read that can race a broadcast, so an older one must not overwrite what
  // already landed — and a stale queue names the wrong item, which is the one
  // mistake `sync.advance` cannot survive.
  socket.on('queue.state', (ev) => {
    if (session === null || ev.payload.version < session.queueVersion) return;
    session.queue = [...ev.payload.items];
    session.queueVersion = ev.payload.version;
  });
  // Chat is the overlay's reason to exist: the room's conversation, on the page
  // the film is playing on. It is kept here because the panel is torn down and
  // rebuilt with every reload of the site, and a reload must not lose it.
  socket.on('chat.message', (ev) => {
    if (session === null) return;
    const line = chatLineOf(ev.payload);
    if (line === null) return;
    session.chat.push(line);
    if (session.chat.length > OVERLAY_CHAT_MAX) {
      session.chat.splice(0, session.chat.length - OVERLAY_CHAT_MAX);
    }
    noteUnknownName(line.authorId);
    pushOverlay();
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
    pushOverlay();
  });
  socket.on('presence.diff', (ev) => {
    if (session === null) return;
    for (const entry of ev.payload.upserts) notePresence(entry);
    for (const userId of ev.payload.removed) session.presence.delete(userId);
    applyVoiceActivity();
    pushOverlay();
  });
  socket.connect(input.roomId as never, input.accessToken);

  // A revived worker has no queue snapshot: the server's presence entry is
  // still alive, so it does not auto-reply with one on reconnect. Ask
  // explicitly, the same way the web client does on refresh.
  if (input.resumed) {
    socket.send('presence.update', { state: 'watching', wantSnapshot: true });
  }

  if (!input.resumed) await clearAbsence();

  // Beat presence, like every other client. The server's 45s presence TTL is
  // what decides a member has gone, and a DEPARTURE is what releases an active
  // screen share — so a socket that reads presence without ever writing it got
  // its own share declared over about forty-five seconds after it started.
  // The web beats at 15s (apps/web/lib/room-connection.ts); match it, and send
  // the CURRENT state rather than an empty payload, which the server treats as
  // a roster-snapshot request.
  //
  // It beats only while a surface is open, though: an unconditional beat kept
  // a departed member alive forever, which is the same bug from the other end.
  // See {@link presenceBeat}.
  startPresenceBeat();

  // Follow-drift passes between state mutations. One timer, ever.
  startDriveTimer();
  await startKeepalive();

  // Who is in the room, by name (see loadRoomNames). Nothing waits on it.
  void loadRoomNames();
  // Whether WE may drive playback (see loadRoomAccess). Until it lands, a
  // user intent is dropped rather than guessed about.
  void loadRoomAccess();

  await persistSession();
  broadcastStatus();
  pushOverlay();
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
    userId: typeof joined.user?.id === 'string' ? joined.user.id : null,
    resumed: false,
  });
}

/* ── Drive timer + MV3 keepalive ── */

const DRIVE_TICK_MS = 1000;
/** 30s is MV3's floor; anything smaller is silently clamped by Chrome. */
const KEEPALIVE_ALARM = 'gather.keepalive';
const KEEPALIVE_PERIOD_MINUTES = 0.5;

/** Presence heartbeat cadence. Two missed beats still sit inside the server's
 *  45s TTL, the same margin the web client uses. */
const PRESENCE_BEAT_MS = 15_000;

/**
 * How long the room is held open after the last surface closes.
 *
 * A reload window, not a lifetime. The web app drops its event port and opens
 * a fresh one on every navigation inside the room, and a person who reloaded
 * has not left. Two beats is the same margin the beat itself is built on, and
 * it keeps the whole departure — last surface closed, beat stopped, the
 * server's 45s TTL run out — inside a minute and a half.
 */
const SURFACE_GRACE_MS = 30_000;

let presenceBeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The surfaces a person can actually be at — and can actually close.
 *
 * Every one is measured from the BROWSER, never from this worker's memory: an
 * open port in the registry (the page hung up ⇒ the registry lost it), the
 * offscreen document's own existence, and the driven tab still being a tab.
 * That is the whole of how "MV3 recycled the worker" is told apart from "the
 * user is gone": a revived worker re-measures all three and gets exactly the
 * answers the terminated one would have, because none of them live inside it.
 */
interface Surfaces {
  /** A Gather page holding an open event port — the web app's room, usually. */
  webPort: boolean;
  /** A live share. Pixels are leaving this machine; somebody is behind them. */
  share: boolean;
  /** The tab the room drives, which is the tab the overlay is drawn on. */
  drivenTab: boolean;
}

async function readSurfaces(live: Session): Promise<Surfaces> {
  const drivenTab =
    live.drivenTabId !== null &&
    (await chrome.tabs
      .get(live.drivenTabId)
      .then(() => true)
      .catch(() => false));
  return { webPort: ports.size > 0, share: await isSharingLive(), drivenTab };
}

function anySurface(s: Surfaces): boolean {
  return s.webPort || s.share || s.drivenTab;
}

/**
 * When the last surface closed, or null while one is open.
 *
 * Persisted, because the clock has to outlive the worker. MV3 terminates this
 * worker after roughly thirty seconds of quiet and the keepalive alarm revives
 * it; a clock held in memory would be reset by every one of those wakes, and
 * the room would be kept open forever by the very mechanism meant to release
 * it — the immortal beat again, wearing the grace window as a disguise.
 */
async function absentSince(): Promise<number | null> {
  try {
    const bag = await chrome.storage.session.get(ABSENT_SINCE_KEY);
    const value = bag[ABSENT_SINCE_KEY];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Start the clock if it is not already running, and answer when it started. */
async function markAbsent(now: number): Promise<number> {
  const existing = await absentSince();
  if (existing !== null) return existing;
  try {
    await chrome.storage.session.set({ [ABSENT_SINCE_KEY]: now });
  } catch {
    // Storage unavailable: this worker's own grace still runs from `now`.
  }
  return now;
}

async function clearAbsence(): Promise<void> {
  try {
    await chrome.storage.session.remove(ABSENT_SINCE_KEY);
  } catch {
    // Nothing to clear that anybody can read.
  }
}

/**
 * Keep this member's presence entry alive for as long as somebody is here.
 * Idempotent: a second call replaces the timer rather than adding one.
 */
function startPresenceBeat(): void {
  stopPresenceBeat();
  presenceBeatTimer = setInterval(() => {
    void presenceBeat();
  }, PRESENCE_BEAT_MS);
}

/**
 * One beat.
 *
 * Presence is the claim that a person is in this room, so it is written only
 * while one of {@link readSurfaces} holds. Beating regardless is what made a
 * departed member immortal: their entry never expired, `onDeparture` never
 * fired, and the screen share they walked away from was never released.
 *
 * When nothing holds, the beat simply stops — the server's TTL then runs out
 * on its own, which is the event the room is built around — and the socket is
 * released once the grace window has passed.
 */
async function presenceBeat(): Promise<void> {
  const live = session;
  if (live === null) {
    stopPresenceBeat();
    return;
  }
  const present = anySurface(await readSurfaces(live));
  // Awaiting gave the room a chance to change underneath us. This beat speaks
  // for the session it measured and for no other.
  if (session !== live) return;
  if (present) {
    await clearAbsence();
    if (session !== live) return;
    // Re-assert what we already are. An empty payload would be read by the
    // server as a snapshot request and cost a full roster reply every beat.
    live.socket.send('presence.update', {
      state: 'watching',
      sharing: live.restream?.active === true && live.restream.hostUserId === live.userId,
    });
    return;
  }
  const since = await markAbsent(Date.now());
  if (Date.now() - since < SURFACE_GRACE_MS) return;
  if (session !== live) return;
  await releaseAbsentSession();
}

/**
 * The grace ran out: let the room go. A live share is itself a surface, so
 * this is unreachable while anything is being captured — there is nothing to
 * stop here, only a socket to release and a persisted session to forget, so
 * the next wake does not resume a room nobody is in.
 */
async function releaseAbsentSession(): Promise<void> {
  await closeSession();
  await clearAbsence();
  broadcastStatus();
}

function stopPresenceBeat(): void {
  if (presenceBeatTimer !== null) {
    clearInterval(presenceBeatTimer);
    presenceBeatTimer = null;
  }
}

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
    // The sync sentence ("Buffering — holding your place") changes without any
    // room event at all, so the overlay is refreshed on the same beat. It only
    // sends when the state actually differs — see pushOverlay.
    pushOverlay();
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
  stopPresenceBeat();
});

/**
 * Drop the session's socket, timers and telemetry WITHOUT touching a live
 * share.
 *
 * This is split from `disconnect()` because the two callers mean opposite
 * things by "end the session". `openSession()` resets state before every
 * connect — including the automatic `restoreSession()` that runs whenever MV3
 * recycles the service worker, which is roughly every 30s of quiet. Tearing
 * the capture down there would kill a live share for no reason the user could
 * see or act on. The offscreen document deliberately outlives the worker.
 */
async function closeSession(): Promise<void> {
  stopDriveTimer();
  stopPresenceBeat();
  if (session !== null) {
    if (session.drivenTabId !== null) {
      const frameId = drivenFrameId(session.drivenTabId);
      if (frameId !== null) sendToFrame(session.drivenTabId, frameId, { kind: 'driveOff' });
      // The room is over; the panel that says otherwise goes with it.
      sendToFrame(session.drivenTabId, TOP_FRAME_ID, { kind: 'overlayOff' });
    }
    session.socket.close();
    session = null;
  }
  lastOverlayPush = null;
  lastTelemetry = null;
  await stopKeepalive();
  await persistSession();
}

/**
 * The user is leaving the room. The share belonged to that room, so the pixels
 * stop leaving this machine — not merely that we stop calling it a share.
 */
async function disconnect(): Promise<void> {
  await stopSharing();
  await closeSession();
}

/* ── chrome.storage.session mirror (survives service-worker death) ── */

const SESSION_KEY = 'gather.session.v1';
const SHARING_ROOM_KEY = 'gather.sharing-room.v1';
/** When the last surface closed. See {@link absentSince}. */
const ABSENT_SINCE_KEY = 'gather.absent-since.v1';

async function persistSharingRoom(): Promise<void> {
  try {
    if (sharingRoomId === null) await chrome.storage.session.remove(SHARING_ROOM_KEY);
    else await chrome.storage.session.set({ [SHARING_ROOM_KEY]: sharingRoomId });
  } catch {
    // Storage unavailable — the in-memory value still serves this worker.
  }
}

/**
 * The room a live share belongs to, preferring the persisted value because the
 * worker may have been recycled since the share started.
 */
async function sharingRoom(): Promise<string | null> {
  if (sharingRoomId !== null) return sharingRoomId;
  try {
    const bag = await chrome.storage.session.get(SHARING_ROOM_KEY);
    const value = bag[SHARING_ROOM_KEY];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

interface PersistedSession {
  roomId: string;
  roomName: string;
  accessToken: string;
  drivenTabId: number | null;
  source: 'popup' | 'web';
  target: 'auto' | 'sender';
  /** Kept so a revived worker still knows which person in the room is you. */
  userId: string | null;
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
      userId: session.userId,
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
    userId: typeof stored.userId === 'string' ? stored.userId : null,
    // Nobody asked for this. The worker died and something woke it.
    resumed: true,
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
  /**
   * Who the sharer is in this room, from the room's own record — never from
   * the page that handed the room over. The offscreen document signs every
   * signalling frame as this person, and each viewer derives the pair's
   * connectionId from both ids; the server stamps the sender's id from the
   * authenticated socket, so any other name fails that guard in both
   * directions and the share reaches nobody at all (D2).
   */
  userId: string;
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

/**
 * The background → offscreen stop. Idempotent by contract: it is sent whenever
 * this worker wants to be *sure* nothing is being captured, including when the
 * document has already stopped on its own, and is answered `ok` either way.
 */
export interface OffscreenStopMessage {
  kind: 'stopShare';
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
  /** Who we are in this room. Not nullable on purpose: a share cannot be
   *  planned without it, so the refusal happens before this type exists. */
  userId: string;
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

/** The document exists only to capture, so its existence IS a live share. */
async function hasOffscreen(): Promise<boolean> {
  return chrome.offscreen.hasDocument().catch(() => false);
}

/**
 * Is anything being captured right now?
 *
 * ONE expression, called from both places that ask: the popup's "am I
 * sharing?" and the presence beat's "is anybody still here?". They must never
 * be able to disagree — a popup that says the share is live while the beat has
 * decided nobody is here is exactly the orphaned share this worker exists to
 * avoid. The browser's answer carries the weight: `sharingSource` is a module
 * variable that MV3 erases on every recycle, while the offscreen document
 * survives one on purpose.
 */
async function isSharingLive(): Promise<boolean> {
  return sharingSource !== null || (await hasOffscreen());
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'WEB_RTC' as chrome.offscreen.Reason],
    justification: 'Screen, window or tab capture + WebRTC fan-out for Mode B room share',
  });
}

/**
 * End any share, from any of the ways one can end. Every step tolerates
 * "there is nothing there" — a second disconnect, a capture that never
 * started, a worker that was terminated and no longer remembers the share it
 * began — because a screen that goes on streaming after the user left the room
 * is the one outcome that is never acceptable. Nothing here throws.
 */
async function stopSharing(): Promise<void> {
  sharingSource = null;
  sharingTabId = null;
  sharingRoomId = null;
  await persistSharingRoom();
  if (!(await hasOffscreen())) return;
  // The document owns the tracks, the mesh and the share socket. It stops
  // them and tells the room the share ended; closing it here would otherwise
  // leave viewers on a frozen last frame.
  const stop: OffscreenStopMessage = { kind: 'stopShare' };
  await chrome.runtime.sendMessage(stop).catch(() => undefined);
  await chrome.offscreen.closeDocument().catch(() => undefined);
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
    userId: room.userId,
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
    // black-frames it by design, and Gather never re-encodes protected media.
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

/** No sentence below names an API, an error code, or a constraint. */
const SHARE_FAILED_NOTE = 'That share could not start — nothing is going to the room.';
const SHARE_REFUSED_NOTE = 'Chrome did not allow that — try again and pick what to share.';
/**
 * We are in the room but cannot yet say which member we are, so a share would
 * be signed with a name no viewer can match and would reach nobody. Waiting a
 * moment is the whole fix, and that is what the sentence says — it does not
 * mention ids, meshes or the room record.
 */
const SHARE_NO_IDENTITY_NOTE =
  'Still getting you settled in this room — give it a moment and try sharing again.';

/** Capture failures arrive as browser error text; a person gets a sentence. */
export function shareFailureNote(error: string): string {
  return /permission|notallowed|denied/i.test(error) ? SHARE_REFUSED_NOTE : SHARE_FAILED_NOTE;
}

/**
 * What the offscreen document actually did, read from its answer.
 *
 * `sendMessage` resolving says only that the message was delivered: a capture
 * the document refused answers `{ ok: false }` through exactly the same happy
 * path, and reporting that as a share would leave the popup claiming a room is
 * seeing something nobody is sending. No answer at all is a failure too — we
 * cannot confirm a capture we never heard back about.
 */
export function readShareReply(
  raw: unknown,
  plan: { note: string; canRequestAudioTrack: boolean },
): ShareResult {
  const bag = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  if (bag === null || bag['ok'] !== true) {
    const error = typeof bag?.['error'] === 'string' ? bag['error'] : '';
    return { shared: false, cancelled: false, note: shareFailureNote(error) };
  }
  // The document is the only witness to whether sound actually came over, so
  // its sentence wins wherever the plan promised sound and there was none.
  const note = typeof bag['note'] === 'string' ? bag['note'] : '';
  const silent = bag['audio'] !== true && plan.canRequestAudioTrack && note.length > 0;
  return { shared: true, cancelled: false, note: silent ? note : plan.note };
}

/**
 * The picker can stay open for as long as the user takes to choose, and this
 * worker may be terminated while it is open — in which case the callback never
 * arrives and the popup, which Chrome closed the moment the picker took focus,
 * is not there to care. The share is simply not started; the user presses the
 * button again.
 */
async function startShare(surface: ShareSurface = 'tab'): Promise<ShareResult> {
  if (session === null) throw new Error('connect to a room first');
  // Who we are decides whether this share reaches anybody at all (see
  // OffscreenShareMessage.userId), so it is settled BEFORE the picker opens —
  // a person should not choose a window for a share that will then be refused.
  // Usually already known; the await only bites on a handoff whose room record
  // has not landed yet.
  const userId = await ensureUserId();
  if (session === null) {
    return { shared: false, cancelled: false, note: 'That room ended before the share started.' };
  }
  if (userId === null) return { shared: false, cancelled: false, note: SHARE_NO_IDENTITY_NOTE };
  // Read the room BEFORE awaiting the picker: the user may disconnect while it
  // is open, and a share must never be started against a room that ended.
  const room: ShareRoom = {
    roomId: session.roomId,
    accessToken: session.accessToken,
    tabId: session.drivenTabId,
    userId,
  };
  const plan = await planShare(room, surface, browserShareDeps);
  if (!plan.start) return { shared: false, cancelled: true, note: plan.note };
  if (session === null || session.roomId !== room.roomId) {
    return { shared: false, cancelled: false, note: 'That room ended before the share started.' };
  }
  await ensureOffscreen();
  const raw: unknown = await chrome.runtime.sendMessage(plan.message).catch(() => undefined);
  const result = readShareReply(raw, {
    note: plan.note,
    canRequestAudioTrack: plan.message.canRequestAudioTrack,
  });
  if (!result.shared) {
    // Nothing is capturing: leave neither a document nor a claim behind.
    await stopSharing();
    return result;
  }
  sharingSource = plan.message.source;
  sharingTabId = plan.message.source === 'tab' ? room.tabId : null;
  sharingRoomId = room.roomId;
  await persistSharingRoom();
  return result;
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
  // Casting is a button press the user asked for, not a claim on the element,
  // so an unelected tab still gets asked — at its top frame, where a site's
  // own cast control usually lives.
  const frameId = drivenFrameId(tabId) ?? TOP_FRAME_ID;
  const res = (await chrome.tabs
    .sendMessage(tabId, { kind: 'castNative' }, { frameId })
    .catch(() => undefined)) as { clicked?: boolean; reason?: string } | undefined;
  if (res === undefined) {
    return { clicked: false, reason: 'Gather is not running on this page yet — reload it and try again.' };
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
      // The handoff says which room, never who: the page is not allowed to
      // name a user to this worker. Nobody is marked "you" until it does.
      userId: null,
      resumed: false,
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
  /**
   * The page hanging up is the ONLY signal a closed web tab produces, and
   * nothing here used to listen for it: the registry quietly shrank and the
   * presence beat went on telling the room the person was in it.
   *
   * `ports.add` removes the port on this same event, so removing it again is
   * a no-op — it is written out anyway so this handler cannot be broken by a
   * change of listener order. Then the surfaces are re-read at once, because a
   * beat that waited up to fifteen seconds to notice is fifteen seconds of a
   * claim that is not true.
   */
  port.onDisconnect.addListener(() => {
    ports.remove(port);
    void presenceBeat();
  });
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
    case 'popup:stopShare':
      return respond(stopSharing());
    /**
     * The capture ended without us — Chrome's own "Stop sharing" bar, or the
     * shared tab closing. The offscreen document has already told the room and
     * stopped the tracks; this clears the claim and closes the document, so
     * the next share starts from nothing.
     */
    case 'shareEnded':
      return respond(stopSharing());
    case 'popup:cast':
      return respond(castActiveTab());
    /**
     * The injected overlay's whole channel (see overlay/state.ts). It reaches
     * the worker through the tab's content script, so `sender.tab` is the
     * browser's own word for which tab is asking — the page never names one.
     *
     * `overlay:state` doubles as the content script's "is this tab in a room?":
     * the answer is the room, or null, and null is what every tab that is not
     * the room's tab receives.
     */
    case 'overlay:state':
      return respond(Promise.resolve(overlayStateFor(sender.tab?.id ?? null)));
    case 'overlay:chat':
      return respond(sendRoomChat(sender.tab?.id ?? null, String(msg['text'] ?? '')));
    case 'overlay:leave':
      return respond(
        disconnect().then(() => {
          broadcastStatus();
          return null;
        }),
      );
    case 'overlay:open-app':
      return respond(openRoomInWebApp());
    case 'frameClaim': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined && sender.frameId !== undefined) {
        onFrameClaim(tabId, sender.frameId, msg);
      }
      return false;
    }
    case 'popup:status':
      return respond(
        (async () => ({
          connected: session !== null,
          roomName: session?.roomName ?? null,
          playing: session?.playback?.playing ?? false,
          telemetry: lastTelemetry,
          provider,
          // A share this worker no longer remembers — it was terminated and
          // revived while the capture ran — is still a share, and the document
          // still being open is the browser's own proof of it.
          sharing: await isSharingLive(),
        }))(),
      );
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
      // Only the elected frame of the driven tab speaks for the room. Other
      // tabs — and other frames of this one — may have media of their own, and
      // reporting theirs would be both wrong and a leak. The election decides
      // this here too, for the same reason it decides who may be driven.
      if (
        session !== null &&
        tabId !== undefined &&
        tabId === session.drivenTabId &&
        sender.frameId === drivenFrameId(tabId)
      ) {
        lastTelemetry = payload;
        ports.broadcast((v) => eventMessage('telemetry', payload, v));
      }
      return false;
    }
    /**
     * The user's own hand on the driven site's player (see content.ts). It
     * becomes room intent on the SAME wire the web app's transport uses —
     * sync.play / sync.pause / sync.seek with the local position — under the
     * same policy gate the room applies to everyone else. Only the elected
     * frame of the driven tab speaks; the election decides here exactly as it
     * decides for telemetry.
     */
    case 'userIntent': {
      const tabId = sender.tab?.id;
      if (
        session === null ||
        session.playback === null ||
        tabId === undefined ||
        tabId !== session.drivenTabId ||
        sender.frameId !== drivenFrameId(tabId)
      ) {
        return false;
      }
      const intent = msg['intent'];
      if (intent !== 'play' && intent !== 'pause' && intent !== 'seek') return false;
      const raw = msg['positionMs'];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return false;
      const positionMs = Math.max(0, raw);
      // Buffering looks like a pause and is not one. The driver already judges
      // stall from this tab's telemetry — reuse that judgement, never a second.
      if (intent === 'pause' && session.driver.state().stalled) return false;
      // A member the room does not let drive playback is drift, by design:
      // nothing is sent, and the driver corrects their player as it always did.
      if (!canControlPlayback(session.playbackPolicy, session.role)) return false;
      if (intent === 'play') session.socket.send('sync.play', { positionMs });
      else if (intent === 'pause') session.socket.send('sync.pause', { positionMs });
      else session.socket.send('sync.seek', { positionMs });
      // The just-sent intent must not read as drift while the room echoes it.
      session.driver.noteLocalIntent(intent, positionMs, Date.now());
      return false;
    }
    /**
     * The driven item ran out (see content.ts). It travels on its own event
     * and never as a pause: the content script's intent detector deliberately
     * drops the pause arriving at the end causes ("arrival, not intent"), so
     * this message is the ONLY thing that says the item is over. Without it a
     * room driven from here sits on the last frame forever.
     *
     * The worker does not decide what to do about it — advancing a queue is
     * the room's business and the page's. It reports the fact, with the
     * duration beside it so the page can clamp a projection that has nothing
     * left to project into, and the item's key so a page that already moved on
     * can ignore a late end. The same election gate as telemetry: only the
     * elected frame of the driven tab speaks for the room.
     *
     * Nothing is de-duplicated here. The content script already makes exactly
     * one judgement per item (driver.ts's MediaEndDetector), and a second,
     * disagreeing judgement in this worker would give one end two answers.
     */
    case 'mediaEnded': {
      const tabId = sender.tab?.id;
      if (
        session === null ||
        tabId === undefined ||
        tabId !== session.drivenTabId ||
        sender.frameId !== drivenFrameId(tabId)
      ) {
        return false;
      }
      const rawPosition = msg['positionMs'];
      const rawDuration = msg['durationMs'];
      const payload: EndedPayload = {
        positionMs:
          typeof rawPosition === 'number' && Number.isFinite(rawPosition)
            ? Math.max(0, rawPosition)
            : 0,
        durationMs:
          typeof rawDuration === 'number' && Number.isFinite(rawDuration)
            ? Math.max(0, rawDuration)
            : 0,
        mediaKey: mediaKeyOf(session.playback?.mediaRef ?? null),
        at: Date.now(),
      };
      ports.broadcast((v) => eventMessage('ended', payload, v));
      // …and to the ROOM, on this worker's own socket. The broadcast above
      // reaches a Gather tab; there may not be one. See reportEndedItem.
      reportEndedItem();
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
