'use client';

/**
 * ScreenShareStage — one member's screen, tab or window on the room's stage.
 *
 * NAMING. This was `ModeBStage`, after internal spec vocabulary ("Mode A" =
 * the room plays a media source, "Mode B" = someone shares their screen) that
 * meant nothing to anyone reading the code and never appeared on screen. The
 * component says what it is now. The WIRE is untouched: the room's events are
 * still `restream.start` / `restream.stop` / `restream.state`, because an
 * already-installed extension and every deployed client speak those names.
 *
 * Host: getDisplayMedia capture (tab/screen WITH audio — the pre-flight dialog
 * below makes the DRM honesty explicit) → restream.start → the capture fans
 * out per-viewer over the E2E mesh (CallMesh 'share' track, default cap 8
 * viewers — host uplink is the physics ceiling and the UI says so).
 *
 * The host session lives at MODULE level, not in component state: StagePane
 * mounts one ScreenShareStage inside the share dialog and a SECOND one on the
 * stage once restream.state flips, and the capture must survive that handoff.
 * Component-held state died with whichever instance unmounted first — closing
 * the dialog killed the share while the room still said it was live, and the
 * stage-mounted instance could never see the dialog instance's stream.
 *
 * Feedback contract: every way the chain can fail — picker dismissed or
 * permission denied, room never acknowledging restream.start — surfaces one
 * plain sentence, and the controls return to a clickable idle. A silent
 * return to idle is a bug.
 *
 * Viewer: renders the host's mesh 'share' track when restream.state is active.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { RestreamState, UserId } from '@gather/contracts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { describeError } from '@/lib/describe-error';
import { UPLINK_LABEL } from '@/lib/labels';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import type { RoomConnection } from '@/lib/room-connection';
import { claimAudioSink, getCallMesh, onCallMeshClosed } from '@/lib/call-mesh';

/* ── host share session (module-level; see the header comment) ───────────── */

/** How long the host waits for the room to acknowledge restream.start before
 *  the share is declared failed and torn back down to a clickable idle. */
export const SHARE_ACK_TIMEOUT_MS = 8_000;

/** A dismissed picker and a denied permission both throw one NotAllowedError —
 *  indistinguishable, so one sentence covers both. */
export const SHARE_NOT_STARTED_NOTE =
  'Screen sharing didn’t start — the picker was closed or permission was blocked.';

/** The room never switched (restream.start rejected, or no answer in time). */
export const SHARE_NO_ACK_NOTE =
  'The room couldn’t switch to your share — check your connection and try again.';

/** The room moved on while we were live: a moderator stopped the share, or
 *  handed it to someone else. The capture must not outlive the room's word. */
export const SHARE_ENDED_NOTE = 'Your share was ended for the room.';

/** Autoplay policy refused sound on the share. The picture keeps running
 *  muted and this is the one tap that turns the sound on — the alternative
 *  (what shipped) is a silent share with nothing to click and nothing said. */
export const SHARE_SOUND_BLOCKED_LABEL = 'Tap to enable sound';

type SharePhase = 'idle' | 'capturing' | 'starting' | 'live';

interface ShareHostState {
  phase: SharePhase;
  stream: MediaStream | null;
}

/** Every mounted ScreenShareStage renders the same session through this store. */
export const useShareHost = create<ShareHostState>()(() => ({
  phase: 'idle',
  stream: null,
}));

/** Active session teardown; null when no session holds a capture. */
let teardown: ((notifyServer: boolean) => void) | null = null;

/** Stop the running share: capture released, mesh track withdrawn, room told. */
export function stopShare(): void {
  teardown?.(true);
}

/** Test hook: drop any session and restore the pristine idle store. */
export function resetShareHost(): void {
  teardown?.(false);
  Object.assign(useShareHost.getInitialState(), { phase: 'idle', stream: null });
  useShareHost.setState({ phase: 'idle', stream: null });
}

/**
 * The whole host flow: capture → local feed → mesh fan-out → restream.start →
 * wait for the room's restream.state to confirm. The local feed and the mesh
 * track come straight from the capture — local truth, never gated on the
 * server echo; only the 'live' phase waits for the room.
 */
