/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PlaybackDriver — the one contract — and the extension's elastic corrector
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Five things live here, and they are deliberately separate:
 *
 *  1. {@link PlaybackDriver}: the interface EVERY playback surface implements
 *     (docs/EXTENSION_FIRST.md, Part 2 "One contract, three implementations").
 *     Web adapters, this extension's content script, and mobile native all
 *     conform, so "which surface drives playback" becomes a runtime decision
 *     per item rather than an architectural fork.
 *
 *  2. {@link ElasticDriver}: the correction engine that sits ABOVE a driver.
 *     It owns a sync-core {@link DriftController} seeded with the elastic
 *     presets, feeds it real observations, and yields play/pause/seek/rate
 *     commands. It never touches the DOM, chrome.* or Date.now — every input
 *     arrives as an argument — which is what makes the whole sync policy
 *     unit-testable.
 *
 *  3. {@link ElasticDirective} and its parser: that decision as it crosses to
 *     the content script, which applies it verbatim. The decision is made
 *     ONCE, here; anything downstream that re-derives it from raw positions
 *     defeats the learned anchor, the seek rate-limiter and every deliberate
 *     non-correction ('stalled', 'seek-suppressed', 'rate-locked').
 *
 *  4. {@link UserIntentDetector}: the content-side judgement that a transport
 *     event on the driven element was the USER's hand on the site's own
 *     player — not an echo of a command we applied, not a commanded seek
 *     landing, not arrival at the end. What it recognises becomes room intent
 *     (background.ts forwards it under the room's permission model), and
 *     {@link ElasticDriver.noteLocalIntent} keeps the corrector from fighting
 *     it while the room echoes it back.
 *
 *  5. {@link MediaEndDetector}: the other half of that judgement. Because a
 *     pause caused by arrival at the end is deliberately NOT intent, the end
 *     has to be reported on its own channel — or it is never reported at all,
 *     and the room stalls forever on the last frame of the item.
 *
 * ── Why a driver contract and not just an adapter ──────────────────────────
 * apps/web's `PlayerAdapter` OWNS its player: it created the <video> or the
 * YouTube iframe, so `load()` and `seekTo()` always mean something. A driver
 * on a third-party site owns nothing. It observes and corrects someone else's
 * player, which may refuse a rate change, refuse a seek, swap its media
 * element mid-playback, or be protected by DRM. So the contract adds:
 *
 *   - {@link DriverCapabilities} — canSeek / canSetRate / canControlVolume /
 *     isDrmProtected, reported honestly and allowed to change at runtime once
 *     the driver has *evidence* (a rate assignment that was silently ignored).
 *   - {@link CommandResult} — a command may be refused, not just performed.
 *   - {@link DriverTelemetry} — one consistent observation, timestamped, so a
 *     corrector running in another process (this extension's background
 *     worker) can reason about staleness instead of assuming "now".
 *
 * ── The honest stops (docs/EXTENSION_FIRST.md, Parts 1 and 3) ──────────────
 * Nothing here defeats DRM, captures a protected surface, or re-encodes
 * anything: the only outputs are transport commands, a seek target and a
 * playbackRate for a player the *user* is already entitled to play. When a
 * player refuses rate control, the anchor absorbs the offset — we do not fall
 * back to seeking repeatedly, because a seek is precisely what wrecks
 * perceived quality (SoundCloud re-buffers; a DRM player renegotiates its
 * licence and stalls for seconds).
 */

import { DriftController, LISTEN_ELASTIC, STRICT_SYNC, WATCH_ELASTIC } from '@gather/sync-core';
import type { ElasticDriftOptions } from '@gather/sync-core';
import type { MediaRef } from '@gather/contracts';

import type { DriveDecision } from './mediaDriver';

/* ═════════════════════════ 1. the shared contract ════════════════════════ */

/** Which surface a driver runs on. */
export type PlaybackSurface = 'web' | 'extension' | 'native';

/**
 * Lifecycle events every driver emits. A superset of apps/web's
 * `AdapterEvent`: the extra three exist only because a driver does not own its
 * player and therefore has to report things being done *to* it.
 */
export type DriverEvent =
  | 'ready' // position/duration are meaningful
  | 'playing'
  | 'paused'
  | 'ended'
  | 'buffering' // 'waiting' / 'stalled'
  | 'buffered' // recovered
  | 'durationchange'
  | 'error'
  /** The player moved itself (the user scrubbed the site's own control). */
  | 'seeked'
  /** The player's rate changed under us — including a rate WE set being undone. */
  | 'ratechange'
  /** The surface swapped the media out from under us (SPA route, next track). */
  | 'trackchange';

/**
 * What a driver can actually do — reported, never assumed. Flags may change at
 * runtime: `canSetRate` starts optimistic and goes false the first time an
 * assignment is observed to have been ignored.
 */
export interface DriverCapabilities {
  /** Seeking is possible at all. False for embeds with no position API. */
  canSeek: boolean;
  /** `playbackRate` is honoured. DRM players frequently accept and ignore it. */
  canSetRate: boolean;
  canControlVolume: boolean;
  /** EME/protected media: never capture, mirror or re-encode. */
  isDrmProtected: boolean;
  /** False when the driver only observes and corrects a player it did not create. */
  ownsPlayer: boolean;
  /** False when position readings are absent or approximate (embed players). */
  canObservePosition: boolean;
}

/** A command is a request, not a guarantee. */
export type CommandResult = 'applied' | 'rejected' | 'unsupported';

/** One consistent, timestamped reading of a player. */
export interface DriverTelemetry {
  positionMs: number;
  /** 0 while unknown (pre-metadata, or a live stream). */
  durationMs: number;
  playing: boolean;
  rate: number;
  /** Client clock at capture. Lets a remote corrector reason about staleness. */
  atMs: number;
}

/**
 * THE CONTRACT. Implemented by:
 *
 *   web       apps/web/lib/player/* — already shaped like this; needs
 *             `capabilities()`, `observe()` and CommandResult returns.
 *   extension this repo — mediaDriver.ts measures and applies, content.ts is
 *             the DOM plumbing, and the elected frame is the driver instance.
 *   native    AVPlayer / ExoPlayer / WebView behind the same methods.
 *
 * Method names match apps/web's `PlayerAdapter` on purpose, so conforming is a
 * widening, not a rewrite.
 */
export interface PlaybackDriver {
  readonly surface: PlaybackSurface;
  /** Implementation id: 'native' | 'youtube' | 'content-script' | 'exoplayer' … */
  readonly kind: string;

  /** Current honest capability set. Cheap; may change between calls. */
  capabilities(): DriverCapabilities;

  /**
   * Point the surface at a ref. A driver that does not own its player returns
   * 'unsupported' — the user navigates to their own copy; we never navigate
   * anybody's browser to paid content on their behalf.
   */
  load(ref: MediaRef): CommandResult;

  play(): CommandResult;
  pause(): CommandResult;
  seekTo(ms: number): CommandResult;
  setRate(rate: number): CommandResult;
  setMuted(muted: boolean): CommandResult;
  isMuted(): boolean | null;
  setVolume(volume: number): CommandResult; // 0..1

  positionMs(): number;
  /** 0 while unknown. */
  durationMs(): number;
  /** One atomic reading; null when no player is attached. */
  observe(): DriverTelemetry | null;

  on(evt: DriverEvent, cb: () => void): () => void;
  destroy(): void;
}

/** Neutral starting point: optimistic about rate, honest about ownership. */
export const OBSERVER_CAPABILITIES: Readonly<DriverCapabilities> = Object.freeze({
  canSeek: true,
  canSetRate: true,
  canControlVolume: true,
  isDrmProtected: false,
  ownsPlayer: false,
  canObservePosition: true,
});

/* ═════════════════════════ 2. elastic correction ═════════════════════════ */

/** Which comfort band a room plays under. */
export type SyncProfile = 'strict' | 'watch' | 'listen';

/**
 * The three bands, straight from sync-core. `strict` is frame-lock and is kept
 * only for a single device driving two of its own players — it is NOT the
 * room default any more (docs/EXTENSION_FIRST.md Part 1).
 */
export const SYNC_PRESETS: Readonly<Record<SyncProfile, Readonly<ElasticDriftOptions>>> =
  Object.freeze({
    strict: STRICT_SYNC,
    watch: WATCH_ELASTIC,
    listen: LISTEN_ELASTIC,
  });

/** Services whose content is music: rate-nudging is audible, so listen bands. */
const LISTEN_PROVIDER_IDS: readonly string[] = [
  'soundcloud',
  'spotify',
  'applemusic',
  'tidal',
  'deezer',
  'youtubemusic',
];

/**
 * Pick the band for what is actually playing. The room's own kind wins when we
 * know it; otherwise an `<audio>` element or a music service is the tell. When
 * nothing is known, watch — the wider rate authority is the safer default for
 * dialogue, and a music room that guesses wrong only converges faster than it
 * needed to for one track.
 */
export function profileForContent(input: {
  roomKind?: 'watch' | 'listen' | null;
  providerId?: string | null;
  mediaTag?: 'audio' | 'video' | null;
}): SyncProfile {
  if (input.roomKind === 'listen') return 'listen';
  if (input.roomKind === 'watch') return 'watch';
  if (input.mediaTag === 'audio') return 'listen';
  if (input.providerId !== null && input.providerId !== undefined) {
    if (LISTEN_PROVIDER_IDS.includes(input.providerId)) return 'listen';
  }
  return 'watch';
}

/** Stable identity for the room's current media. A change is a track change. */
export function mediaKeyOf(ref: MediaRef | null): string | null {
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
    // An arbitrary web page the room queued: the url IS the identity, and it
    // is what the generic driver goes looking for a player on.
    case 'page':
      return `page:${ref.url}`;
  }
}

