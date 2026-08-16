'use client';

/**
 * CallGrid — the in-room call's video/audio surface, Zoom-style but calm.
 * Video publishers get tiles (their mesh 'cam' track); audio-only get orbs.
 * The active speaker gets the aurora ring (presence micOn + cam state —
 * server-mirrored, never simulated). Everyone in the call but me renders
 * here; my own preview tile included when my cam is on.
 *
 * Theater etiquette: the grid is collapsible — a floating pill ("3 in call")
 * by default in theater mode so it never covers the film.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UserId } from '@playin/contracts';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { getCallMesh } from '@/lib/call-mesh';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

interface RemoteVideo {
  userId: UserId;
  track: MediaStreamTrack;
}

function VideoTile({
  stream,
  label,
  speaking,
  muted,
  mirror,
}: {
  stream: MediaStream;
  label: string;
  speaking: boolean;
  muted: boolean;
  mirror?: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current !== null) {
      ref.current.srcObject = stream;
      void ref.current.play().catch(() => undefined);
    }
  }, [stream]);
  return (
    <figure
      className={cn(
        'relative overflow-hidden rounded-card border bg-black shadow-glow',
        speaking ? 'border-aurora-2' : 'border-border-glass',
      )}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={mirror === true /* never echo my own cam back at me */}
        className={cn('h-28 w-44 object-cover sm:h-32 sm:w-52', mirror === true && '-scale-x-100')}
      />
      <figcaption className="absolute bottom-1 left-1.5 flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">
        {muted ? '🔇' : '🎙'} {label}
      </figcaption>
    </figure>
  );
}

export function CallGrid({ theater }: { theater: boolean }) {
  const connection = useRoomConnection();
  const { member } = useRoom();
  const me = member.userId;
  const presence = connection.useRoomState((s) => s.presence);
  const membersVersion = connection.useRoomState((s) => s.membersVersion);
  void membersVersion;

  const [remoteVideos, setRemoteVideos] = useState<RemoteVideo[]>([]);
  const [localCam, setLocalCam] = useState<MediaStreamTrack | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState(theater);

  // Names for tiles/orbs come from the member list (shared query cache).
  useEffect(() => {
    import('@/lib/api').then(({ api }) =>
      api.rooms
        .listMembers(connection.roomId)
        .then((res) => {
          const map: Record<string, string> = {};
          for (const { user } of res.members) map[user.id] = user.displayName;
          setNames(map);
        })
        .catch(() => undefined),
    );
  }, [connection, membersVersion]);

  // Remote cam tracks via the shared mesh; my own cam via the local-track sub.
  useEffect(() => {
    const mesh = getCallMesh(connection, me);
    mesh.start();
    const offLocal = mesh.onLocalTrack((role, track) => {
      if (role === 'cam') setLocalCam(track);
    });
    const offRemote = mesh.onRemoteTrack((source, track) => {
      if (track.kind !== 'video') return;
      track.addEventListener('ended', () => {
        setRemoteVideos((prev) => prev.filter((v) => v.track !== track));
      });
      setRemoteVideos((prev) => {
        const next = prev.filter((v) => !(v.userId === source && v.track.id === track.id));
        return [...next, { userId: source, track }];
      });
    });
    return () => {
      offLocal();
      offRemote();
    };
  }, [connection, me]);

  const inCall = useMemo(
    () => Object.values(presence).filter((p) => p.state === 'in-call'),
    [presence],
  );

  const videoTiles = useMemo(() => {
    const byUser = new Map<UserId, MediaStreamTrack>();
    for (const v of remoteVideos) byUser.set(v.userId, v.track);
    return [...byUser.entries()].map(([userId, track]) => ({ userId, track }));
  }, [remoteVideos]);

  const audioOnly = inCall.filter(
    (p) => !p.camOn && !videoTiles.some((t) => t.userId === p.userId),
  );

  if (inCall.length === 0) return null;

  if (collapsed) {
    return (
      <div className="pointer-events-auto absolute left-1/2 top-4 z-30 -translate-x-1/2">
        <Button variant="secondary" size="sm" onClick={() => setCollapsed(false)}>
          🎥 {inCall.length} in call — show
        </Button>
      </div>
    );
  }

  return (
    <div className="pointer-events-auto absolute left-1/2 top-4 z-30 flex max-w-[90%] -translate-x-1/2 flex-col items-center gap-2">
      <div className="flex flex-wrap items-start justify-center gap-2">
        {localCam !== null && (
          <VideoTile
            key="me"
            stream={new MediaStream([localCam])}
            label="You"
            speaking={presence[me]?.micOn === true}
            muted={presence[me]?.micOn !== true}
            mirror
          />
        )}
        {videoTiles.map(({ userId, track }) => (
          <VideoTile
            key={`${userId}:${track.id}`}
            stream={new MediaStream([track])}
            label={userId === me ? 'You' : (names[userId] ?? '…')}
            speaking={presence[userId]?.micOn === true}
            muted={presence[userId]?.micOn !== true}
            mirror={userId === me}
          />
        ))}
        {audioOnly.map((p) => (
          <div
            key={p.userId}
            className={cn(
              'glass-raised flex items-center gap-2 rounded-full border px-3 py-1.5 shadow-glow',
              p.micOn ? 'border-aurora-2' : 'border-border-glass',
            )}
          >
            <Avatar
              name={p.userId === me ? 'You' : (names[p.userId] ?? '…')}
              size={24}
              speaking={p.micOn}
            />
            <span className="text-xs text-hi">
              {p.userId === me ? 'You' : (names[p.userId] ?? '…')}
            </span>
            <span aria-label={p.micOn ? 'mic on' : 'muted'}>{p.micOn ? '🎙' : '🔇'}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        className="rounded-full bg-black/40 px-2 py-0.5 text-[10px] text-white/80 hover:text-white"
      >
        hide
      </button>
    </div>
  );
}
