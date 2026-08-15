'use client';

/**
 * CallStrip — in-room call dock (PiP presence orbs + mic/cam toggles).
 *
 * relayMode 'mesh' (default): REAL calls — getUserMedia → @playin/p2p
 * MeshManager fan-out over the room's signaling (E2E by DTLS-SRTP), remote
 * audio plays through hidden elements, mute states mirror into presence.
 * Publisher cap: room.policies.maxPublishers, honestly enforced in UI.
 *
 * relayMode 'livekit' / 'cf-sfu': HONEST BOUNDARY — the LiveKit token mint
 * (POST /rtc/livekit-token) is real; the SFU session is not bundled (p2p
 * LivekitProvider is NOT_ENABLED until ENABLE_SFU; cf-sfu awaits WF5 live
 * verification). Pressing Join mints the token and says exactly that —
 * presence is NOT set to in-call (that would fake state others render).
 */
import { useEffect, useRef, useState } from 'react';
import type { RoomId } from '@playin/contracts';
import { api } from '@/lib/api';
import { getCallMesh } from '@/lib/call-mesh';
import type { CallMesh } from '@/lib/call-mesh';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useQuery } from '@tanstack/react-query';

type CallPhase = 'idle' | 'joining' | 'in-call' | 'boundary';

/** Hidden audio elements for remote mic tracks (mesh mode). */
function RemoteAudio({ mesh }: { mesh: CallMesh }) {
  const [tracks, setTracks] = useState<MediaStreamTrack[]>([]);
  useEffect(
    () =>
      mesh.onRemoteTrack((_source, track) => {
        if (track.kind !== 'audio') return;
        setTracks((prev) => (prev.includes(track) ? prev : [...prev, track]));
        track.addEventListener('ended', () => {
          setTracks((prev) => prev.filter((t) => t !== track));
        });
      }),
    [mesh],
  );
  return (
    <>
      {tracks.map((t) => (
        <RemoteAudioTrack key={t.id} track={t} />
      ))}
    </>
  );
}

function RemoteAudioTrack({ track }: { track: MediaStreamTrack }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current !== null) {
      ref.current.srcObject = new MediaStream([track]);
      void ref.current.play().catch(() => undefined);
    }
  }, [track]);
  return <audio ref={ref} autoPlay className="hidden" />;
}