/** The presence fields the band cares about. */
export interface PresenceLike {
  userId: string;
  /** PresenceState from contracts; only 'offline' is treated specially. */
  state: string;
  micOn: boolean;
}

/**
 * Is live voice happening in this room right now?
 *
 * docs/EXTENSION_FIRST.md Consequence B: the call does NOT travel the content's
 * path. Voice is ~50–150ms peer-to-peer while viewers may be 8s apart in the
 * content, so a live mic is the one spoiler vector media-anchored chat cannot
 * close. When anybody is on mic the band tightens.
 *
 * Note that the local user's OWN mic counts. If I am the only one talking, my
 * reactions still have to make sense to the people hearing them, so my playback
 * is the one that has to stay in step. What does NOT count is talking to
 * nobody: a single member alone in the room has nothing to stay in step with.
 */
export function voiceActiveFrom(entries: Iterable<PresenceLike>): boolean {
  let present = 0;
  let mics = 0;
  for (const entry of entries) {
    if (entry.state === 'offline') continue;
    present += 1;
    if (entry.micOn) mics += 1;
  }
  return mics > 0 && present > 1;
}

/* ── the tick contract ── */

/** What the room believes, at the instant of this tick. */
export interface RoomFrame {
  /** Room position projected to now, in media time (expectedPositionMs). */
  expectedMs: number;
  playing: boolean;
  rate: number;
  /** Identity of the room's media; see {@link mediaKeyOf}. */
  mediaKey: string | null;
}

/** Why the driver did what it did — for the debug HUD and the room status chip. */
export type DriveReason =
  /** Inside the comfort band. Doing nothing is the point. */
  | 'idle'
  /** Host intent: play/pause. Never subject to the band. */
  | 'transport'
  | 'nudge'
  | 'seek'
  /** A seek was warranted but the player refused it (cannot seek, has ignored
   *  the last ones, or one went out too recently). Live voice does NOT land
   *  here: the controller withholds the seek itself while it tightens, and
   *  releases it past its own ceiling — see {@link ElasticDriver.canSeekNow}. */
  | 'seek-suppressed'
  /** The player is buffering. Correcting into a stall makes it worse. */
  | 'stalled'
  /** Outside the band, but this player ignores playbackRate — the anchor holds it. */
  | 'rate-locked'
  /** Undoing a leftover nudge once we are back inside the band. */
  | 'restore-rate'
  /** The user's own gesture was forwarded to the room; not fought while the
   *  room echoes it back (see {@link ElasticDriver.noteLocalIntent}). */
  | 'user-intent'
  /** Nothing observed yet: fall back to plain follow-the-room. */
  | 'no-telemetry';