export async function startShare(connection: RoomConnection, userId: UserId): Promise<void> {
  if (useShareHost.getState().phase !== 'idle') return;
  useShareHost.setState({ phase: 'capturing' });

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true, // tab/screen audio — a silent share is half a share
    });
  } catch (err) {
    useShareHost.setState({ phase: 'idle', stream: null });
    toast.error(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? SHARE_NOT_STARTED_NOTE
        : describeError(err, SHARE_NOT_STARTED_NOTE),
    );
    return;
  }

  const mesh = getCallMesh(connection, userId);
  mesh.start();
  const video = stream.getVideoTracks()[0] ?? null;
  const audio = stream.getAudioTracks()[0] ?? null;
  mesh.setLocalTrack('share', video);
  // 'share-audio', never 'mic'. A role is a sender: publishing the tab's
  // soundtrack on 'mic' replaced the host's voice for the whole room, and
  // withdrawing it on stop left them muted with the mic button reading "on".
  // The microphone is CallSurface's to own, and sharing must not touch it.
  if (audio !== null) mesh.setLocalTrack('share-audio', audio);

  // The browser's own "Stop sharing" bar ends the track outside our UI.
  const onEnded = (): void => stopShare();
  video?.addEventListener('ended', onEnded);

  // A CLOSED TAB. Nothing in React runs for one — no unmount, no cleanup — so
  // without this the room kept `restream.active: true` with no share behind it
  // and no way for anyone to clear it: the stage was hijacked permanently.
  // `pagehide` is the last event that can still put a frame on the wire, and it
  // covers the close, the reload and the bfcache freeze alike. Freezing is
  // treated as leaving on purpose: a frozen page has already stopped sending,
  // so a share that "survives" it is a share the room is watching a still of.
  const onPageHide = (): void => stopShare();
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let offAck: () => void = () => undefined;
  let offMeshClosed: () => void = () => undefined;

  teardown = (notifyServer: boolean): void => {
    teardown = null;
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    offAck();
    offMeshClosed();
    video?.removeEventListener('ended', onEnded);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
    for (const track of stream.getTracks()) track.stop();
    if (!mesh.closed) {
      mesh.setLocalTrack('share', null);
      if (audio !== null) mesh.setLocalTrack('share-audio', null);
    }
    if (notifyServer) {
      // Best-effort by nature: the socket may already be closing under us (a
      // tab going away, a room torn down around us). Releasing THIS device's
      // capture is not best-effort, so a send that throws must not carry off
      // the idle reset below with it.
      try {
        connection.restreamStop();
        connection.presenceUpdate({ sharing: false });
      } catch {
        // The room's own liveness has to cover this one — see the note on the
        // mesh-closed subscription below.
      }
    }
    useShareHost.setState({ phase: 'idle', stream: null });
  };

  const fail = (): void => {
    teardown?.(true);
    toast.error(SHARE_NO_ACK_NOTE);
  };

  offAck = connection.useRoomState.subscribe((s, prev) => {
    const { phase } = useShareHost.getState();
    if (phase !== 'starting' && phase !== 'live') return;
    if (s.restream?.active === true && s.restream.hostUserId === userId) {
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      if (phase === 'starting') useShareHost.setState({ phase: 'live' });
      return;
    }
    // The hub answers a failed/unsupported restream.start with an error frame;
    // while we are the one waiting, that frame is ours — fail now, with the
    // sentence, instead of waiting out the clock.
    if (phase === 'starting' && s.lastError !== prev.lastError && s.lastError !== null) {
      fail();
      return;
    }
    // LIVE and the room no longer says it is ours: a moderator stopped the
    // share, or it was taken over. The capture must end NOW — the browser's
    // recording indicator staying on after the room moved on is the exact
    // silent-share failure this file exists to prevent. No restream.stop:
    // the server state already moved, and re-sending would stomp a takeover.
    if (phase === 'live' && !(s.restream?.active === true && s.restream.hostUserId === userId)) {
      teardown?.(false);
      toast(SHARE_ENDED_NOTE);
    }
  });

  // ROOM UNMOUNT (the back arrow, a route change) closes the mesh. Two things
  // have to happen and only one of them used to: the capture is released, or
  // the browser's recording indicator outlives every control that could stop
  // it — and the ROOM is told, or `restream.active` stays true forever and the
  // share hijacks the stage for everybody still in there.
  //
  // It notifies on a BEST-EFFORT basis, and the server may not hear it. React
  // runs an ancestor's cleanup before its descendants', so RoomProvider has
  // already called connection.close() by the time closeCallMesh reaches this —
  // the frame goes into a socket that is on its way out. Saying it anyway costs
  // nothing and lands whenever the socket does outlive the mesh; what actually
  // guarantees the room is freed is the server noticing the sharer's socket is
  // gone, which is the other half of this fix and lives in services/api.
  offMeshClosed = onCallMeshClosed((closedConn) => {
    if (closedConn === connection) teardown?.(true);
  });

  watchdog = setTimeout(fail, SHARE_ACK_TIMEOUT_MS);

  useShareHost.setState({ phase: 'starting', stream });
  connection.restreamStart();
  connection.presenceUpdate({ sharing: true });

  // The room may already say we are live (synchronous test fakes, a rejoin).
  const current = connection.useRoomState.getState().restream;
  if (current?.active === true && current.hostUserId === userId) {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    useShareHost.setState({ phase: 'live' });
  }
}

