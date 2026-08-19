/**
 * useSyncEngine — wires @gather/sync-core's drift-corrected playback to a
 * Mode A PlayerAdapter. The math (ClockEstimator offset, expectedPositionMs,
 * DriftController nudge/seek hysteresis) is NOT reimplemented here; this hook
 * only bridges it to the adapter's imperative API. Web port of
 * apps/mobile/src/sync/useSyncEngine.ts.
 *
 * ── The one rule this file exists to keep ─────────────────────────────────
 *
 * THE CONTROLLER SURVIVES EVERYTHING EXCEPT A TRACK CHANGE. Its anchor is
 * LEARNED — it takes `anchorAdoptAfterMs` (3 s) of steady lag to adopt one —
 * and a viewer who is deliberately 6 s back is the elastic design working, not
 * a viewer to rescue. So the room's every play, pause, seek and rate change is
 * reported to the controller through its own observation methods
 * (`noteTrackChange`, `noteHostSeek`, `noteBuffering`, `noteRateRejected`,
 * `setVoiceActive`) and NOT by rebuilding or resetting it.
 *
 * This is what the file used to do instead: the resync effect was keyed on
 * `mediaKey(mediaRef, playback.seq)` — a media+EPOCH key — and every one of
 * those four mutations mints a fresh `seq` (services/api sync/service.ts
 * `mutate()`). So each of them ran `controller.reset()` and then snapped the
 * player to within 250 ms of the room's projection. Twice per pause, every
 * viewer in the room was yanked back to frame-lock and made to re-learn its
 * offset from zero — which is precisely the behaviour docs/EXTENSION_FIRST.md
 * Part 1 describes the elastic band as existing to prevent.
 *
 * ── What this hook reports back to the room ───────────────────────────────
 *
 * It needs the room CONNECTION, not just the room's state, for one reason:
 * `sync.duration`. `QueueItem.durationMs` is null for nearly every row (see
 * packages/contracts ws.ts — of the six keyless oEmbed endpoints only Vimeo's
 * carries a length), and the number is sitting in this player. The one place
 * that already owns "apply the room to the mounted player" is also the only
 * place that can see what the player learned, so the report is produced here
 * rather than plumbed through a component that would have to be told about it.
 */
import { useEffect, useRef } from 'react';
import {
  DriftController,
  LISTEN_ELASTIC,
  WATCH_ELASTIC,
  expectedPositionMs,
} from '@gather/sync-core';
import type { PlaybackState } from '@gather/contracts';
import type { ClockEstimator } from '@gather/api-client';
import { mediaKindFor } from '@/lib/media-kind';
import { useRoomConnection } from '@/lib/room-context';
import type { PlayerAdapter } from './adapter';
import { adapterIsLive, mediaKey } from './adapter';
import { durationReportFor } from './advance';
import { attachContentDucking } from './ducking';
import { extensionPlaybackStore } from './extension-driver';
import { publishStageLive } from './live';
import { getVoiceActive, subscribeVoiceActive } from './room-audio';

export interface SyncEngineInput {
  adapter: PlayerAdapter | null;
  playback: PlaybackState | null;
  clock: ClockEstimator;
  /** Called with each drift sample (debug HUD). */
  onDriftSample?: ((driftMs: number) => void) | undefined;
  /** Interval between correction passes. Default 500 ms. */
  tickMs?: number;
}

/**
 * A jump in the ROOM's timeline larger than this is a host seek, not drift.
 * Same constant, same reasoning as the extension's driver — and it has to be
 * this generous: whoever presses pause writes THEIR position into the room, and
 * in an elastic room that is seconds away from everyone else's.
 */
export const HOST_SEEK_EPSILON_MS = 750;

/** A track change lands the player unbanded; this is only the "already there"
 *  tolerance, so a fresh player at 0 is not seeked to 0. */
const LANDING_TOLERANCE_MS = 250;

/** A gap between ticks this large means the tab slept, not that the viewer
 *  drifted. Mirrors the extension's `WAKE_GAP_MS`. */
const WAKE_GAP_MS = 4000;