/** One tick's prescription. `idle` means: send the player nothing at all. */
export interface DriveCommand {
  transport: 'play' | 'pause' | 'none';
  seekToMs: number | null;
  /** ABSOLUTE playbackRate to assign (room rate × nudge), or null to leave alone. */
  setRate: number | null;
  /**
   * The position to put on the legacy `{kind:'drive'}` wire message. It equals
   * `seekToMs` when a seek is prescribed and the player's own current position
   * otherwise, so a content script running the OLD fixed bands
   * (mediaDriver.decideDrive, 400ms/2s) reproduces this decision exactly: it
   * seeks when and only when the elastic decision says seek.
   */
  wirePositionMs: number;
  /** True when nothing should be sent to the player this tick. */
  idle: boolean;
  /** Post-anchor drift (positive → this viewer is behind). */
  driftMs: number;
  anchorOffsetMs: number;
  reason: DriveReason;
}

/* ── the wire block: this decision, carried to the content script ── */

/**
 * A {@link DriveCommand} as it crosses the process boundary — background.ts's
 * drive loop puts this on the `drive` message as `elastic`, and the content
 * script applies it VERBATIM.
 *
 * It is narrowed to what may actually touch a player. `wirePositionMs` belongs
 * to the message rather than here (it is the compatibility shim for a content
 * script that predates this block), and `driftMs`/`anchorOffsetMs` are carried
 * for a HUD that does not exist inside a content frame — so neither is parsed.
 */
export interface ElasticDirective {
  transport: 'play' | 'pause' | 'none';
  seekToMs: number | null;
  setRate: number | null;
  /**
   * The worker's own label for this decision. Descriptive only — the three
   * fields above are what happens. Kept as a plain string, not a
   * {@link DriveReason}, because a reason a newer worker invented must not
   * cost us a perfectly good command. Empty when none was sent.
   */
  reason: string;
}

/** Browsers cap playbackRate here; past it (or at or below zero) the number on
 *  the wire is corruption, not a decision. */
const MAX_WIRE_RATE = 16;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Read the `elastic` block off a `drive` message.
 *
 * It arrives from a worker that may be a DIFFERENT BUILD of this extension, so
 * nothing here is trusted: anything unexpected in the three command fields
 * returns null and the caller falls back to the legacy fixed-band corrector
 * rather than guessing what was meant. Total — it runs inside the drive loop
 * and must never throw.
 */
export function parseElasticDirective(raw: unknown): ElasticDirective | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const transport = r['transport'];
  if (transport !== 'play' && transport !== 'pause' && transport !== 'none') return null;

  // `null` is the explicit "leave it alone"; absent is not the same thing, and
  // a build that forgot the field is one we cannot second-guess.
  const seekToMs = r['seekToMs'];
  if (seekToMs !== null && !isFiniteNumber(seekToMs)) return null;

  const setRate = r['setRate'];
  if (setRate !== null && !isFiniteNumber(setRate)) return null;
  if (setRate !== null && (setRate <= 0 || setRate > MAX_WIRE_RATE)) return null;

  return {
    transport,
    seekToMs,
    setRate,
    reason: typeof r['reason'] === 'string' ? r['reason'] : '',
  };
}

/**
 * Is this decision the worker's to make? Every reason but one is.
 *
 * 'no-telemetry' is the worker saying nothing is reporting back to it, and the
 * drive loop sends that one otherwise-idle command precisely so the content
 * script keeps following the room under its own local bands. Honouring it
 * verbatim would mean doing nothing at all, forever, on a tab whose telemetry
 * never arrives.
 */
export function appliesVerbatim(directive: ElasticDirective): boolean {
  return directive.reason !== 'no-telemetry';
}

/**
 * The directive as a command for one media element.
 *
 * Deliberately a rename and nothing more: the worker owns the telemetry, the
 * learned anchor and the seek rate-limiter, so re-deriving any of this
 * downstream is the defect this function exists to close. 'idle', 'stalled',
 * 'seek-suppressed' and 'rate-locked' name themselves by carrying none of the
 * three fields, and the player is then sent nothing at all.
 */
export function elasticDecision(directive: ElasticDirective): DriveDecision {
  return {
    seekToMs: directive.seekToMs,
    setRate: directive.setRate,
    action: directive.transport,
  };
}

/** Observable driver state, for HUDs and the honest room-status string. */
export interface ElasticDriverState {
  profile: SyncProfile;
  anchorOffsetMs: number;
  voiceTightening: boolean;
  rateControlAvailable: boolean;
  seekAvailable: boolean;
  stalled: boolean;
  driftMs: number;
}

export interface ElasticDriverOptions {
  profile?: SyncProfile;
  /** Merged on top of the preset. For tests and per-provider quirks only. */
  tuning?: ElasticDriftOptions;
  capabilities?: Partial<DriverCapabilities>;
}

/* ── tuned constants (all in ms unless noted) ── */

/** A jump in the ROOM's timeline larger than this is a host seek, not drift. */
export const HOST_SEEK_EPSILON_MS = 750;
/** A gap between ticks this large means the worker slept or the tab was frozen. */
export const WAKE_GAP_MS = 4000;
/** Telemetry older than this tells us nothing about now. */
export const TELEMETRY_STALE_MS = 4000;
/** Shortest sample interval that can prove a stall. */
const STALL_MIN_ELAPSED_MS = 400;
/** Advanced less than this fraction of what it should have → stalled. */
const STALL_ADVANCE_FRACTION = 0.25;
/** An unexplained move of the player's own position (user scrubbed, ad break). */
const LOCAL_JUMP_MS = 1500;
/** playbackRate comparison tolerance. */
const RATE_EPSILON = 0.005;
/** Telemetry must be captured at least this long after a rate assignment. */
const RATE_READBACK_GRACE_MS = 250;
/** Never seek more often than this. A DRM licence renegotiation is expensive. */
export const MIN_SEEK_INTERVAL_MS = 5000;
/** …and twice as rarely on protected players. */
export const MIN_SEEK_INTERVAL_DRM_MS = 10_000;
/** A prescribed seek that lands further than this from its target was ignored. */
const SEEK_MISS_MS = 2000;
/** Two ignored seeks in a row and we stop asking. */
const MAX_SEEK_MISSES = 2;
/**
 * After a user's own transport/seek was forwarded to the room, how long the
 * player is shielded from correction while the echo comes back. Comfortably
 * above a socket round-trip plus broadcast, under three ticks — so an intent
 * the room refused (or dropped) is corrected within ~2.5s, which is the
 * room's refusal, honoured.
 */
