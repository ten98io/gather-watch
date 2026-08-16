'use client';

/**
 * CallSurface — the room's ONE call surface.
 *
 * This replaces the old CallStrip (a control dock in the rail) + CallGrid (a
 * floating cluster over the stage), which were two half-surfaces that never
 * agreed on what a call looked like (design-direction §8, UX_OVERHAUL B1/D1).
 *
 * The shape now:
 *   • <CallSessionProvider> owns the call itself — devices, mesh tracks,
 *     presence, remote audio. It is mounted ONCE by the room shell and never
 *     unmounts while you are in the room, so collapsing the rail, opening the
 *     mobile sheet or flipping theater mode can no longer drop you out of a
 *     call (they used to: the dock unmounted, and its cleanup left the call).
 *   • <CallDock> is the rail surface: tiles on top, one compact control bar
 *     under them. When nobody is in the call it collapses to a single slim
 *     "Start a call" row so it costs the rail almost nothing.
 *   • <CallOverlay> is the same session rendered small over the stage, for
 *     theater mode and mobile. It sits top-right — never over the middle of
 *     the picture — and can be hidden and restored, remembered per session.
 *
 * B1, concretely: your own tile ALWAYS renders once you are in the call, even
 * with the camera off (camera stays off by default — D2), carrying the
 * "Turn on camera" action itself. Everyone else in the call gets a tile too,
 * with their avatar, a live-mic ring and a muted indicator, so an audio-only
 * call is a room full of people rather than an empty rectangle.
 *
 * Honesty notes:
 *   • relayMode 'livekit' / 'cf-sfu' still mint a real token and then say, in
 *     plain words, that relayed calls are not enabled — presence is NOT set to
 *     in-call, because other clients render that.
 *   • The speaking ring is measured from the actual audio (WebAudio peak on
 *     the live tracks), never simulated. Where WebAudio is unavailable the
 *     ring simply stays off.
 *   • A peer who is screen-sharing shows their avatar here, not a video tile:
 *     their picture is already on the stage, and the mesh does not tag which
 *     of a peer's video tracks is the camera.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PresenceEntry, RoomId, UserId } from '@gather/contracts';
import { api } from '@/lib/api';
import { getCallMesh, closeCallMesh } from '@/lib/call-mesh';
import type { RemoteTrackEntry } from '@/lib/call-mesh';
import { describeError } from '@/lib/describe-error';
import { RELAY_SHORT_LABEL } from '@/lib/labels';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  UsersIcon,
  VideoIcon,
  VideoOffIcon,
  XIcon,
} from '@/components/ui/icons';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';

export type CallPhase = 'idle' | 'joining' | 'in-call' | 'boundary';

/** One person on the call, as the tiles need them. */
export interface CallParticipant {
  userId: UserId;
  /** Display name; "You" for the local user. */
  name: string;
  avatarUrl: string | null;
  accentColor: string | null;
  isMe: boolean;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  /** Measured from live audio, not from micOn. */
  speaking: boolean;
  /** The camera track to render, when this person is publishing one. */
  videoTrack: MediaStreamTrack | null;
}

export interface CallSessionValue {
  phase: CallPhase;
  micOn: boolean;
  camOn: boolean;
  /** False for relay modes where this build cannot publish a camera. */
  cameraAvailable: boolean;
  /** Plain-words explanation when the relay is not enabled on this server. */
  boundaryDetail: string | null;
  /** Everyone on the call, local user first. */
  participants: CallParticipant[];
  publisherCap: number;
  capReached: boolean;
  /** 'Private' / 'Relayed' — the badge the privacy page promises. */
  relayLabel: string;
  join(): void;
  leave(): void;
  toggleMic(): void;
  toggleCamera(): void;
  dismissBoundary(): void;
}

const CallSessionContext = createContext<CallSessionValue | null>(null);

/** The live call. Must be used under <CallSessionProvider>. */
export function useCallSession(): CallSessionValue {
  const ctx = useContext(CallSessionContext);
  if (ctx === null) throw new Error('useCallSession must be used within <CallSessionProvider>');
  return ctx;
}

const RELAY_NOT_ENABLED =
  'Relayed calls aren’t enabled on this server yet — the room still works with direct calls.';