/* ── AirPlay guidance (CAST_RELAY.md §2) ─────────────────────────────────── */

/**
 * The entire client-side AirPlay feature is one line of copy: mirroring is
 * OS-owned with no web API, and a WebRTC `srcObject` share is a blob source no
 * per-element picker can act on. So while a share is on stage, an Apple device
 * gets the platform's own mirroring path spelled out. CAST_RELAY §2 put this
 * in the PlayerControls cast popover, but StagePane withholds the whole
 * transport during a share — the share stage itself is the only surface that
 * exists at the moment the hint is relevant.
 */
function platformCastHint(): string | null {
  if (typeof navigator === 'undefined') return null;
  const p = navigator.platform;
  if (p.startsWith('Mac')) {
    return 'To put this on your TV: menu bar → Control Center → Screen Mirroring.';
  }
  if (p === 'iPhone' || p === 'iPad' || p === 'iPod') {
    return 'To put this on your TV: Control Center (swipe down from the top-right) → Screen Mirroring.';
  }
  return null;
}

/** A bar BELOW the picture, never over it — the stage is never covered. */
function CastHint() {
  const hint = platformCastHint();
  if (hint === null) return null;
  return (
    <p className="w-full shrink-0 bg-surface-1 px-4 py-2 text-center text-label text-low">
      {hint}
    </p>
  );
}

/* ── components ──────────────────────────────────────────────────────────── */