export const INTENT_ECHO_WINDOW_MS = 2500;

/** Project a telemetry reading forward to `nowMs` at the rate it was running. */
export function projectedPositionMs(local: DriverTelemetry, nowMs: number): number {
  if (!local.playing) return local.positionMs;
  const dt = Math.max(0, nowMs - local.atMs);
  return local.positionMs + dt * local.rate;
}

/**
 * Elastic sync for a player we do not own.
 *
 * Owns one {@link DriftController} and does the work the controller cannot do
 * for itself: turn a stream of room states and player telemetry into
 * observations (buffering, track change, host seek, rate rejection) and turn
 * the controller's abstract action into a concrete command.
 *
 * Every input is an argument — no clock, no DOM, no chrome.*.
 */
export class ElasticDriver {
  private profileName: SyncProfile;
  private readonly tuning: ElasticDriftOptions | undefined;
  private controller: DriftController;
  private caps: DriverCapabilities;

  private lastTickMs: number | null = null;
  private lastRoom: RoomFrame | null = null;
  private lastMediaKey: string | null = null;
  private lastLocal: DriverTelemetry | null = null;

  /** The rate we last asked for, and what the player had before we asked. */
  private prescribedRate: number | null = null;
  private prescribedRateAtMs = 0;
  private rateBeforePrescription = 1;

  private pendingSeek: { toMs: number; atMs: number } | null = null;
  private lastSeekAtMs: number | null = null;
  private seekMisses = 0;

  /** A user intent this driver's owner forwarded to the room, awaiting echo. */
  private localIntent: { kind: UserIntentKind; positionMs: number; atMs: number } | null = null;

  private voiceActive = false;
  private stalled = false;
  private driftMs = 0;

  constructor(opts?: ElasticDriverOptions) {
    this.profileName = opts?.profile ?? 'watch';
    this.tuning = opts?.tuning;
    this.caps = { ...OBSERVER_CAPABILITIES, ...(opts?.capabilities ?? {}) };
    this.controller = this.buildController();
  }

  /* ── configuration ── */

  profile(): SyncProfile {
    return this.profileName;
  }

  /** Switching bands rebuilds the controller; the learned anchor does not
   *  survive, because it was learned under different tolerances. What DOES
   *  survive is what we learned about the player itself — a player that
   *  ignores playbackRate goes on ignoring it in any band. */
  setProfile(profile: SyncProfile): void {
    if (profile === this.profileName) return;
    const rateWasAvailable = this.rateAvailable();
    this.profileName = profile;
    this.controller = this.buildController();
    if (!rateWasAvailable) this.controller.noteRateRejected();
  }

  /** Report what the player can actually do. Partial: unmentioned flags stand. */
  setCapabilities(caps: Partial<DriverCapabilities>): void {
    this.caps = { ...this.caps, ...caps };
    if (caps.canSetRate === false) this.controller.noteRateRejected();
  }

  capabilities(): DriverCapabilities {
    return { ...this.caps, canSetRate: this.caps.canSetRate && this.rateAvailable() };
  }

  /* ── observations the caller can also feed explicitly ── */

  /** 'waiting' / 'stalled' / tab wake / network recovery. The tick loop infers
   *  these from telemetry too, but a content script that sees the real events
   *  should call this — it is a whole second earlier. */
  noteBuffering(): void {
    this.controller.noteBuffering();
  }

  noteTrackChange(): void {
    this.controller.noteTrackChange();
    this.forgetPlayerBeliefs();
  }

  noteHostSeek(): void {
    this.controller.noteHostSeek();
  }

  /**
   * The user's own transport/seek on the driven player was forwarded to the
   * room. Until the room echoes it back — or refuses it by staying silent past
   * {@link INTENT_ECHO_WINDOW_MS} — the mismatch it causes is intent, not
   * drift, and the tick sends the player nothing at all. Only the latest
   * intent is held: a newer gesture supersedes the one before it.
   */
  noteLocalIntent(kind: UserIntentKind, positionMs: number, atMs: number): void {
    this.localIntent = { kind, positionMs, atMs };
  }

  /** Live voice in the room — see {@link voiceActiveFrom}. */
  setVoiceActive(active: boolean): void {
    this.voiceActive = active;
    this.controller.setVoiceActive(active);
  }

  state(): ElasticDriverState {
    const s = this.controller.state();
    return {
      profile: this.profileName,
      anchorOffsetMs: s.anchorOffsetMs,
      voiceTightening: this.controller.isVoiceTightening(),
      rateControlAvailable: s.rateControlAvailable,
      seekAvailable: this.caps.canSeek && this.seekMisses < MAX_SEEK_MISSES,
      stalled: this.stalled,
      driftMs: this.driftMs,
    };
  }

  /** Forget everything learned about this player (new tab, new element). */
  reset(): void {
    this.controller = this.buildController();
    this.lastTickMs = null;
    this.lastRoom = null;
    this.lastMediaKey = null;
    this.forgetPlayerBeliefs();
    this.stalled = false;
    this.driftMs = 0;
  }

  /* ── the tick ── */

