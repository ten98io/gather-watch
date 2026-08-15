'use client';

/**
 * ModeBStage — re-stream (Mode B, spec §Playback — Mode B / v3.1 P2P pivot).
 *
 * Host: getDisplayMedia capture (tab/screen WITH audio — the pre-flight dialog
 * below makes the DRM honesty explicit) → restream.start → the capture fans
 * out per-viewer over the E2E mesh (CallMesh 'share' track, default cap 8
 * viewers — host uplink is the physics ceiling and the UI says so).
 *
 * Viewer: renders the host's mesh 'share' track when restream.state is active.
 * LiveKit relay stays a documented boundary (p2p LivekitProvider is
 * NOT_ENABLED until ENABLE_SFU) — nothing here is simulated.
 */
import { useEffect, useRef, useState } from 'react';
import type { RestreamState, UserId } from '@playin/contracts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { getCallMesh } from '@/lib/call-mesh';

type HostPhase = 'idle' | 'preflight' | 'capturing' | 'live';

/** Host flow: pre-flight honesty → capture → mesh fan-out. */
function HostControls({ onStream }: { onStream(stream: MediaStream | null): void }) {
  const connection = useRoomConnection();
  const [phase, setPhase] = useState<HostPhase>('idle');
  const streamRef = useRef<MediaStream | null>(null);

  const stop = (): void => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    connection.restreamStop();
    connection.presenceUpdate({ sharing: false });
    onStream(null);
    setPhase('idle');
  };

  const begin = async (): Promise<void> => {
    setPhase('capturing');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true, // tab/screen audio — the whole point of Mode B
      });
      streamRef.current = stream;
      const video = stream.getVideoTracks()[0];
      video?.addEventListener('ended', stop); // user hit the browser's stop bar
      connection.restreamStart();
      connection.presenceUpdate({ sharing: true });
      onStream(stream);
      setPhase('live');
    } catch (err) {
      setPhase('idle');
      if (err instanceof DOMException && err.name === 'NotAllowedError') return; // cancelled
      toast.error(err instanceof Error ? err.message : 'Screen capture failed');
    }
  };

  return (
    <>
      {phase === 'idle' && (
        <Button variant="secondary" size="sm" onClick={() => setPhase('preflight')}>
          Share screen (Mode B)
        </Button>
      )}
      {phase === 'capturing' && (
        <span className="text-xs text-low">Waiting for the picker…</span>
      )}
      {phase === 'live' && (
        <Button variant="destructive" size="sm" onClick={stop}>
          Stop sharing
        </Button>
      )}

      <Dialog open={phase === 'preflight'} onOpenChange={(o) => !o && setPhase('idle')}>
        <DialogContent aria-label="Before you share">
          <DialogTitle>Share your screen with the room</DialogTitle>
          <div className="mt-2 flex flex-col gap-2 text-sm text-mid">
            <p>
              Pick a <strong>tab or window with audio</strong> — everyone in the room
              watches your capture, end-to-end encrypted peer-to-peer.
            </p>
            <p>
              Protected content (DRM — most streaming services) renders black by
              OS/browser design, not a bug. Mode B is for non-DRM and your own
              content.
            </p>
            <p className="text-low">
              Your uplink carries one copy per viewer (cap: 8). The room’s quality
              ceiling is your connection.
            </p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPhase('idle')}>
              Cancel
            </Button>
            <Button onClick={() => void begin()}>Choose what to share</Button>
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
          Connecting to the host’s share… (peer-to-peer, this can take a moment)
        </p>
      )}
    </div>
  );
}

/** Mode B stage content + host controls; the pane mounts this when relevant. */
export function ModeBStage({ restream }: { restream: RestreamState }) {
  const { member } = useRoom();
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const connection = useRoomConnection();
  const isHost = restream.hostUserId === member.userId;

  // Fan the capture out over the mesh while we host.
  useEffect(() => {
    if (localStream === null) return;
    const mesh = getCallMesh(connection, member.userId);
    mesh.start();
    const video = localStream.getVideoTracks()[0] ?? null;
    const audio = localStream.getAudioTracks()[0] ?? null;
    mesh.setLocalTrack('share', video);
    if (audio !== null) mesh.setLocalTrack('mic', audio);
    return () => {
      mesh.setLocalTrack('share', null);
      if (audio !== null) mesh.setLocalTrack('mic', null);
    };
  }, [connection, member.userId, localStream]);

  if (restream.active && !isHost && restream.hostUserId !== null) {
    return <ShareViewer hostUserId={restream.hostUserId} />;
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
      {isHost && localStream !== null ? (
        <LocalPreview stream={localStream} />
      ) : (
        <>
          <p className="font-display text-lg font-semibold text-hi">
            Share a tab, window, or screen
          </p>
          <p className="max-w-md text-sm text-mid">
            Mode B re-streams your capture to everyone — end-to-end encrypted,
            peer-to-peer. Your uplink is the ceiling (viewer cap 8).
          </p>
        </>
      )}
      <div className="flex items-center gap-2">
        <HostControls onStream={setLocalStream} />
        {restream.active && (
          <Badge variant="aurora">
            Live · {restream.viewerCount} watching
            {restream.uplinkQuality !== null ? ` · uplink ${restream.uplinkQuality}` : ''}
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
