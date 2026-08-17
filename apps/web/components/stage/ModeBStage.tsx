'use client';

/**
 * ModeBStage — re-stream (Mode B, spec §Playback — Mode B / v3.1 P2P pivot).
 * "Mode B" is INTERNAL vocabulary: every user-facing string here says
 * "screen share" instead.
 *
 * Host: getDisplayMedia capture (tab/screen WITH audio — the pre-flight dialog
 * below makes the DRM honesty explicit) → restream.start → the capture fans
 * out per-viewer over the E2E mesh (CallMesh 'share' track, default cap 8
 * viewers — host uplink is the physics ceiling and the UI says so).
 *
 * The host session lives at MODULE level, not in component state: StagePane
 * mounts one ModeBStage inside the share dialog and a SECOND one on the stage
 * once restream.state flips, and the capture must survive that handoff.
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
 * LiveKit relay stays a documented boundary (p2p LivekitProvider is
 * NOT_ENABLED until ENABLE_SFU) — nothing here is simulated.
 */
import { useEffect, useRef, useState } from 'react';
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
import { getCallMesh, onCallMeshClosed, primeSharePlan, SHARE_RELAY_NOTE } from '@/lib/call-mesh';

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

type SharePhase = 'idle' | 'capturing' | 'starting' | 'live';

interface ShareHostState {
  phase: SharePhase;
  stream: MediaStream | null;
}

/** Every mounted ModeBStage renders the same session through this store. */
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
      audio: true, // tab/screen audio — the whole point of Mode B
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
  if (audio !== null) mesh.setLocalTrack('mic', audio);
  // Free shares over a relayed connection are quality-limited; the host is
  // told once, in one sentence, and the share carries on.
  const offRelayed = mesh.onShareRelayed(() => toast(SHARE_RELAY_NOTE));

  // The browser's own "Stop sharing" bar ends the track outside our UI.
  const onEnded = (): void => stopShare();
  video?.addEventListener('ended', onEnded);

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
    offRelayed();
    video?.removeEventListener('ended', onEnded);
    for (const track of stream.getTracks()) track.stop();
    if (!mesh.closed) {
      mesh.setLocalTrack('share', null);
      if (audio !== null) mesh.setLocalTrack('mic', null);
    }
    if (notifyServer) {
      connection.restreamStop();
      connection.presenceUpdate({ sharing: false });
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

  // Room unmount closes the mesh (closeCallMesh); a capture that outlives the
  // room would keep the browser's recording indicator on with no UI to stop it.
  offMeshClosed = onCallMeshClosed((closedConn) => {
    if (closedConn === connection) teardown?.(false);
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
        <span className="text-xs text-low">Waiting for the picker…</span>
      )}
      {phase === 'starting' && (
        <span className="text-xs text-low">Starting your share…</span>
      )}
      {(phase === 'starting' || phase === 'live') && (
        <Button variant="destructive" size="sm" onClick={stopShare}>
          Stop sharing
        </Button>
      )}

      <Dialog open={preflightOpen} onOpenChange={setPreflightOpen}>
        <DialogContent aria-label="Before you share">
          <DialogTitle>Share your screen with the room</DialogTitle>
          <div className="mt-2 flex flex-col gap-2 text-sm text-mid">
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

/** Viewer: subscribe to the sharing host's mesh 'share' track. */
function ShareViewer({ hostUserId }: { hostUserId: UserId }) {
  const connection = useRoomConnection();
  const { member } = useRoom();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [gotTrack, setGotTrack] = useState(false);

  useEffect(() => {
    const mesh = getCallMesh(connection, member.userId);
    mesh.start();
    const off = mesh.onRemoteTrack((source, track) => {
      if (source !== hostUserId || track.kind !== 'video') return;
      const el = videoRef.current;
      if (el === null) return;
      const stream = el.srcObject instanceof MediaStream ? el.srcObject : new MediaStream();
      stream.addTrack(track);
      el.srcObject = stream;
      setGotTrack(true);
      void el.play().catch(() => undefined);
    });
    return off;
  }, [connection, member.userId, hostUserId]);

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="max-h-full max-w-full"
        aria-label="Shared screen"
      />
      {!gotTrack && (
        <p className="absolute text-sm text-mid">
          Connecting to the host’s screen… this can take a moment.
        </p>
      )}
    </div>
  );
}

/** Mode B stage content + host controls; the pane mounts this when relevant. */
export function ModeBStage({ restream }: { restream: RestreamState }) {
  const { member } = useRoom();
  // Local truth: the capture this device holds. Never gated on the server
  // echo (restream.hostUserId) — that round-trip is exactly what can fail,
  // and the host must see their own feed the moment the capture exists.
  const localStream = useShareHost((s) => s.stream);
  const isHost = restream.hostUserId === member.userId;

  // Resolve the plan before a share can start: the mesh reads it when it is
  // created, and only a plan known to be premium lifts the share quality cap.
  useEffect(() => {
    primeSharePlan();
  }, []);

  if (restream.active && !isHost && restream.hostUserId !== null && localStream === null) {
    return <ShareViewer hostUserId={restream.hostUserId} />;
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
      {localStream !== null ? (
        <LocalPreview stream={localStream} />
      ) : (
        <>
          <p className="font-display text-lg font-semibold text-hi">
            Share a tab, window, or screen
          </p>
          <p className="max-w-md text-sm text-mid">
            Everyone in the room watches what you share, sent straight from your
            device and encrypted on the way. Up to 8 viewers — your connection sets
            the quality.
          </p>
        </>
      )}
      <div className="flex items-center gap-2">
        <HostControls />
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
      className="max-h-[50vh] max-w-full rounded-card border border-border-glass"
      aria-label="Your shared screen preview"
    />
  );
}