  /**
   * Decide what to do with the player right now.
   *
   * @param room   the room's projected state (see {@link RoomFrame})
   * @param local  the player's latest telemetry, or null when none has arrived
   * @param nowMs  client clock for this tick
   */
  tick(room: RoomFrame, local: DriverTelemetry | null, nowMs: number): DriveCommand {
    const gapMs = this.lastTickMs === null ? 0 : nowMs - this.lastTickMs;
    const continuous = this.lastTickMs !== null && gapMs >= 0 && gapMs <= WAKE_GAP_MS;
    this.lastTickMs = nowMs;

    // The worker slept, or the tab was frozen and woke. Wherever the player is
    // now is a fresh start, not accumulated drift.
    if (this.lastRoom !== null && !continuous) {
      this.controller.noteBuffering();
      this.lastLocal = null;
    }

    if (room.mediaKey !== this.lastMediaKey) {
      // The very first media of a session is not a *change*; a fresh controller
      // is already armed to learn its anchor.
      if (this.lastMediaKey !== null) this.noteTrackChange();
      this.lastMediaKey = room.mediaKey;
    } else if (continuous && this.lastRoom !== null) {
      // A host seek shows up as a discontinuity in the ROOM's timeline. A
      // correction WE prescribed moves the player, never the room, so the two
      // can never be confused.
      const prev = this.lastRoom;
      const projected = prev.expectedMs + (prev.playing ? gapMs * prev.rate : 0);
      if (Math.abs(room.expectedMs - projected) > HOST_SEEK_EPSILON_MS) this.noteHostSeek();
    }
    this.lastRoom = room;

    const anchor = this.controller.anchorOffsetMs();
    const target = room.expectedMs - anchor;

    if (local === null || nowMs - local.atMs > TELEMETRY_STALE_MS) {
      // Nothing observed: fall back to plain follow-the-room and let the
      // player's own driver do the correcting. The anchor is still applied —
      // yanking a viewer who deliberately runs 8s back would be worse than
      // keeping them there while we are blind.
      this.lastLocal = null;
      this.stalled = false;
      return this.finish({
        transport: 'none',
        seekToMs: null,
        setRate: null,
        wirePositionMs: target,
        driftMs: 0,
        anchorOffsetMs: anchor,
        reason: 'no-telemetry',
      });
    }

    this.checkRateReadback(local);
    this.stalled = this.observePlayer(room, local);
    this.lastLocal = local;

    this.driftMs = target - local.positionMs;

    // Never correct into a stall: the player is already fighting the network.
    if (this.stalled) {
      return this.finish({
        transport: 'none',
        seekToMs: null,
        setRate: null,
        wirePositionMs: projectedPositionMs(local, nowMs),
        driftMs: this.driftMs,
        anchorOffsetMs: anchor,
        reason: 'stalled',
      });
    }

    // The user's own gesture was forwarded to the room and is on its way back
    // as room state. Correcting against it in that window is the feedback loop
    // this driver must never close — the user pauses, we un-pause, the room
    // pauses, we… — so the player is left alone until the room echoes the
    // intent, or the window closes because the room did not take it (then
    // correction resumes: the room decided).
    const pending = this.localIntent;
    if (pending !== null) {
      if (nowMs - pending.atMs > INTENT_ECHO_WINDOW_MS || this.intentEchoed(pending, room, nowMs)) {
        this.localIntent = null;
      } else {
        return this.finish({
          transport: 'none',
          seekToMs: null,
          setRate: null,
          wirePositionMs: projectedPositionMs(local, nowMs),
          driftMs: this.driftMs,
          anchorOffsetMs: anchor,
          reason: 'user-intent',
        });
      }
    }

    // Host intent (play/pause) is never subject to the comfort band.
    if (room.playing !== local.playing) {
      // Whatever lag accumulated across a transport gap is not drift.
      this.controller.noteBuffering();
      const gap = target - local.positionMs;
      const realign =
        room.playing && Math.abs(gap) > this.deadbandMs() && this.canSeekNow(nowMs)
          ? target
          : null;
      if (realign !== null) this.armSeek(realign, nowMs);
      return this.finish({
        transport: room.playing ? 'play' : 'pause',
        seekToMs: realign,
        setRate: this.rateDiffers(local.rate, room.rate) ? room.rate : null,
        wirePositionMs: realign ?? projectedPositionMs(local, nowMs),
        driftMs: gap,
        anchorOffsetMs: anchor,
        reason: 'transport',
      });
    }

    // The item's own length is the controller's terminal state: without it the
    // room's projection keeps climbing after the source runs out, reads as an
    // ever-growing lag, and prescribes a seek past the end once per tick — and
    // seeking a finished player is what starts it again. 0 is every player's
    // "not known yet" (pre-metadata, or a live stream) and must not be passed
    // as a length, or a real lag would stop being corrected. Infinity is a live
    // stream's honest answer and clamps nothing, here or in the controller.
    //
    // The sample is measured AT THIS INSTANT, never as it was captured. It
    // crossed a process boundary to get here and the player kept playing while
    // it travelled, so a raw reading overstates the lag by the sample's own
    // age — and always in the one direction that says this viewer is behind,
    // which is the direction that prescribes a speed-up or a seek. A tab
    // reporting at 1 Hz would therefore be permanently ~1 s "late" and be
    // corrected for it forever.
    const observedMs = this.observedPositionMs(local, nowMs);
    const action = this.controller.decide(room.expectedMs, observedMs, {
      nowMs,
      ...(local.durationMs > 0 ? { durationMs: local.durationMs } : {}),
    });
    const anchorNow = this.controller.anchorOffsetMs();
    // The SAME clamped expectation the controller just decided against. Read
    // raw, this reports a lag the driver has deliberately chosen not to
    // correct — so a finished item would sit at "30s behind the room" forever
    // in the status chip while the player is simply over.
    const expectedMs =
      local.durationMs > 0 ? Math.min(room.expectedMs, local.durationMs) : room.expectedMs;
    this.driftMs = expectedMs - anchorNow - observedMs;

    if (action.action === 'seek') {
      // Only the player's own refusals. The controller has already ruled on
      // voice — see {@link canSeekNow}.
      if (!this.seekIsAffordable(nowMs)) {
        // Honest stop. If the player structurally cannot seek there is nothing
        // left to fight with, so adopt the lag and play smoothly at it rather
        // than prescribing a correction that will never land.
        if (!this.seekAvailable()) this.controller.noteSettledLag(this.driftMs);
        return this.finish({
          transport: 'none',
          seekToMs: null,
          setRate: null,
          wirePositionMs: projectedPositionMs(local, nowMs),
          driftMs: this.driftMs,
          anchorOffsetMs: this.controller.anchorOffsetMs(),
          reason: 'seek-suppressed',
        });
      }
      this.armSeek(action.toMs, nowMs);
      return this.finish({
        transport: 'none',
        seekToMs: action.toMs,
        // A seek lands us where we belong; any nudge in flight is over.
        setRate: this.rateDiffers(local.rate, room.rate) ? room.rate : null,
        wirePositionMs: action.toMs,
        driftMs: this.driftMs,
        anchorOffsetMs: anchorNow,
        reason: 'seek',
      });
    }

    if (action.action === 'nudge') {
      const rate = room.rate * action.rate;
      this.prescribeRate(rate, local, nowMs);
      return this.finish({
        transport: 'none',
        seekToMs: null,
        setRate: rate,
        wirePositionMs: projectedPositionMs(local, nowMs),
        driftMs: this.driftMs,
        anchorOffsetMs: anchorNow,
        reason: 'nudge',
      });
    }

    // action === 'none': inside the band, or holding still because the player
    // refuses rate control and the anchor is absorbing the offset.
    const restore = this.rateDiffers(local.rate, room.rate) ? room.rate : null;
    if (restore !== null) this.prescribeRate(restore, local, nowMs);
    const rateLocked = !this.rateAvailable() && Math.abs(this.driftMs) > this.deadbandMs();
    return this.finish({
      transport: 'none',
      seekToMs: null,
      setRate: restore,
      wirePositionMs: projectedPositionMs(local, nowMs),
      driftMs: this.driftMs,
      anchorOffsetMs: anchorNow,
      reason: restore !== null ? 'restore-rate' : rateLocked ? 'rate-locked' : 'idle',
    });
  }