/** playbackRate comparison tolerance (the extension's `RATE_EPSILON`). */
const RATE_EPSILON = 0.005;

/** A rate assignment read back sooner than this proves nothing — the player
 *  has not had a frame to apply it. */
const RATE_READBACK_GRACE_MS = 250;

/**
 * NEVER SEEK MORE OFTEN THAN THIS. The extension's driver has had the floor
 * since it shipped (apps/extension/src/driver.ts, `MIN_SEEK_INTERVAL_MS` — the
 * same number for the same reason) and this engine had none at all: a
 * correction was prescribed, and if the player had not moved by the next pass
 * it was prescribed again, twice a second.
 *
 * A seek is the most expensive thing a player can be asked for — it re-buffers,
 * and a protected one renegotiates a licence — so a player asked at 2 Hz never
 * finishes answering the first question. The elastic band is what covers the
 * wait: a viewer who is far enough out to need a seek is far enough out that
 * five more seconds change nothing.
 */
export const MIN_SEEK_INTERVAL_MS = 5000;

/** A prescribed seek that lands further than this from where it asked for was
 *  IGNORED, not merely snapped to a keyframe. */
const SEEK_MISS_MS = 2000;

/** Two ignored seeks in a row and this engine stops asking that player. The
 *  anchor is what absorbs a difference nothing can close. */
const MAX_SEEK_MISSES = 2;

/** What changed when the server sent a new PlaybackState. */
export type PlaybackTransition = 'none' | 'track' | 'seek' | 'transport';

/**
 * Classify one server state against the one before it.
 *
 * The whole point is to stop treating `seq` as the question. Every playback
 * mutation bumps it, so "seq changed" answers only "something happened"; what
 * the controller needs to know is WHICH thing, because the three answers are
 * three different instructions:
 *
 *   'track'     — different content. Forget the anchor and land hard: a track
 *                 change is host intent and applies unbanded on every viewer.
 *   'seek'      — the room's own timeline jumped. The learned offset described
 *                 the old position and says nothing about this one, so it goes;
 *                 the correction itself is left to the controller's escape,
 *                 exactly as the extension leaves it (apps/extension/src/
 *                 driver.ts, `noteHostSeek`).
 *   'transport' — play/pause/rate at the same position. The anchor is still
 *                 true. Apply the command; correct nothing.
 *
 * COMPARED AT `next.serverTs`, NOT AT `now`. Projecting both states to the
 * current instant would make the answer depend on how long the state took to
 * reach this effect: a resume that arrived 2 s late would show a 2 s "jump"
 * and be called a seek. At the moment the new state describes, a state that
 * only started or stopped the clock names the same position it already had.
 */
export function playbackTransition(
  prev: PlaybackState | null,
  next: PlaybackState,
): PlaybackTransition {
  // Nothing to compare against: a first state, or the first after this device
  // built a player. Land on it.
  if (prev === null) return 'track';
  if (mediaKey(prev.mediaRef, undefined) !== mediaKey(next.mediaRef, undefined)) return 'track';
  if (next.seq === prev.seq) return 'none';
  const moved = Math.abs(next.positionMs - expectedPositionMs(prev, next.serverTs));
  if (moved > HOST_SEEK_EPSILON_MS) return 'seek';
  if (prev.playing !== next.playing || prev.rate !== next.rate) return 'transport';
  return 'none';
}

/**
 * The rate the player is ACTUALLY running at, or null when this adapter cannot
 * be asked.
 *
 * `PlayerAdapter` has `setRate` and no getter, so the only read-back available
 * without changing the interface (and every implementation of it) is the real
 * player object an adapter chooses to expose — today that is `NativeAdapter`'s
 * `mediaElement`, which is also where the web's rate refusals actually live:
 * an EME/protected `<video>` accepts `playbackRate = 1.03` without error and
 * goes on playing at 1.0.
 *
 * NULL IS "NO EVIDENCE", NEVER "REFUSED". `noteRateRejected` is one-way — it
 * gives up rate correction for the rest of the item — so an adapter that cannot
 * answer must never be concluded about. The iframe adapters (YouTube,
 * SoundCloud, Vimeo) land here: SoundCloud's widget silently drops
 * `setPlaybackRate` on most tracks and this cannot yet see it. Giving
 * `PlayerAdapter` an honest `rate()` is the fix, and it is a change to files
 * this module does not own.
 */