export function CallStrip({ roomId }: { roomId: RoomId }) {
  const connection = useRoomConnection();
  const { room, member } = useRoom();
  const me = member.userId;
  const presence = connection.useRoomState((s) => s.presence);
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [boundaryDetail, setBoundaryDetail] = useState<string | null>(null);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const camTrackRef = useRef<MediaStreamTrack | null>(null);

  const membersQuery = useQuery({
    queryKey: ['members', roomId],
    queryFn: () => api.rooms.listMembers(roomId),
  });
  const nameOf = (userId: string): string =>
    membersQuery.data?.members.find((m) => m.user.id === userId)?.user.displayName ?? '…';

  const inCall = Object.values(presence).filter((p) => p.state === 'in-call');
  const publisherCap = room.policies.maxPublishers;
  const capReached = inCall.length >= publisherCap && phase !== 'in-call';

  const leave = (): void => {
    const mesh = getCallMesh(connection, me);
    micTrackRef.current?.stop();
    camTrackRef.current?.stop();
    micTrackRef.current = null;
    camTrackRef.current = null;
    mesh.setLocalTrack('mic', null);
    mesh.setLocalTrack('cam', null);
    connection.presenceUpdate({ state: 'watching', micOn: false, camOn: false });
    setPhase('idle');
    setMicOn(true);
    setCamOn(false);
  };

  const joinMesh = async (): Promise<void> => {
    setPhase('joining');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      const mesh = getCallMesh(connection, me);
      mesh.start();
      const mic = stream.getAudioTracks()[0] ?? null;
      micTrackRef.current = mic;
      mesh.setLocalTrack('mic', mic);
      connection.presenceUpdate({ state: 'in-call', micOn: true, camOn: false });
      setPhase('in-call');
    } catch (err) {
      setPhase('idle');
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        toast.error('Microphone permission denied');
      } else {
        toast.error(err instanceof Error ? err.message : 'Could not join the call');
      }
    }
  };

  const joinSfu = async (): Promise<void> => {
    setPhase('joining');
    try {
      const { url } = await api.livekit.token({ roomId });
      setBoundaryDetail(
        `Token minted for ${url}. The ${room.relayMode} session itself is not bundled in this build — the SFU relay lands with ENABLE_SFU / WF5 live verification.`,
      );
      setPhase('boundary');
    } catch (err) {
      setBoundaryDetail(err instanceof Error ? err.message : 'token request failed');
      setPhase('boundary');
    }
  };

  const toggleMic = (): void => {
    const next = !micOn;
    const track = micTrackRef.current;
    if (track !== null) track.enabled = next;
    setMicOn(next);
    connection.presenceUpdate({ micOn: next });
  };

  const toggleCam = async (): Promise<void> => {
    const mesh = getCallMesh(connection, me);
    if (camOn) {
      camTrackRef.current?.stop();
      camTrackRef.current = null;
      mesh.setLocalTrack('cam', null);
      setCamOn(false);
      connection.presenceUpdate({ camOn: false });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const cam = stream.getVideoTracks()[0] ?? null;
      camTrackRef.current = cam;
      mesh.setLocalTrack('cam', cam);
      setCamOn(true);
      connection.presenceUpdate({ camOn: true });
    } catch {
      toast.error('Camera unavailable — check browser permissions');
    }
  };

  // Unmount = leave the call (tracks stopped, presence restored).
  useEffect(
    () => () => {
      if (micTrackRef.current !== null || camTrackRef.current !== null) {
        micTrackRef.current?.stop();
        camTrackRef.current?.stop();
        connection.presenceUpdate({ state: 'watching', micOn: false, camOn: false });
      }
    },
    [connection],
  );

  const mesh = phase === 'in-call' ? getCallMesh(connection, me) : null;

  return (
    <section aria-label="Call" data-room={roomId} className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* PiP presence orbs */}
        <div className="flex -space-x-2">
          {inCall.slice(0, 6).map((p) => (
            <span key={p.userId} title={nameOf(p.userId)}>
              <Avatar
                name={nameOf(p.userId)}
                size={28}
                speaking={p.micOn}
                className="ring-2 ring-void"
              />
            </span>
          ))}
        </div>
        <span className="min-w-0 flex-1 truncate text-xs text-mid">
          {inCall.length > 0 ? `${inCall.length} in call` : 'Room call'}
          <span className="text-low"> · {room.relayMode === 'mesh' ? 'E2E mesh' : room.relayMode}</span>
        </span>

        {phase === 'idle' && (
          <Button
            size="sm"
            disabled={capReached}
            title={capReached ? `Publisher cap (${publisherCap}) reached` : undefined}
            onClick={() => {
              if (room.relayMode === 'mesh') void joinMesh();
              else void joinSfu();
            }}
          >
            {capReached ? 'Call full' : 'Join call'}
          </Button>
        )}
        {phase === 'joining' && <span className="text-xs text-low">Joining…</span>}
        {phase === 'in-call' && (
          <>
            <Button
              variant={micOn ? 'secondary' : 'ghost'}
              size="sm"
              aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
              aria-pressed={!micOn}
              onClick={toggleMic}
            >
              {micOn ? '🎙' : '🔇'}
            </Button>
            {room.relayMode === 'mesh' && (
              <Button
                variant={camOn ? 'secondary' : 'ghost'}
                size="sm"
                aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
                aria-pressed={camOn}
                onClick={() => void toggleCam()}
              >
                📷
              </Button>
            )}
            <Button variant="destructive" size="sm" onClick={leave}>
              Leave
            </Button>
          </>
        )}
        {phase === 'boundary' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setPhase('idle');
              setBoundaryDetail(null);
            }}
          >
            Dismiss
          </Button>
        )}
      </div>

      {capReached && phase === 'idle' && (
        <p className="text-[10px] text-low">
          Mesh physics: ≤{publisherCap} simultaneous publishers per room. Theater mode
          (premium relay) lifts this.
        </p>
      )}
      {boundaryDetail !== null && (
        <p className="rounded-ctl border border-border-glass bg-glass px-2 py-1.5 text-[11px] text-mid">
          {boundaryDetail}
        </p>
      )}

      {mesh !== null && <RemoteAudio mesh={mesh} />}
    </section>
  );
}