  /* ── internals ── */

  private buildController(): DriftController {
    const controller = new DriftController({
      ...SYNC_PRESETS[this.profileName],
      ...(this.tuning ?? {}),
    });
    controller.setVoiceActive(this.voiceActive);
    if (!this.caps.canSetRate) controller.noteRateRejected();
    return controller;
  }

  /** Beliefs about the PLAYER (not the room) that a new element invalidates. */
  private forgetPlayerBeliefs(): void {
    this.lastLocal = null;
    this.prescribedRate = null;
    this.prescribedRateAtMs = 0;
    this.rateBeforePrescription = 1;
    this.pendingSeek = null;
    this.seekMisses = 0;
    this.lastSeekAtMs = null;
    // An intent names a position on media that is gone; it cannot echo now.
    this.localIntent = null;
  }

  /** Has the room state come to say what the forwarded intent asked? */
  private intentEchoed(
    pending: { kind: UserIntentKind; positionMs: number; atMs: number },
    room: RoomFrame,
    nowMs: number,
  ): boolean {
    switch (pending.kind) {
      case 'play':
        return room.playing;
      case 'pause':
        return !room.playing;
      case 'seek': {
        // Where the intent's position would be by now, had the room taken it.
        const projected =
          pending.positionMs + (room.playing ? (nowMs - pending.atMs) * room.rate : 0);
        return Math.abs(room.expectedMs - projected) <= HOST_SEEK_EPSILON_MS;
      }
    }
  }

  private deadbandMs(): number {
    const preset = SYNC_PRESETS[this.profileName];
    return this.tuning?.deadbandMs ?? preset.deadbandMs ?? 60;
  }

  private rateAvailable(): boolean {
    return this.controller.state().rateControlAvailable;
  }

  private seekAvailable(): boolean {
    return this.caps.canSeek && this.seekMisses < MAX_SEEK_MISSES;
  }

  /**
   * The refusals that are this driver's own knowledge of the PLAYER, and
   * therefore outrank anybody's decision to seek: it cannot seek at all, it
   * has ignored the last {@link MAX_SEEK_MISSES} we sent, or one went out too
   * recently (a DRM licence renegotiation is expensive — hence the DRM floor).
   * The controller knows none of this, so it is asked here and nowhere else.
   */
  private seekIsAffordable(nowMs: number): boolean {
    if (!this.seekAvailable()) return false;
    if (this.lastSeekAtMs === null) return true;
    const floor = this.caps.isDrmProtected ? MIN_SEEK_INTERVAL_DRM_MS : MIN_SEEK_INTERVAL_MS;
    return nowMs - this.lastSeekAtMs >= floor;
  }

  /**
   * …plus the voice question, for a seek THIS driver prescribes itself. While
   * people are actually talking, converge with rate only: a seek is the one
   * correction guaranteed to wreck a live reaction (Consequence B).
   *
   * A seek the CONTROLLER decided does not come through here, and must not:
   * sync-core weighed voice against the drift already and let that one past
   * `voiceSeekCeilingMs` deliberately — the magnitude at which the two are no
   * longer watching the same moment, so there is no live reaction left to
   * spoil, and past which rate alone can never rescue the viewer anyway (over
   * two hours of playback to close five minutes at the watch band's ±3%; see
   * packages/sync-core/src/drift.ts). Re-asking it there refused every one of
   * those rescues and stranded a badly-lagged viewer for as long as anybody in
   * the room held a mic open.
   */
  private canSeekNow(nowMs: number): boolean {
    if (this.controller.isVoiceTightening()) return false;
    return this.seekIsAffordable(nowMs);
  }

  /**
   * Where the player IS now, not where it was when it last reported.
   *
   * Clamped to the item's own length for the same reason the room's
   * expectation is clamped (see the `durationMs` note in {@link tick}): the
   * source runs out, so a projection that runs past it is arithmetic, not a
   * position — and it would read as this viewer racing ahead of a room that is
   * simply over. 0 is "not known yet" and clamps nothing.
   */
  private observedPositionMs(local: DriverTelemetry, nowMs: number): number {
    const projected = projectedPositionMs(local, nowMs);
    return local.durationMs > 0 ? Math.min(projected, local.durationMs) : projected;
  }

  private armSeek(toMs: number, nowMs: number): void {
    this.lastSeekAtMs = nowMs;
    this.pendingSeek = { toMs, atMs: nowMs };
  }

  private rateDiffers(a: number, b: number): boolean {
    return Math.abs(a - b) > RATE_EPSILON;
  }

  private prescribeRate(rate: number, local: DriverTelemetry, nowMs: number): void {
    this.prescribedRate = rate;
    this.prescribedRateAtMs = nowMs;
    this.rateBeforePrescription = local.rate;
  }