export function observedRate(adapter: PlayerAdapter): number | null {
  const player = (adapter as { mediaElement?: unknown }).mediaElement;
  if (typeof player !== 'object' || player === null) return null;
  const rate = (player as { playbackRate?: unknown }).playbackRate;
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
}

function rateDiffers(a: number, b: number): boolean {
  return Math.abs(a - b) > RATE_EPSILON;
}

/**
 * Applies server-authoritative playback to the adapter:
 *  - on a TRACK change: land the position, rate and play/pause unbanded;
 *  - on a host SEEK: drop the learned anchor and let the controller converge;
 *  - on transport: play/pause/rate only, inside the band;
 *  - every tick: DriftController decides none/nudge/seek inside the elastic
 *    band for the playing item's media kind.
 *
 * Must be called inside `<RoomProvider>` — it reports the item's length back
 * to the room (see the header).
 */
export function useSyncEngine(input: SyncEngineInput): void {
  const { adapter, playback, clock, tickMs } = input;
  const onDriftSample = input.onDriftSample;
  const connection = useRoomConnection();

  /**
   * Elastic bands, chosen by what is PLAYING — the same rule the extension's
   * driver applies (apps/extension/src/driver.ts). The web sat on the
   * frame-lock defaults (60 ms deadband, 2 s hard seek) long after
   * docs/EXTENSION_FIRST.md described elastic sync as shipped, which is why a
   * correction loop here ran at 2 Hz instead of once every twelve seconds.
   * Rate authority is the axis that differs: ±3% is invisible on dialogue and
   * nearly a semitone of pitch on music.
   */
  const profile = mediaKindFor(playback?.mediaRef ?? null) === 'music' ? 'listen' : 'watch';
  const preset = profile === 'listen' ? LISTEN_ELASTIC : WATCH_ELASTIC;
  const controllerRef = useRef<DriftController | null>(null);
  const profileRef = useRef<string | null>(null);
  /**
   * E17 — docs/EXTENSION_FIRST.md Part 1, "Consequence B". Voice is ~50–150 ms
   * peer-to-peer while an elastic room lets viewers sit seconds apart, so a
   * live mic is the one spoiler vector media-anchored chat cannot close: the
   * band has to tighten while people are talking. The extension has done this
   * since it shipped; the web, where most people watch, did not.
   *
   * THE SOURCE IS PRESENCE MIC STATE, NOT MEASURED SPEECH — see
   * lib/player/room-audio.ts. The controller's ramps are 2 s in and 8 s out;
   * feeding it the 150 ms speech detector would leave it permanently mid-ramp,
   * converging on neither band. Measured speech drives ducking instead, one
   * effect below, and the two must not be crossed.
   *
   * Held in a ref as well as pushed, because a profile flip (video → music)
   * builds a FRESH controller mid-session, and a new controller that has never
   * been told about the open mics in the room starts out loose.
   */
  const voiceActiveRef = useRef<boolean>(getVoiceActive());
  /** False once this player has proved it ignores playbackRate. One-way per
   *  player, like the controller's own flag: the fact is about the player. */
  const rateRejectedRef = useRef(false);
  if (controllerRef.current === null || profileRef.current !== profile) {
    controllerRef.current = new DriftController(preset);
    controllerRef.current.setVoiceActive(voiceActiveRef.current);
    // A band change is not evidence about the player: one that ignores
    // playbackRate goes on ignoring it in any band (the extension's
    // `setProfile` carries the same fact across for the same reason).
    if (rateRejectedRef.current) controllerRef.current.noteRateRejected();
    profileRef.current = profile;
  }

  // Subscribing calls back immediately with the current value, so a stage that
  // mounts into a room already mid-conversation is tightened at once.
  useEffect(
    () =>
      subscribeVoiceActive((active) => {
        voiceActiveRef.current = active;
        controllerRef.current?.setVoiceActive(active);
      }),
    [],
  );

  /**
   * E18 — ducking. The other half of "someone is talking while the content
   * plays", on the other signal and the other timescale: the content steps
   * back for MEASURED SPEECH and comes back when it stops. Attached here
   * because this hook is already the one place that owns applying the room to
   * the mounted adapter, and it receives exactly the adapters that have a
   * volume to duck (isFullSyncKind). See lib/player/ducking.ts for the target,
   * the envelope, and why a duck can never move the user's own volume.
   */
  useEffect(() => {
    if (adapter === null) return undefined;
    return attachContentDucking(adapter);
  }, [adapter]);

  /**
   * Identity of the ITEM on the stage. NOT `mediaKey(ref, seq)`: `seq` is
   * minted by every playback mutation, so an epoch key makes a pause during
   * the credits look like a new item — which is how the end latch below used
   * to be cleared while the player was still finished. `queueIndex` earns its
   * place because the same media queued twice is two items. Same key, same
   * reasoning as StagePane's `trackKey`.
   */
  const trackIdentity = `${mediaKey(playback?.mediaRef, undefined)}#${String(
    playback?.queueIndex ?? -1,
  )}`;

  /**
   * Whether the room's projection can be believed at all.
   *
   * `ClockEstimator.offsetMs()` answers 0 before its first accepted sample, and
   * a real zero offset is indistinguishable from that — so for the first
   * seconds of every join and every reconnect, `serverNow()` is the LOCAL
   * clock wearing the server's name and every correction is measured against a
   * fiction. A machine a few seconds off (or an hour, mid-DST) would be
   * dragged there and back.
   *
   * A PAUSED room needs no clock: its expected position is `positionMs`, a
   * constant, so it is honest before the first pong and stays gated only while
   * the room is actually running.
   */
  const projectionIsTrustworthy = (state: PlaybackState): boolean =>
    !state.playing || clock.hasEstimate();

  /** This device's source has run out (set by the END GUARD subscription
   *  below, read by the transition effect above it — a finished player must
   *  never be told to play again). */
  const endedRef = useRef(false);
  /** This device's player has actually started THIS item — the duration report
   *  waits for it. */
  const startedHereRef = useRef(false);
  /** A track landing this device still owes — see the effect below. */
  const landingRef = useRef(false);
  const lastStateRef = useRef<PlaybackState | null>(null);
  const lastAdapterRef = useRef<PlayerAdapter | null>(null);

  /**
   * SEEK DISCIPLINE — the refusals that belong to the PLAYER, which the
   * controller knows nothing about and must not be asked to weigh (the same
   * split the extension's driver makes in `seekIsAffordable`). sync-core decides
   * whether a correction is warranted; these decide whether this player is
   * still worth asking.
   *
   * Beliefs about a player, so they die with the player and with the item — the
   * END GUARD effect below owns that lifetime — and never with a playback
   * epoch, which is minted by every pause anybody presses.
   */
  const lastSeekAtRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<{ toMs: number; atMs: number } | null>(null);
  const seekMissesRef = useRef(0);
  const seekAvailable = (): boolean => seekMissesRef.current < MAX_SEEK_MISSES;
  const seekIsAffordable = (nowMs: number): boolean => {
    if (!seekAvailable()) return false;
    const last = lastSeekAtRef.current;
    return last === null || nowMs - last >= MIN_SEEK_INTERVAL_MS;
  };
  /** Seek, and remember what was asked for so a later pass can see whether the
   *  player did it. */
  const prescribeSeek = (player: PlayerAdapter, toMs: number, nowMs: number): void => {
    lastSeekAtRef.current = nowMs;
    pendingSeekRef.current = { toMs, atMs: nowMs };
    player.seekTo(toMs);
  };
  const forgetSeekBeliefs = (): void => {
    lastSeekAtRef.current = null;
    pendingSeekRef.current = null;
    seekMissesRef.current = 0;
  };

  /** Put the player exactly where a track change says it belongs. */
  const land = (state: PlaybackState, player: PlayerAdapter): void => {
    // A live stream has no such place — see the live guard in the tick below.
    if (adapterIsLive(player)) return;
    const expected = expectedPositionMs(state, clock.serverNow(Date.now()));
    if (Math.abs(expected - player.positionMs()) > LANDING_TOLERANCE_MS) {
      // Host intent, so it is not subject to the floor and not evidence about
      // the player either: a landing goes to a player that may not have read
      // its metadata yet, and one that cannot honour it yet has not ignored it.
      // The floor STARTS here, so the first correction waits its turn.
      lastSeekAtRef.current = Date.now();
      player.seekTo(expected);
    }
  };

  // Apply what the room just did — see `playbackTransition` for why the
  // answer is never "seq changed".
  useEffect(() => {
    if (adapter === null || playback === null) return;
    const controller = controllerRef.current;
    const prev = lastStateRef.current;
    // A rebuilt adapter (the music/video flip swaps the <video> element) is a
    // player that has been told nothing, whatever the room did.
    const rebuilt = lastAdapterRef.current !== adapter;
    lastAdapterRef.current = adapter;
    lastStateRef.current = playback;
    const transition = rebuilt ? 'track' : playbackTransition(prev, playback);
    if (transition === 'none') return;

    if (rebuilt) {
      // A different player object is a different player, and what we learned
      // about the last one — that it drops playbackRate, that it ignored the
      // last two seeks — was about IT.  The controller has to be told too:
      // `noteTrackChange` does not restore rate control, deliberately, because
      // a track change alone is not evidence.
      rateRejectedRef.current = false;
      controller?.setRateControlAvailable(true);
      forgetSeekBeliefs();
    }

    if (transition === 'track') {
      controller?.noteTrackChange();
      // A miss counted against the last item says nothing about this one, and a
      // floor left running from it would delay the first correction of the new
      // one. Same clearing the extension does on a track change
      // (`forgetPlayerBeliefs`), and it is what keeps the landing below free.
      forgetSeekBeliefs();
      // The latch belongs to the item that ended, and this is a different one.
      // Cleared HERE as well as in the subscription below, because effects run
      // in declaration order: on the commit that carries a new item this one
      // runs first, and it must not read the old item's ending as a reason to
      // leave the new one stopped.
      endedRef.current = false;
      // The landing needs the room's projection. When the clock cannot yet be
      // believed, owe it instead of guessing — the first trustworthy tick pays
      // it. Play/pause and rate are facts, not projections, and go now.
      if (projectionIsTrustworthy(playback)) land(playback, adapter);
      else landingRef.current = true;
    } else if (transition === 'seek') {
      // The old offset described the old position. Dropping it is the whole
      // correction: the controller's own seek escape rescues a viewer who is
      // genuinely lost, and a seek inside the band is one the room can absorb.
      controller?.noteHostSeek();
    } else {
      // Whatever lag opened up across a transport gap is not drift.
      controller?.noteBuffering();
      // Host intent is not subject to the comfort band — but the ANCHORED
      // target is still where this viewer belongs, and a difference inside the
      // band is left alone. (The extension realigns on transport the same way,
      // for the same reason: resuming from the pauser's position, seconds from
      // ours, is not something rate can close.)
      // …and never onto a player that is already over: seeking a finished
      // player is what starts it again, which is the whole reason the END
      // GUARD below exists. Nor onto a live one, which has no room position to
      // realign to at all.
      if (
        playback.playing &&
        !endedRef.current &&
        !adapterIsLive(adapter) &&
        projectionIsTrustworthy(playback)
      ) {
        const nowMs = Date.now();
        const target =
          expectedPositionMs(playback, clock.serverNow(nowMs)) -
          (controller?.anchorOffsetMs() ?? 0);
        // Subject to the floor: a resume is not a reason to ask a player that
        // is already busy with the last seek, and someone tapping play/pause
        // repeatedly must not become a seek per tap.
        if (
          Math.abs(target - adapter.positionMs()) > (preset.deadbandMs ?? 60) &&
          seekIsAffordable(nowMs)
        ) {
          prescribeSeek(adapter, target, nowMs);
        }
      }
    }

    adapter.setRate(playback.rate);
    // A player that has FINISHED is not paused and must not be started: play()
    // on an ended HTMLMediaElement restarts it from 0 (and YouTube's playVideo
    // does the same), which is the loop a follower sitting through the credits
    // used to fall into every time anybody touched the transport.
    if (playback.playing) {
      if (!endedRef.current) adapter.play();
    } else {
      adapter.pause();
    }
  }, [adapter, playback, clock, preset]);

  /**
   * END GUARD. The room's projected position keeps climbing after this
   * device's source runs out, so from that moment every correction is a seek
   * past the end — and seeking a finished player starts it again, which ends
   * it again, twice a second. Once the item has ended here, this engine stops
   * correcting and waits for the next track.
   *
   * This is also what a FOLLOWER needs: elastic sync leaves viewers seconds
   * apart, so a follower reaches the credits while the room is still on the
   * old item, and must simply sit still until the advance arrives.
   *
   * Keyed on the ITEM, and torn down with it — a latch that outlived its item
   * would silence the engine for the next one, and one keyed on the playback
   * EPOCH would be cleared by a pause during the credits.
   *
   * The other two subscriptions belong to the same lifetime. A stall is a
   * disturbance the controller wants to hear about (whatever lag the viewer
   * settles at afterwards may be adopted rather than fought), and 'playing' is
   * this device's own proof that the player really is on THIS item — which is
   * what the duration report below waits for.
   */
  useEffect(() => {
    endedRef.current = false;
    startedHereRef.current = false;
    // Liveness is discovered by the tick below, never assumed, so a badge can
    // never outlive the stream it described.
    //
    // The seek beliefs are NOT dropped here, though they have the same
    // lifetime: this body runs after the transition effect above, which has
    // already forgotten them for a new item and then landed the track — and a
    // landing starts the floor. Clearing them again here would let the first
    // correction of every item go out one tick behind the landing, which is
    // the loop this discipline exists to close. The teardown below is where
    // that lifetime actually ends.
    publishStageLive(false);
    if (adapter === null) return undefined;
    const controller = controllerRef.current;
    const offs = [
      adapter.on('ended', () => {
        endedRef.current = true;
      }),
      adapter.on('playing', () => {
        startedHereRef.current = true;
      }),
      adapter.on('buffering', () => controller?.noteBuffering()),
      adapter.on('buffered', () => controller?.noteBuffering()),
    ];
    return () => {
      for (const off of offs) off();
      endedRef.current = false;
      startedHereRef.current = false;
      forgetSeekBeliefs();
      publishStageLive(false);
    };
  }, [adapter, trackIdentity]);

  /**
   * "MY PLAYER SAYS THIS ITEM IS THIS LONG" — the client half of
   * `sync.duration` (packages/contracts ws.ts).
   *
   * Kept in a ref and refreshed every render so the two callers below stay
   * subscribed to their sources alone, instead of re-arming on every queue or
   * playback change.
   *
   * The latch is set only after the send SUCCEEDS: `RoomSocket.send` queues
   * while the socket is merely down but throws outright before the first
   * connect has resolved a token, and a report lost inside that window must
   * still be sendable when the player next reads its metadata.
   */
  const reportedForRef = useRef<string | null>(null);
  const reportRef = useRef<(durationMs: number) => void>(() => undefined);
  useEffect(() => {
    reportRef.current = (durationMs: number): void => {
      if (reportedForRef.current === trackIdentity) return;
      const report = durationReportFor({
        queueIndex: playback?.queueIndex ?? null,
        // Read, not subscribed: the queue changes for reasons that have nothing
        // to do with playback, and this hook must not re-render the stage.
        items: connection.useRoomState.getState().queue.items,
        mediaRef: playback?.mediaRef ?? null,
        durationMs,
      });
      if (report === null) return;
      try {
        connection.rawSocket.send('sync.duration', report);
        reportedForRef.current = trackIdentity;
      } catch {
        // Not connected yet. The next reading tries again; the room can learn
        // this a second later, and nothing on this stage depends on it.
      }
    };
  });
  useEffect(() => {
    reportedForRef.current = null;
  }, [trackIdentity]);

  /**
   * The same report, from the OTHER driver. When the extension plays, this page
   * builds no adapter at all, so the loop below never runs — and the extension
   * is the only surface that has the number for a DRM title or a `page` link,
   * which is exactly the row the resolver could never fill.
   *
   * Two guards, and both are the honest limit of what this stream can prove.
   * Telemetry carries no item identity (unlike `onEnded`, which carries a
   * mediaKey), so the length is attributed to the item the ROOM says is
   * playing; that is only safe while this page is deferring to the extension,
   * which is what `adapter === null` means here. And `playing` is required for
   * the same reason it is below: a player that has not started may still be
   * reporting the previous item's metadata.
   */
  useEffect(() => {
    if (adapter !== null) return undefined;
    return extensionPlaybackStore().observe((driven) => {
      if (!driven.playing) return;
      reportRef.current(driven.durationMs);
    });
  }, [adapter]);

  // Continuous drift correction.
  useEffect(() => {
    if (adapter === null || playback === null) return;
    const controller = controllerRef.current;
    if (controller === null) return;

    /** Wall clock of the previous pass, to notice a tab that slept. */
    let lastTickAt = Date.now();
    /** A rate we prescribed and have not yet read back. */
    let rateProbe: { want: number; before: number; atMs: number } | null = null;

    const tick = (): void => {
      const nowMs = Date.now();
      const gap = nowMs - lastTickAt;
      lastTickAt = nowMs;
      // The tab slept or was frozen. Wherever the player is now is a fresh
      // start, not accumulated drift.
      if (gap > WAKE_GAP_MS) controller.noteBuffering();

      /*
       * A LIVE STREAM IS NAMED, AND THEN LEFT ALONE.
       *
       * The room's timeline starts at 0 and projects forward; a live player's
       * does not start at 0 at all. YouTube's iframe answers
       * elapsed-since-broadcast-start and refuses to name a length, and hls.js
       * opens a sliding window a few target-durations behind an edge that keeps
       * moving. So the measured "drift" is minutes; the controller's terminal
       * clamp is disabled, because a live stream has no duration to clamp with
       * (see sync-core drift.ts, `durationMs`); and every pass prescribes a
       * seek toward a position outside the DVR window, which the player refuses
       * or rounds — so the next pass prescribes it again, twice a second,
       * forever.
       *
       * There is nothing to correct toward. Everyone sits at their own live
       * edge, which for a broadcast is within seconds of everyone else's, and
       * that is the sync. TRANSPORT STILL APPLIES — the room's play/pause is
       * host intent and the effect above delivers it; only the position is left
       * alone. No drift sample is reported either: 0 would claim a measurement
       * this engine has deliberately stopped making.
       */
      const live = adapterIsLive(adapter);
      publishStageLive(live);
      if (live) return;

      // The length is worth reporting even while the room sits still — a
      // paused item has a duration, and a player that has started here has
      // certainly loaded the metadata for the item it started.
      if (startedHereRef.current) reportRef.current(adapter.durationMs());

      // Nothing to correct: the item is over here, or the room is paused.
      // Under the duration clamp below the real drift at the end IS ~0, so
      // reporting 0 to the HUD is honest rather than a frozen last reading.
      if (endedRef.current || !playback.playing) {
        onDriftSample?.(0);
        return;
      }

      // No estimate yet: `serverNow()` is this machine's own clock, and
      // correcting against it is correcting against a fiction. Say nothing —
      // a 0 here would read as "perfectly in sync", which is the one thing we
      // do not know.
      if (!projectionIsTrustworthy(playback)) return;

      const expected = expectedPositionMs(playback, clock.serverNow(nowMs));

      // A landing the track change could not perform because the clock was not
      // yet believable. It is still host intent, so it lands unbanded, and the
      // controller starts learning from where the item really begins.
      if (landingRef.current) {
        landingRef.current = false;
        land(playback, adapter);
        return;
      }

      const actual = adapter.positionMs();
      onDriftSample?.(expected - actual);

      // DID THE LAST SEEK TAKE? A player that snaps a correction to a keyframe
      // has honoured it; one that is still sitting where it was has not, and
      // asking it again on the next pass is how a stage ends up in a seek loop
      // nobody can see from the outside. Two in a row and this engine stops
      // asking (see the suppression below) — the extension's driver counts the
      // same misses, over telemetry, for the same reason.
      //
      // Measured where the seek WOULD BE by now, not where it was aimed: the
      // player kept running while we waited to look.
      const prescribed = pendingSeekRef.current;
      if (prescribed !== null && nowMs > prescribed.atMs) {
        pendingSeekRef.current = null;
        const wanted = prescribed.toMs + (nowMs - prescribed.atMs) * playback.rate;
        if (Math.abs(actual - wanted) > SEEK_MISS_MS) {
          seekMissesRef.current += 1;
          // Out of seeks: whatever lag the viewer settles at from here is a
          // fact to be adopted, not fought.
          if (!seekAvailable()) controller.noteBuffering();
        } else {
          seekMissesRef.current = 0;
        }
      }

      // Did the last nudge take? A player that silently drops playbackRate
      // (protected media is the usual one) must be reported ONCE, or the
      // controller goes on prescribing a correction that never happens while
      // the viewer sits further and further out. Read back only after the
      // player has had time to apply it, and conclude "ignored" only when the
      // rate did not move AT ALL — a rate that moved somewhere else is the
      // user changing speed, not a refusal. Same test as the extension's
      // `checkRateReadback`.
      const probe = rateProbe;
      if (probe !== null && nowMs - probe.atMs >= RATE_READBACK_GRACE_MS) {
        rateProbe = null;
        const seen = observedRate(adapter);
        if (
          seen !== null &&
          !rateRejectedRef.current &&
          rateDiffers(seen, probe.want) &&
          !rateDiffers(seen, probe.before)
        ) {
          rateRejectedRef.current = true;
          controller.noteRateRejected();
        }
      }

      // 0 while the duration is unknown (pre-metadata / YouTube pre-ready),
      // which the controller reads as "do not clamp".
      const durationMs = adapter.durationMs();
      const decision = controller.decide(
        expected,
        actual,
        durationMs > 0 ? { durationMs } : undefined,
      );
      if (decision.action === 'seek') {
        if (seekIsAffordable(nowMs)) {
          prescribeSeek(adapter, decision.toMs, nowMs);
        } else if (!seekAvailable()) {
          // An honest stop, and the reason the floor and the counter are worth
          // having: this player has ignored the last two corrections, so there
          // is nothing left to fight with. Adopt the lag and play smoothly at
          // it — which is what the elastic anchor is FOR — instead of
          // prescribing a correction that will never land. The magnitude is
          // measured against the same clamped expectation the controller
          // decides on, or a finished item would adopt an anchor made of
          // arithmetic past its own end.
          const ceiling = durationMs > 0 ? Math.min(expected, durationMs) : expected;
          controller.noteSettledLag(ceiling - controller.anchorOffsetMs() - actual);
        }
        adapter.setRate(playback.rate);
      } else if (decision.action === 'nudge') {
        const want = playback.rate * decision.rate;
        // Read BEFORE assigning: "did not move at all" needs the value the
        // player held while we were asking for something else.
        const before = observedRate(adapter);
        adapter.setRate(want);
        // Never overwrite an outstanding probe. A tick faster than the grace
        // period would otherwise replace the pending question on every pass and
        // the read-back above could never come due — the answer would depend on
        // `tickMs`, which has nothing to do with the player.
        if (rateProbe === null && before !== null && !rateRejectedRef.current) {
          rateProbe = { want, before, atMs: nowMs };
        }
      } else {
        adapter.setRate(playback.rate);
      }
    };

    const handle = setInterval(tick, tickMs ?? 500);
    return () => clearInterval(handle);
  }, [adapter, playback, clock, onDriftSample, tickMs]);
}