/** Host flow: pre-flight honesty → capture → mesh fan-out. */
function HostControls() {
  const connection = useRoomConnection();
  const { member } = useRoom();
  const phase = useShareHost((s) => s.phase);
  const [preflightOpen, setPreflightOpen] = useState(false);

  return (
    <>
      {phase === 'idle' && (
        <Button variant="secondary" size="sm" onClick={() => setPreflightOpen(true)}>
          Share screen
        </Button>
      )}
      {phase === 'capturing' && (
        <span className="text-label text-low">Waiting for the picker…</span>
      )}
      {phase === 'starting' && (
        <span className="text-label text-low">Starting your share…</span>
      )}
      {(phase === 'starting' || phase === 'live') && (
        <Button variant="destructive" size="sm" onClick={stopShare}>
          Stop sharing
        </Button>
      )}

      <Dialog open={preflightOpen} onOpenChange={setPreflightOpen}>
        <DialogContent aria-label="Before you share">
          <DialogTitle>Share your screen with the room</DialogTitle>
          <div className="mt-3 flex flex-col gap-3 text-body text-mid">
            <p>
              Pick a <strong>tab or window with audio</strong> — everyone in the room
              sees it, sent straight from your device and encrypted on the way.
            </p>
            <p>
              Most streaming services block screen recording, so their shows come
              through as a black picture. Screen sharing is for your own content and
              sites that allow it.
            </p>
            <p className="text-low">
              Your device sends one copy to each viewer (up to 8), so your connection
              sets the quality everyone sees.
            </p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPreflightOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setPreflightOpen(false);
                void startShare(connection, member.userId);
              }}
            >
              Choose what to share
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Viewer: the sharing host's picture AND their sound, on one element.
 *
 * Sound, because the audio half of a share used to be thrown away here
 * (`track.kind !== 'video'` → return) while the app's only remote <audio> sink
 * lived inside the call and was gated on having pressed Join. A viewer
 * watching a share who had not joined the call could not hear it. Ever.
 *
 * ROLE, because a host sharing with their camera on publishes 'cam' AND
 * 'share' over one peer connection, and this used to take every track from
 * them: both are video, the camera was the newer one, and the stage rendered
 * the host's FACE instead of their screen for everybody watching. The mesh
 * names a remote track's role now, and the two CALL roles are refused at the
 * door — they are CallSurface's to render and to sink.
 *
 * A null role means the mesh genuinely cannot say (an older extension build
 * announces nothing), and the answer to null is what this always did: take the
 * track, newest video wins. Losing the share outright would be a worse failure
 * than the one being fixed.
 *
 * ONE element, because two elements on one track play it twice. The share
 * <video> carries the video and the share's own sound, so the "exactly one
 * sink" rule holds by construction here, and `claimAudioSink` tells the call's
 * hidden sinks to stand down for exactly the tracks this element plays — no
 * more, or the host's microphone goes quiet for the room (lib/call-mesh.ts).
 *
 * Withdrawn tracks leave: a renegotiated share used to leave its dead first
 * track at the front of the MediaStream with the element still rendering it.
 */
function ShareViewer({ hostUserId }: { hostUserId: UserId }) {
  const connection = useRoomConnection();
  const { member } = useRoom();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [tracks, setTracks] = useState<readonly MediaStreamTrack[]>([]);
  const [soundBlocked, setSoundBlocked] = useState(false);
  /** Audio sinks this viewer owns → their releases. Stable for its lifetime,
   *  and its own identity is the owner token the claims are held under. */
  const claims = useRef(new Map<MediaStreamTrack, () => void>());

  useEffect(() => {
    const mesh = getCallMesh(connection, member.userId);
    mesh.start();
    const held = claims.current;
    const off = mesh.onRemoteTrack((source, track, role) => {
      if (source !== hostUserId) return;
      // The host's camera and microphone are the CALL's, whatever else they
      // are publishing. Refusing them here is the fix; a role the mesh could
      // not name arrives as null and is taken, exactly as before.
      if (role === 'cam' || role === 'mic') return;
      // Claimed on ARRIVAL rather than from an effect: the call surface picks
      // which tracks to sink during the very render this setState schedules,
      // and a claim that waited for the effect flush would leave a second
      // element on this track for one commit — one commit of doubled audio.
      if (track.kind === 'audio' && !held.has(track)) {
        held.set(track, claimAudioSink(track, held));
      }
      setTracks((prev) => (prev.includes(track) ? prev : [...prev, track]));
    });
    // D8: the mesh has always announced tracks going away; nothing listened,
    // so a dead track stayed on screen until the whole pane remounted.
    const offRemoved = mesh.onRemoteTrackRemoved((source, track) => {
      if (source !== hostUserId) return;
      held.get(track)?.();
      held.delete(track);
      setTracks((prev) => (prev.includes(track) ? prev.filter((t) => t !== track) : prev));
    });
    return () => {
      off();
      offRemoved();
      // The share is no longer on screen: hand the sound back to the call.
      for (const release of held.values()) release();
      held.clear();
    };
  }, [connection, member.userId, hostUserId]);

  /** What this element plays: the newest video, plus all of the host's audio. */
  const playing = useMemo(() => {
    const video = [...tracks].reverse().find((t) => t.kind === 'video') ?? null;
    const audio = tracks.filter((t) => t.kind === 'audio');
    return { video, audio, all: video === null ? audio : [video, ...audio] };
  }, [tracks]);

  /** Try for sound; fall back to a muted picture with a tap to fix it. */
  const attemptPlay = useCallback((el: HTMLVideoElement): void => {
    void el.play().then(
      () => setSoundBlocked(false),
      () => {
        // Autoplay refused sound. Muted playback is always permitted, so the
        // picture starts either way and the sound becomes one tap away.
        el.muted = true;
        void el.play().catch(() => undefined);
        setSoundBlocked(true);
      },
    );
  }, []);

  /* Mutate one MediaStream in place rather than swapping srcObject: a swap
     restarts the element, and the track set changes on every renegotiation. */
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    let stream = streamRef.current;
    if (stream === null) {
      stream = new MediaStream();
      streamRef.current = stream;
      el.srcObject = stream;
    }
    const wanted = new Set(playing.all);
    for (const track of stream.getTracks()) {
      if (!wanted.has(track)) stream.removeTrack(track);
    }
    for (const track of playing.all) stream.addTrack(track);
    if (playing.all.length > 0) attemptPlay(el);
  }, [playing, attemptPlay]);

  return (
    <div className="flex h-full w-full flex-col bg-void">
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="max-h-full max-w-full"
          aria-label="Shared screen"
        />
        {playing.video === null && (
          <p className="absolute max-w-sm px-6 text-center text-body text-low">
            Connecting to the host’s screen… this can take a moment.
          </p>
        )}
        {soundBlocked && playing.audio.length > 0 && (
          <div className="absolute bottom-4">
            <Button
              size="sm"
              onClick={() => {
                const el = videoRef.current;
                if (el === null) return;
                el.muted = false;
                attemptPlay(el);
              }}
            >
              {SHARE_SOUND_BLOCKED_LABEL}
            </Button>
          </div>
        )}
      </div>
      <CastHint />
    </div>
  );
}