  /**
   * The read-back that matters: a DRM player accepts `playbackRate = 1.03`
   * without error and keeps playing at 1.0. Assign it, read it back on a later
   * sample, and conclude "ignored" ONLY when the value did not move at all —
   * a value that moved somewhere else is the *user* changing speed, not a
   * refusal.
   */
  private checkRateReadback(local: DriverTelemetry): void {
    const want = this.prescribedRate;
    if (want === null) return;
    if (local.atMs < this.prescribedRateAtMs + RATE_READBACK_GRACE_MS) return;
    this.prescribedRate = null;
    if (!this.rateDiffers(local.rate, want)) return;
    if (this.rateDiffers(local.rate, this.rateBeforePrescription)) return;
    this.controller.noteRateRejected();
  }

  /**
   * Compare consecutive samples: did the player advance the way a healthy
   * player would? Returns true while it is stalled.
   */
  private observePlayer(room: RoomFrame, local: DriverTelemetry): boolean {
    const prev = this.lastLocal;
    if (prev === null || local.atMs <= prev.atMs) return false;

    const elapsed = local.atMs - prev.atMs;
    const advanced = local.positionMs - prev.positionMs;
    const expectedAdvance = prev.playing && local.playing ? elapsed * prev.rate : 0;

    const seek = this.pendingSeek;
    if (seek !== null && local.atMs >= seek.atMs) {
      // Our own correction explains this jump — and tells us whether the
      // player honoured it at all.
      this.pendingSeek = null;
      const want = seek.toMs + (local.playing ? (local.atMs - seek.atMs) * local.rate : 0);
      if (Math.abs(local.positionMs - want) > SEEK_MISS_MS) {
        this.seekMisses += 1;
        if (this.seekMisses >= MAX_SEEK_MISSES) this.controller.noteBuffering();
      } else {
        this.seekMisses = 0;
      }
      return false;
    }

    if (
      room.playing &&
      local.playing &&
      elapsed >= STALL_MIN_ELAPSED_MS &&
      expectedAdvance > 0 &&
      advanced < expectedAdvance * STALL_ADVANCE_FRACTION
    ) {
      this.controller.noteBuffering();
      return true;
    }

    if (Math.abs(advanced - expectedAdvance) > LOCAL_JUMP_MS) {
      // The site's own player moved: the user scrubbed, or an ad break ended.
      // Whatever lag we had learned describes a position that no longer exists.
      this.controller.noteBuffering();
    }
    return false;
  }

  private finish(cmd: Omit<DriveCommand, 'idle'>): DriveCommand {
    return {
      ...cmd,
      idle: cmd.transport === 'none' && cmd.seekToMs === null && cmd.setRate === null,
    };
  }
}

/* ═══════════ 4. user intent on the driven element (content side) ═════════ */

/** A transport act a person can mean: their hand on the site's own player. */
export type UserIntentKind = 'play' | 'pause' | 'seek';

/** One transport event, as the content script saw it on the driven element. */
export interface ObservedTransportEvent {
  type: 'play' | 'pause' | 'seeked';
  /** The element's position when the event was handled. */
  positionMs: number;
  /** HTMLMediaElement.ended — reaching the end fires a pause nobody meant. */
  ended: boolean;
  atMs: number;
}

/** The verdict: what the user meant, at the position their player is at. */
export interface DetectedUserIntent {
  intent: UserIntentKind;
  positionMs: number;
}

/**
 * A commanded play/pause fires its event within the tick that applied it on a
 * healthy player; two ticks is the ceiling. Inside the window a genuine user
 * gesture in the SAME direction is indistinguishable — and moot, because the
 * element is already in that state, so its control fires no event — while the
 * opposite direction uses the other expectation slot and passes through.
 */
export const SELF_TRANSPORT_WINDOW_MS = 2000;
/**
 * The mirror of {@link HOST_SEEK_EPSILON_MS}, and deliberately the same
 * number: "is this jump the one that was commanded, or a new fact?" is the
 * same question asked in the other direction. Under it, keyframe snapping and
 * event timing dominate — a commanded seek lands on the nearest keyframe and
 * plays on until 'seeked' fires. Over it, with an expectation armed by our
 * own seekToMs, a human scrub is the only remaining explanation.
 */
export const SELF_SEEK_EPSILON_MS = HOST_SEEK_EPSILON_MS;
/**
 * How long a commanded seek may take to land — a DRM player renegotiates its
 * licence and stalls for seconds. {@link MIN_SEEK_INTERVAL_MS} guarantees no
 * second seek is prescribed inside this window, so an armed expectation can
 * never be overwritten before the event it explains arrives.
 */
export const SELF_SEEK_WINDOW_MS = MIN_SEEK_INTERVAL_MS;
/**
 * A position change below this is not something a person meant: it is the
 * size of jump the corrector itself files under housekeeping (LOCAL_JUMP_MS —
 * kept equal on purpose), where keyframe snaps and the player's own
 * adjustments live.
 */
export const USER_SEEK_MATERIAL_MS = LOCAL_JUMP_MS;

/**
 * Tells a user's hand on the site's own player apart from everything else
 * that fires the same events: commands WE applied (the feedback loop —
 * correction → "intent" → broadcast → correction), a commanded seek landing
 * late or slightly off, and plain arrival at the end of the media. Pure: the
 * content script feeds it events and applied decisions; it never touches the
 * DOM or a clock.
 *
 * What it deliberately does NOT judge: buffering. The background's driver
 * already judges stall from telemetry (see {@link ElasticDriver}), and a
 * second, disagreeing judgement here would give one pause two answers — so a
 * pause that may be buffering is reported, and dropped THERE.
 */
export class UserIntentDetector {
  private expectPlayUntilMs = 0;
  private expectPauseUntilMs = 0;
  private expectedSeek: { toMs: number; untilMs: number } | null = null;
  /** Baseline for the material-delta test. null = no baseline yet, and a seek
   *  with no baseline is unattributable — never intent. */
  private lastPositionMs: number | null = null;

  /** Every command is marked BEFORE it is applied: the events it causes fire
   *  after applyDecision returns, and must read as ours whenever they land. */
  noteApplied(decision: DriveDecision, atMs: number): void {
    if (decision.action === 'play') this.expectPlayUntilMs = atMs + SELF_TRANSPORT_WINDOW_MS;
    else if (decision.action === 'pause') this.expectPauseUntilMs = atMs + SELF_TRANSPORT_WINDOW_MS;
    if (decision.seekToMs !== null) {
      this.expectedSeek = { toMs: decision.seekToMs, untilMs: atMs + SELF_SEEK_WINDOW_MS };
    }
  }