/* ────────────────────────────────────────────────────────────────────────────
   Voice activity — real measurement, 150 ms poll, no animation loop.
   ──────────────────────────────────────────────────────────────────────────── */

/** Byte-domain peak (0–127) above which we call it speech. */
const SPEAKING_PEAK = 8;
const SPEAKING_POLL_MS = 150;

interface AudioSource {
  userId: UserId;
  track: MediaStreamTrack;
}

function useVoiceActivity(sources: AudioSource[], enabled: boolean): ReadonlySet<UserId> {
  const [speaking, setSpeaking] = useState<UserId[]>([]);
  // Stable dependency: re-measure only when the actual set of tracks changes.
  const key = sources.map((s) => `${s.userId}:${s.track.id}`).join('|');
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  useEffect(() => {
    if (!enabled || key.length === 0) {
      setSpeaking((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const current = sourcesRef.current;
    let ctx: AudioContext | null = null;
    // Inferred rather than annotated: lib.dom's Uint8Array buffer generic has
    // moved between TypeScript releases and getByteTimeDomainData is strict.
    const makeBuffer = (bytes: number) => new Uint8Array(new ArrayBuffer(bytes));
    const nodes: Array<{
      userId: UserId;
      analyser: AnalyserNode;
      node: MediaStreamAudioSourceNode;
      data: ReturnType<typeof makeBuffer>;
    }> = [];
    try {
      const Ctor: typeof AudioContext | undefined =
        typeof window === 'undefined' ? undefined : window.AudioContext;
      if (Ctor === undefined) return;
      ctx = new Ctor();
      void ctx.resume().catch(() => undefined);
      for (const source of current) {
        const node = ctx.createMediaStreamSource(new MediaStream([source.track]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        node.connect(analyser);
        nodes.push({
          userId: source.userId,
          analyser,
          node,
          data: makeBuffer(analyser.fftSize),
        });
      }
    } catch {
      // No WebAudio (or a blocked context): the ring stays off and the call is
      // otherwise untouched. Never break a call over an indicator.
      nodes.length = 0;
    }
    if (nodes.length === 0) {
      void ctx?.close().catch(() => undefined);
      return;
    }

    const timer = setInterval(() => {
      const next: UserId[] = [];
      for (const n of nodes) {
        n.analyser.getByteTimeDomainData(n.data);
        let peak = 0;
        for (let i = 0; i < n.data.length; i += 4) {
          const sample = n.data[i];
          if (sample === undefined) continue;
          const amplitude = Math.abs(sample - 128);
          if (amplitude > peak) peak = amplitude;
        }
        if (peak >= SPEAKING_PEAK) next.push(n.userId);
      }
      setSpeaking((prev) =>
        prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next,
      );
    }, SPEAKING_POLL_MS);

    return () => {
      clearInterval(timer);
      for (const n of nodes) {
        try {
          n.node.disconnect();
          n.analyser.disconnect();
        } catch {
          // Already torn down with the context.
        }
      }
      void ctx?.close().catch(() => undefined);
    };
  }, [key, enabled]);

  return useMemo(() => new Set(speaking), [speaking]);
}

/* ────────────────────────────────────────────────────────────────────────────
   Session provider
   ──────────────────────────────────────────────────────────────────────────── */

/** Hidden sink for one remote audio track. */
function RemoteAudioTrack({ track }: { track: MediaStreamTrack }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.srcObject = new MediaStream([track]);
    void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  return <audio ref={ref} autoPlay className="hidden" />;
}

export function CallSessionProvider({ children }: { children: ReactNode }) {
  const connection = useRoomConnection();
  const { room, member } = useRoom();
  const me = member.userId;
  const roomId = room.id;
  const presence = connection.useRoomState((s) => s.presence);
  const membersVersion = connection.useRoomState((s) => s.membersVersion);

  const [phase, setPhase] = useState<CallPhase>('idle');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [boundaryDetail, setBoundaryDetail] = useState<string | null>(null);
  const [localCam, setLocalCam] = useState<MediaStreamTrack | null>(null);
  const [remoteVideos, setRemoteVideos] = useState<RemoteTrackEntry[]>([]);
  const [remoteAudios, setRemoteAudios] = useState<RemoteTrackEntry[]>([]);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const camTrackRef = useRef<MediaStreamTrack | null>(null);

  const membersQuery = useQuery({
    queryKey: ['members', roomId],
    queryFn: () => api.rooms.listMembers(roomId),
  });
  // Deliberately minimal deps: refetch on the version bump only (the same
  // pattern PeoplePane uses against the same query key).
  const refetchMembers = membersQuery.refetch;
  useEffect(() => {
    if (membersVersion > 0) void refetchMembers();
  }, [membersVersion, refetchMembers]);

  /* Mesh wiring. The mesh replays tracks it already holds to new subscribers,
     so this effect is safe to re-run and never misses a track that landed
     before it mounted (lib/call-mesh.ts). */
  useEffect(() => {
    const mesh = getCallMesh(connection, me);
    mesh.start();
    const offLocal = mesh.onLocalTrack((role, track) => {
      if (role === 'cam') setLocalCam(track);
    });
    const offRemote = mesh.onRemoteTrack((userId, track) => {
      const entry: RemoteTrackEntry = { userId, track };
      const add = (prev: RemoteTrackEntry[]): RemoteTrackEntry[] =>
        prev.some((e) => e.track === track) ? prev : [...prev, entry];
      if (track.kind === 'video') setRemoteVideos(add);
      else setRemoteAudios(add);
    });
    const offRemoved = mesh.onRemoteTrackRemoved((_userId, track) => {
      const drop = (prev: RemoteTrackEntry[]): RemoteTrackEntry[] =>
        prev.some((e) => e.track === track) ? prev.filter((e) => e.track !== track) : prev;
      if (track.kind === 'video') setRemoteVideos(drop);
      else setRemoteAudios(drop);
    });
    return () => {
      offLocal();
      offRemote();
      offRemoved();
    };
  }, [connection, me]);

  /* Leaving the room tears the mesh down; without this the peer connections
     outlive the page and keep sending. */
  useEffect(() => () => closeCallMesh(connection), [connection]);

  /** What presence goes back to when the call ends (kept in a ref so the
   *  unmount cleanup below does not need the room kind in its deps). */
  const idleStateRef = useRef<PresenceEntry['state']>(
    room.kind === 'listen' ? 'listening' : 'watching',
  );
  idleStateRef.current = room.kind === 'listen' ? 'listening' : 'watching';

  const leave = useCallback((): void => {
    const mesh = getCallMesh(connection, me);
    micTrackRef.current?.stop();
    camTrackRef.current?.stop();
    micTrackRef.current = null;
    camTrackRef.current = null;
    mesh.setLocalTrack('mic', null);
    mesh.setLocalTrack('cam', null);
    setLocalCam(null);
    connection.presenceUpdate({ state: idleStateRef.current, micOn: false, camOn: false });
    setPhase('idle');
    setMicOn(true);
    setCamOn(false);
  }, [connection, me]);

  const joinMesh = useCallback(async (): Promise<void> => {
    setPhase('joining');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false, // D2: camera off by default; the tile offers to turn it on.
      });
      const mesh = getCallMesh(connection, me);
      mesh.start();
      const mic = stream.getAudioTracks()[0] ?? null;
      micTrackRef.current = mic;
      mesh.setLocalTrack('mic', mic);
      connection.presenceUpdate({ state: 'in-call', micOn: true, camOn: false });
      setMicOn(true);
      setPhase('in-call');
    } catch (err) {
      setPhase('idle');
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        toast.error('Microphone permission denied — allow it in your browser to join');
      } else {
        toast.error(describeError(err, 'Could not join the call'));
      }
    }
  }, [connection, me]);

  const joinSfu = useCallback(async (): Promise<void> => {
    setPhase('joining');
    try {
      await api.livekit.token({ roomId });
      setBoundaryDetail(RELAY_NOT_ENABLED);
    } catch (err) {
      setBoundaryDetail(describeError(err, RELAY_NOT_ENABLED));
    }
    setPhase('boundary');
  }, [roomId]);

  const join = useCallback((): void => {
    if (room.relayMode === 'mesh') void joinMesh();
    else void joinSfu();
  }, [room.relayMode, joinMesh, joinSfu]);

  const toggleMic = useCallback((): void => {
    const next = !micOn;
    const track = micTrackRef.current;
    if (track !== null) track.enabled = next;
    setMicOn(next);
    connection.presenceUpdate({ micOn: next });
  }, [connection, micOn]);

  const toggleCamera = useCallback((): void => {
    const mesh = getCallMesh(connection, me);
    if (camOn) {
      camTrackRef.current?.stop();
      camTrackRef.current = null;
      mesh.setLocalTrack('cam', null);
      setLocalCam(null);
      setCamOn(false);
      connection.presenceUpdate({ camOn: false });
      return;
    }
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const cam = stream.getVideoTracks()[0] ?? null;
        camTrackRef.current = cam;
        // Publishing here re-offers to every peer already connected, so the
        // people already in the call see the camera — not just later joiners.
        mesh.setLocalTrack('cam', cam);
        setLocalCam(cam);
        setCamOn(true);
        connection.presenceUpdate({ camOn: true });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          toast.error('Camera permission denied — allow camera access in your browser');
        } else {
          toast.error(describeError(err, 'Camera unavailable'));
        }
      }
    })();
  }, [camOn, connection, me]);

  const dismissBoundary = useCallback((): void => {
    setBoundaryDetail(null);
    setPhase('idle');
  }, []);

  /* Unmount = leave (tracks stopped, presence restored). */
  useEffect(
    () => () => {
      if (micTrackRef.current !== null || camTrackRef.current !== null) {
        micTrackRef.current?.stop();
        camTrackRef.current?.stop();
        connection.presenceUpdate({
          state: idleStateRef.current,
          micOn: false,
          camOn: false,
        });
      }
    },
    [connection],
  );

  /* Self-healing presence: a reconnect re-announces the room's default state
     ('watching'/'listening'), which would silently drop us out of the call as
     far as everyone else's tiles are concerned. Re-assert while we are in it. */
  const myPresenceState: PresenceEntry['state'] | undefined = presence[me]?.state;
  useEffect(() => {
    if (phase !== 'in-call' || myPresenceState === 'in-call') return;
    connection.presenceUpdate({ state: 'in-call', micOn, camOn });
  }, [phase, myPresenceState, connection, micOn, camOn]);

  const memberById = useMemo(() => {
    const map = new Map<UserId, { displayName: string; avatarUrl: string | null; accentColor: string }>();
    for (const { user } of membersQuery.data?.members ?? []) {
      map.set(user.id, {
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        accentColor: user.accentColor,
      });
    }
    return map;
  }, [membersQuery.data]);

  /** Newest live camera track per peer. */
  const videoByUser = useMemo(() => {
    const map = new Map<UserId, MediaStreamTrack>();
    for (const { userId, track } of remoteVideos) map.set(userId, track);
    return map;
  }, [remoteVideos]);

  const audioSources = useMemo<AudioSource[]>(() => {
    const list: AudioSource[] = remoteAudios.map(({ userId, track }) => ({ userId, track }));
    const mic = micTrackRef.current;
    if (phase === 'in-call' && mic !== null) list.unshift({ userId: me, track: mic });
    return list;
    // micTrackRef is a ref by design (the track outlives renders); phase and
    // micOn are what actually change whether it should be measured.
  }, [remoteAudios, phase, me]);
  const speakingIds = useVoiceActivity(audioSources, phase === 'in-call');

  const participants = useMemo<CallParticipant[]>(() => {
    const list: CallParticipant[] = [];
    if (phase === 'in-call') {
      list.push({
        userId: me,
        name: 'You',
        avatarUrl: memberById.get(me)?.avatarUrl ?? null,
        accentColor: memberById.get(me)?.accentColor ?? null,
        isMe: true,
        micOn,
        camOn,
        sharing: presence[me]?.sharing === true,
        speaking: micOn && speakingIds.has(me),
        videoTrack: camOn ? localCam : null,
      });
    }
    for (const entry of Object.values(presence)) {
      if (entry.state !== 'in-call' || entry.userId === me) continue;
      const info = memberById.get(entry.userId);
      list.push({
        userId: entry.userId,
        name: info?.displayName ?? 'Someone',
        avatarUrl: info?.avatarUrl ?? null,
        accentColor: info?.accentColor ?? null,
        isMe: false,
        micOn: entry.micOn,
        camOn: entry.camOn,
        sharing: entry.sharing,
        speaking: entry.micOn && speakingIds.has(entry.userId),
        // A sharing peer's video is already on the stage, and the mesh cannot
        // tell their camera track from their screen track — show the avatar.
        videoTrack:
          entry.camOn && !entry.sharing ? (videoByUser.get(entry.userId) ?? null) : null,
      });
    }
    return list;
  }, [phase, me, micOn, camOn, localCam, presence, memberById, speakingIds, videoByUser]);

  const publisherCap = room.policies.maxPublishers;
  const inCallCount = useMemo(
    () => Object.values(presence).filter((p) => p.state === 'in-call').length,
    [presence],
  );

  const value = useMemo<CallSessionValue>(
    () => ({
      phase,
      micOn,
      camOn,
      cameraAvailable: room.relayMode === 'mesh',
      boundaryDetail,
      participants,
      publisherCap,
      capReached: inCallCount >= publisherCap && phase !== 'in-call',
      relayLabel: RELAY_SHORT_LABEL[room.relayMode],
      join,
      leave,
      toggleMic,
      toggleCamera,
      dismissBoundary,
    }),
    [
      phase,
      micOn,
      camOn,
      room.relayMode,
      boundaryDetail,
      participants,
      publisherCap,
      inCallCount,
      join,
      leave,
      toggleMic,
      toggleCamera,
      dismissBoundary,
    ],
  );

  return (
    <CallSessionContext.Provider value={value}>
      {children}
      {phase === 'in-call' &&
        remoteAudios.map((entry) => <RemoteAudioTrack key={entry.track.id} track={entry.track} />)}
    </CallSessionContext.Provider>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Tiles
   ──────────────────────────────────────────────────────────────────────────── */

function TrackVideo({ track, mirror }: { track: MediaStreamTrack; mirror: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.srcObject = new MediaStream([track]);
    void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      // Never echo my own microphone back at me through my own tile.
      muted={mirror}
      className={cn('h-full w-full object-cover', mirror && '-scale-x-100')}
    />
  );
}

function CallTile({
  participant,
  compact = false,
  onTurnOnCamera,
}: {
  participant: CallParticipant;
  compact?: boolean;
  onTurnOnCamera?: (() => void) | undefined;
}) {
  const { name, micOn, camOn, sharing, speaking, videoTrack, isMe } = participant;
  const status = camOn ? (micOn ? 'mic on' : 'muted') : micOn ? 'camera off' : 'camera off, muted';
  return (
    <figure
      className={cn(
        'relative flex aspect-video items-center justify-center overflow-hidden rounded-card bg-surface-2',
        speaking && 'ring-2 ring-accent',
      )}
      aria-label={`${name} — ${status}`}
    >
      {videoTrack !== null ? (
        <TrackVideo track={videoTrack} mirror={isMe} />
      ) : (
        <Avatar
          name={name}
          src={participant.avatarUrl}
          accentColor={participant.accentColor}
          size={compact ? 32 : 44}
        />
      )}

      {isMe && !camOn && onTurnOnCamera !== undefined && !compact && (
        <div className="absolute inset-x-0 bottom-0 flex justify-center pb-2">
          <Button size="sm" onClick={onTurnOnCamera} aria-label="Turn on camera">
            <VideoIcon size={16} aria-hidden />
            Turn on camera
          </Button>
        </div>
      )}

      {/* Compact tiles carry the mic state only — the name lives in the
          figure's accessible label and its tooltip, because a 13px name in an
          80px tile is unreadable and the type ramp has nothing smaller that
          isn't uppercase. */}
      <figcaption
        className="pointer-events-none absolute left-1 top-1 flex max-w-[calc(100%-0.5rem)] items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-label text-white"
        title={name}
      >
        {micOn ? (
          <MicIcon size={12} aria-hidden />
        ) : (
          <MicOffIcon size={12} aria-hidden className="text-danger" />
        )}
        {!compact && <span className="truncate">{name}</span>}
      </figcaption>

      {sharing && !compact && (
        <span className="pointer-events-none absolute right-1 top-1 rounded-full bg-black/55 px-2 py-0.5 text-caption text-white">
          Sharing
        </span>
      )}
    </figure>
  );
}

function TileGrid({
  participants,
  compact = false,
  onTurnOnCamera,
}: {
  participants: CallParticipant[];
  compact?: boolean;
  onTurnOnCamera?: (() => void) | undefined;
}) {
  return (
    <ul
      role="list"
      className={cn(
        'grid list-none gap-2',
        participants.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
      )}
    >
      {participants.map((p) => (
        <li key={p.userId}>
          <CallTile participant={p} compact={compact} onTurnOnCamera={onTurnOnCamera} />
        </li>
      ))}
    </ul>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Controls
   ──────────────────────────────────────────────────────────────────────────── */

function ControlBar({ compact = false }: { compact?: boolean }) {
  const call = useCallSession();
  const size = compact ? 14 : 16;
  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant={call.micOn ? 'secondary' : 'ghost'}
        size="sm"
        aria-label={call.micOn ? 'Mute microphone' : 'Unmute microphone'}
        aria-pressed={!call.micOn}
        onClick={call.toggleMic}
      >
        {call.micOn ? <MicIcon size={size} aria-hidden /> : <MicOffIcon size={size} aria-hidden />}
      </Button>
      {call.cameraAvailable && (
        <Button
          variant={call.camOn ? 'secondary' : 'ghost'}
          size="sm"
          aria-label={call.camOn ? 'Turn camera off' : 'Turn camera on'}
          aria-pressed={call.camOn}
          onClick={call.toggleCamera}
        >
          {call.camOn ? (
            <VideoIcon size={size} aria-hidden />
          ) : (
            <VideoOffIcon size={size} aria-hidden />
          )}
        </Button>
      )}
      <Button variant="ghost" size="sm" aria-label="Leave the call" onClick={call.leave}>
        {/* The colour rides the icon, not the button: two competing text-*
            utilities on one element resolve by stylesheet order, not by the
            order they are written in. */}
        <PhoneOffIcon size={size} aria-hidden className="text-danger" />
        {!compact && 'Leave'}
      </Button>
    </div>
  );
}

/** Join affordance shared by the slim row and the "others are already in" bar. */
function JoinButton({ label = 'Join call' }: { label?: string }) {
  const call = useCallSession();
  if (call.phase === 'joining') {
    return (
      <span className="text-label text-low" role="status">
        Joining…
      </span>
    );
  }
  return (
    <Button
      size="sm"
      disabled={call.capReached}
      aria-label={
        call.capReached
          ? `Call full — only ${call.publisherCap} people can be on camera or mic at once`
          : label
      }
      onClick={call.join}
    >
      {call.capReached ? 'Call full' : label}
    </Button>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Rail surface
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The call surface at the top of the right rail. Slim single row when the room
 * is not calling; tiles + one control bar once anyone is.
 */
export function CallDock({ roomId, className }: { roomId: RoomId; className?: string }) {
  const call = useCallSession();
  const { participants, phase } = call;
  const empty = participants.length === 0;

  if (phase === 'boundary') {
    return (
      <section aria-label="Call" data-room={roomId} className={cn('p-3', className)}>
        <EmptyState
          icon={<UsersIcon size={20} aria-hidden />}
          title="Calls are direct in this room"
          {...(call.boundaryDetail === null ? {} : { description: call.boundaryDetail })}
          action={
            <Button variant="secondary" size="sm" onClick={call.dismissBoundary}>
              Got it
            </Button>
          }
        />
      </section>
    );
  }

  if (empty) {
    // One slim row — the call costs the rail nothing until someone calls.
    return (
      <section aria-label="Call" data-room={roomId} className={cn('p-2', className)}>
        <button
          type="button"
          onClick={call.join}
          disabled={call.capReached || phase === 'joining'}
          aria-label="Start a call"
          className="flex min-h-tap w-full items-center gap-3 rounded-ctl px-2 text-left transition-colors duration-150 hover:bg-surface-2 disabled:opacity-50"
        >
          <VideoIcon size={20} aria-hidden className="shrink-0 text-low" />
          <span className="min-w-0 flex-1 truncate text-label text-hi">
            {phase === 'joining' ? 'Joining…' : 'Start a call'}
          </span>
          <span className="shrink-0 text-caption text-low">{call.relayLabel}</span>
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label="Call"
      data-room={roomId}
      className={cn('flex flex-col gap-2 p-3', className)}
    >
      <TileGrid
        participants={participants}
        onTurnOnCamera={call.cameraAvailable ? call.toggleCamera : undefined}
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-caption text-low">
          {participants.length} in call · {call.relayLabel}
        </span>
        {phase === 'in-call' ? <ControlBar /> : <JoinButton />}
      </div>
      {call.capReached && phase !== 'in-call' && (
        <p className="text-label text-low">
          Up to {call.publisherCap} people can be on camera or mic in one room.
        </p>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Floating surface (theater mode, and mobile with the sheet closed)
   ──────────────────────────────────────────────────────────────────────────── */

const HIDDEN_KEY_PREFIX = 'gather.call.tiles-hidden.';

/** Remembers the hide/show choice for this browser session, per room. */
function useHiddenForSession(roomId: RoomId): [boolean, (next: boolean) => void] {
  const [hidden, setHidden] = useState(false);
  const key = `${HIDDEN_KEY_PREFIX}${roomId}`;
  useEffect(() => {
    try {
      setHidden(window.sessionStorage.getItem(key) === '1');
    } catch {
      // Storage blocked (private mode / embedded): default to visible.
    }
  }, [key]);
  const set = useCallback(
    (next: boolean) => {
      setHidden(next);
      try {
        window.sessionStorage.setItem(key, next ? '1' : '0');
      } catch {
        // Non-persistent is fine; the choice still holds for this mount.
      }
    },
    [key],
  );
  return [hidden, set];
}

const OVERLAY_TILE_LIMIT = 4;

/**
 * Left edge, under the connection pill. The stage's own chrome already owns
 * the top-right corner (relay badge, share-screen entry) and the bottom strip
 * (transport bar), and the centre belongs to the picture.
 */
const OVERLAY_ANCHOR = 'absolute left-4 top-16 z-30';

/**
 * Theater mode collapses the rail, so the tiles float instead — hugging the
 * left edge so the middle of the picture is never covered, and dismissible
 * (remembered for the session).
 */
export function CallOverlay({ roomId, className }: { roomId: RoomId; className?: string }) {
  const call = useCallSession();
  const [hidden, setHidden] = useHiddenForSession(roomId);
  const { participants } = call;

  if (participants.length === 0) return null;

  if (hidden) {
    return (
      <div className={cn(OVERLAY_ANCHOR, className)}>
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Show call tiles — ${participants.length} in call`}
          onClick={() => setHidden(false)}
        >
          <UsersIcon size={16} aria-hidden />
          {participants.length}
        </Button>
      </div>
    );
  }

  const shown = participants.slice(0, OVERLAY_TILE_LIMIT);
  const overflow = participants.length - shown.length;

  return (
    <aside
      aria-label="Call"
      className={cn(
        // Glass is sanctioned here: this is one of the surfaces that genuinely
        // floats over moving video (design-direction §1).
        'glass-raised flex w-44 flex-col gap-2 rounded-card p-2 animate-fade-in',
        OVERLAY_ANCHOR,
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-caption text-low">
          {participants.length} in call
        </span>
        <button
          type="button"
          aria-label="Hide call tiles"
          onClick={() => setHidden(true)}
          className="rounded-ctl p-1 text-low transition-colors duration-150 hover:text-hi"
        >
          <XIcon size={14} aria-hidden />
        </button>
      </div>
      {/* No on-tile camera button here: the compact control bar below already
          owns mic/camera/leave, and two camera affordances in a 176px overlay
          would be one too many. */}
      <TileGrid participants={shown} compact />
      {overflow > 0 && <p className="text-label text-low">+{overflow} more in the call</p>}
      {call.phase === 'in-call' ? <ControlBar compact /> : <JoinButton />}
    </aside>
  );
}