/** Share stage content + host controls; the pane mounts this when relevant. */
export function ScreenShareStage({ restream }: { restream: RestreamState }) {
  const { member } = useRoom();
  // Local truth: the capture this device holds. Never gated on the server
  // echo (restream.hostUserId) — that round-trip is exactly what can fail,
  // and the host must see their own feed the moment the capture exists.
  const localStream = useShareHost((s) => s.stream);
  const isHost = restream.hostUserId === member.userId;

  if (restream.active && !isHost && restream.hostUserId !== null && localStream === null) {
    return <ShareViewer hostUserId={restream.hostUserId} />;
  }

  // `headline`, not `display`. This same component renders in TWO places — the
  // stage, and inside the share dialog StagePane opens over it — so the step it
  // takes has to be the one that is correct in a modal as well; a screen gets
  // exactly one display setting and it is never a dialog's (§3, §10).
  return (
    <div className="grain flex h-full w-full flex-col items-center justify-center gap-8 px-6 py-section text-center">
      {localStream !== null ? (
        <LocalPreview stream={localStream} />
      ) : (
        <div className="flex max-w-md flex-col items-center gap-3">
          <p className="text-caption text-low">Screen share</p>
          <h2 className="text-headline text-hi">Share a tab, window, or screen</h2>
          <p className="text-body text-low">
            Everyone in the room watches what you share, sent straight from your
            device and encrypted on the way. Up to 8 viewers — your connection sets
            the quality.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <HostControls />
        {/* The gradient's third sanctioned place: the live indicator (§2). It
            is the only one on this stage — the transport is withheld during a
            share, so nothing else here can spend the region's budget. */}
        {restream.active && (
          <Badge variant="aurora">
            Live · {restream.viewerCount} watching
            {restream.uplinkQuality !== null
              ? ` · ${UPLINK_LABEL[restream.uplinkQuality]}`
              : ''}
          </Badge>
        )}
      </div>
    </div>
  );
}

function LocalPreview({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current !== null) {
      ref.current.srcObject = stream;
      void ref.current.play().catch(() => undefined);
    }
  }, [stream]);
  return (
    <video
      ref={ref}
      muted
      playsInline
      // `shadow-e1` carries its own hairline ring (§4), so the border this had
      // is gone rather than doubled — and a share preview floating on the void
      // is exactly the "raised" rung.
      className="max-h-[50vh] max-w-full rounded-card shadow-e1"
      aria-label="Your shared screen preview"
    />
  );
}