  /** Telemetry heartbeat: the baseline a user seek is measured against. */
  notePosition(positionMs: number): void {
    this.lastPositionMs = positionMs;
  }

  /** A different element (ad roll, SPA swap): nothing observed still applies. */
  reset(): void {
    this.expectPlayUntilMs = 0;
    this.expectPauseUntilMs = 0;
    this.expectedSeek = null;
    this.lastPositionMs = null;
  }

  /** The verdict for one event: the user's intent, or null for noise. */
  observe(ev: ObservedTransportEvent): DetectedUserIntent | null {
    const prev = this.lastPositionMs;
    this.lastPositionMs = ev.positionMs;
    switch (ev.type) {
      case 'play':
        if (ev.atMs <= this.expectPlayUntilMs) {
          this.expectPlayUntilMs = 0; // one command explains one event
          return null;
        }
        return { intent: 'play', positionMs: ev.positionMs };
      case 'pause':
        if (ev.ended) return null; // arrival, not intent
        if (ev.atMs <= this.expectPauseUntilMs) {
          this.expectPauseUntilMs = 0;
          return null;
        }
        return { intent: 'pause', positionMs: ev.positionMs };
      case 'seeked': {
        // The armed expectation is kept when the event does NOT match it: the
        // user may scrub in the gap between our command and its landing, and
        // the position — not the order — is what attributes each event.
        const expected = this.expectedSeek;
        if (
          expected !== null &&
          ev.atMs <= expected.untilMs &&
          Math.abs(ev.positionMs - expected.toMs) <= SELF_SEEK_EPSILON_MS
        ) {
          this.expectedSeek = null;
          return null;
        }
        if (prev === null || Math.abs(ev.positionMs - prev) < USER_SEEK_MATERIAL_MS) return null;
        return { intent: 'seek', positionMs: ev.positionMs };
      }
    }
  }
}

/* ═════════════ 5. the end of the media (content side, and NOT intent) ════ */

/**
 * One 'ended' event, as the content script saw it on the driven element.
 *
 * `sourceKey` identifies the ELEMENT AND ITS SOURCE, not the event: it is what
 * makes "this end was already reported" answerable. The content script bumps
 * it when the element it drives is replaced, and it carries the element's own
 * `currentSrc`, so a site that swaps the next track into the same node gets a
 * new key and its genuine end is still reported.
 */
export interface ObservedEnd {
  sourceKey: string;
  /** The element's position when the event was handled. */
  positionMs: number;
  /** 0 when unknown (pre-metadata, or a live stream reporting Infinity). */
  durationMs: number;
  /** HTMLMediaElement.ended, re-read when the event was handled — the
   *  element's own word, not the event's, so a stale one can be caught. */
  ended: boolean;
}

/** The verdict: the media really ran out, and where. */
export interface DetectedEnd {
  positionMs: number;
  durationMs: number;
}

/**
 * How far back before the end a player must be for the end we already reported
 * to belong to a previous play-through. Comfortably past a final keyframe and
 * past the twitching a paused last frame does, and far short of anything a
 * person would call "watching it again".
 */
export const END_REARM_MS = 3000;

/**
 * Arrival at the end of the media, told apart from everything that merely
 * looks like it. This is the OTHER half of the rule
 * {@link UserIntentDetector} keeps: a pause caused by the end is not the user
 * pausing, so the intent path drops it — and it therefore has to be reported
 * here, on its own, or the end is never reported at all and a room driven by
 * this extension stalls forever on the last frame.
 *
 * The two paths never cross. Nothing in here can produce a `UserIntentKind`,
 * nothing in {@link UserIntentDetector} can produce a {@link DetectedEnd}, and
 * the content script routes the DOM's 'ended' event to this one alone.
 *
 * What it refuses, and why — sites fire 'ended' more than once and SPAs
 * manufacture ends that never happened:
 *   - an element that no longer says it ended. A stale event that lands after
 *     the site loaded the next item into the same node arrives at an element
 *     sitting at position 0 with `ended` false. That is not an end.
 *   - an end of nothing: no duration AND no position, which is what a
 *     freshly-emptied element looks like.
 *   - a source whose end was already reported. One item ends once, however
 *     many times its player says so — until the player is genuinely playing
 *     it again, which is what {@link MediaEndDetector.notePosition} watches
 *     for, so watching something twice ends it twice.
 */
export class MediaEndDetector {
  private reportedKey: string | null = null;

  /** A different element or a different item: the latch describes neither. */
  reset(): void {
    this.reportedKey = null;
  }

  /**
   * Telemetry heartbeat. A player back at a position well before the end is no
   * longer sitting on the end we reported — it is playing the item again — so
   * the latch is disarmed and the NEXT end is a real one. An unknown duration
   * (a live stream) cannot be judged this way and stays latched.
   */
  notePosition(positionMs: number, durationMs: number): void {
    if (this.reportedKey === null || durationMs <= 0) return;
    if (positionMs <= durationMs - END_REARM_MS) this.reportedKey = null;
  }

  /** The verdict for one 'ended' event: the end, or null for noise. */
  observe(ev: ObservedEnd): DetectedEnd | null {
    if (!ev.ended) return null;
    if (ev.durationMs <= 0 && ev.positionMs <= 0) return null;
    if (ev.sourceKey === this.reportedKey) return null;
    this.reportedKey = ev.sourceKey;
    return { positionMs: ev.positionMs, durationMs: ev.durationMs };
  }
}

/**
 * The room state as a person would say it — docs/EXTENSION_FIRST.md asks for
 * this to be shown honestly as a room state, never as a technical readout.
 */
export function syncStatusLabel(state: ElasticDriverState): string {
  if (state.stalled) return 'Buffering — holding your place';
  if (state.voiceTightening) return 'Talking — staying in step';
  if (Math.abs(state.anchorOffsetMs) >= 1000) {
    return `Playing smoothly, ${Math.round(Math.abs(state.anchorOffsetMs) / 1000)}s behind the room`;
  }
  return 'In sync';
}
