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
 *   • <CallDock> is the rail surface: orbs (or tiles, once a camera is on) with
 *     one compact control bar under them. When nobody is in the call it is an
 *     invitation instead — a `title` line, one sentence, and the region's only
 *     aurora action — because starting a call is the primary social act of the
 *     product and it used to be a 13px text button ranked under an invite chip.
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
 *   • Every call is a mesh, and the badge names the route the media is TAKING
 *     rather than the one the architecture prefers — direct, relayed, or not
 *     yet known. It read "Private · device-to-device" unconditionally, which
 *     is the one claim a privacy promise cannot afford to guess at.
 *   • A link that never comes up is named as such, once the mesh's own ICE
 *     recovery budget has run out, and the room says whether the reason was a
 *     deployment with no relay to fall back on. "Reconnecting…" forever is
 *     indistinguishable from a slow network and gives nobody a next step.
 *   • The speaking ring is measured from the actual audio (WebAudio peak on
 *     the live tracks), never simulated. Where WebAudio is unavailable the
 *     ring simply stays off.
 *   • A peer who is screen-sharing shows their avatar here, not a video tile:
 *     their picture is already on the stage, and the mesh does not tag which
 *     of a peer's video tracks is the camera.
 *   • A tile means "this person's media is reaching this room", not "the
 *     server said so a moment ago" — see callPeerIds below.
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
import type { MeshConnectionState, MeshLinkState } from '@gather/p2p';
import { voiceActiveFrom } from '@gather/sync-core';
import { api } from '@/lib/api';
import { publishSpeechActive, publishVoiceActive } from '@/lib/player/room-audio';
import {
  getCallMesh,
  closeCallMesh,
  isAudioSinkClaimed,
  onAudioSinkClaims,
  setCallIntent,
} from '@/lib/call-mesh';
import type { RelayAvailability, RemoteTrackEntry } from '@/lib/call-mesh';
import { describeError } from '@/lib/describe-error';
import { presenceIdleStateFor } from '@/lib/media-kind';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  MicIcon,
  MicOffIcon,
  MonitorIcon,
  PhoneOffIcon,
  UsersIcon,
  VideoIcon,
  VideoOffIcon,
  XIcon,
} from '@/components/ui/icons';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';

export type CallPhase = 'idle' | 'joining' | 'in-call';

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
  /** Where their link stands, in the only four states that are true. */
  linkStatus: LinkStatus;
}

export interface CallSessionValue {
  phase: CallPhase;
  micOn: boolean;
  camOn: boolean;
  /**
   * A local device ENDED on its own — unplugged, seized by another app, walked
   * out of bluetooth range. Distinct from `micOn`/`camOn`, which are the
   * user's own latches: this one says the hardware is gone, and it is what the
   * surface has to say out loud.
   */
  micLost: boolean;
  camLost: boolean;
  /** Whether this build can publish a camera at all. */
  cameraAvailable: boolean;
  /** Everyone on the call, local user first. */
  participants: CallParticipant[];
  publisherCap: number;
  capReached: boolean;
  /** Where this call's media is actually going, folded over its live links. */
  mediaPath: CallPath;
  /** The badge the privacy page promises, and now the truth: {@link CALL_PATH_LABEL}. */
  relayLabel: string;
  /** One sentence when somebody in this call cannot be reached, else null. */
  connectivityNote: string | null;
  join(): void;
  leave(): void;
  toggleMic(): void;
  toggleCamera(): void;
  /** Ask for a microphone again and republish it, mute latch intact. */
  recoverMic(): void;
}

/**
 * One sentence for a local device that vanished, or null while both are fine.
 *
 * Pure, and exported, because this is the only place the app admits the
 * failure in words — the icons cannot, since the whole defect is that a dead
 * track still looks exactly like a live one.
 */
export function deviceLossNote(input: { micLost: boolean; camLost: boolean }): string | null {
  if (input.micLost && input.camLost) {
    return 'Your microphone and camera disconnected — nobody can hear or see you.';
  }
  if (input.micLost) return 'Your microphone disconnected — nobody can hear you.';
  if (input.camLost) return 'Your camera disconnected — your video stopped.';
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
   Link honesty — what a tile, a badge and a sentence are allowed to claim

   The room already knew all of this and never said any of it. A peer whose
   link never came up showed "Reconnecting…" for as long as the tab stayed
   open, which is indistinguishable from a slow network and gives nobody a next
   step; the badge said "Private · device-to-device" whether the media was
   going device to device or through a rented relay; and a deployment with no
   relay at all — the one configuration that makes 5–25% of real network pairs
   fail outright — was invisible from the product.
   ──────────────────────────────────────────────────────────────────────────── */

/** Where one person's link stands. Four states, and none of them is a guess. */
export type LinkStatus = 'ok' | 'connecting' | 'reconnecting' | 'unreachable';

/**
 * One person's link status.
 *
 * `everConnected` is what separates the two middle states, and the distinction
 * is not pedantry: "Reconnecting…" told the owner's two testers that something
 * they'd had was coming back, when in fact nothing had ever been established
 * between them. A link that has never carried a packet is CONNECTING.
 *
 * 'unreachable' is the mesh's own verdict (CallMesh.onUnreachablePeer), not a
 * deadline invented here — the ICE recovery budget is what ends, and a second
 * timer racing it could only ever contradict it.
 */
export function linkStatusFor(input: {
  connection: MeshConnectionState | undefined;
  everConnected: boolean;
  unreachable: boolean;
}): LinkStatus {
  if (input.unreachable) return 'unreachable';
  const state = input.connection;
  if (state === undefined) return 'ok';
  if (TROUBLED_LINK.has(state)) return input.everConnected ? 'reconnecting' : 'connecting';
  // 'new' is the instant between constructing a peer connection and offering
  // on it; labelling that would put "Connecting…" under every tile that has
  // just appeared, including ones that connect immediately.
  if (state === 'connecting') return 'connecting';
  return 'ok';
}

/** What a tile says about a link that is not simply working. */
export const LINK_STATUS_LABEL: Record<Exclude<LinkStatus, 'ok'>, string> = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  unreachable: 'Can’t connect',
};

/**
 * Where the call's media is going, folded over every link in it.
 *
 * A call is only private if EVERY link is direct — one relayed link means a
 * server is carrying part of this conversation, and the badge that says
 * otherwise is the one lie a privacy promise cannot survive.
 */
export type CallPath =
  | 'alone'
  | 'connecting'
  | 'direct'
  | 'relayed'
  | 'mixed'
  | 'unknown'
  | 'none';

/**
 * Fold the live links into the one thing the badge may claim.
 *
 * The order of the tests is the honesty: relay beats everything (it is the
 * fact that costs a privacy claim), an unclassified but CONNECTED link beats
 * 'direct' (classifyLinkStats refuses to guess, and so must this), 'connecting'
 * is only for links genuinely still trying, and a call whose every link has
 * been given up on is carrying nothing at all — which is neither private nor
 * connecting, and used to read as the latter.
 */
export function callPathFrom(
  links: ReadonlyArray<{
    connection: MeshConnectionState | undefined;
    path: MeshLinkState;
    /** The mesh has stopped trying this link (CallMesh.onUnreachablePeer). */
    lost: boolean;
  }>,
): CallPath {
  if (links.length === 0) return 'alone';
  let direct = 0;
  let relayed = 0;
  let unclassified = 0;
  let pending = 0;
  let lost = 0;
  for (const link of links) {
    if (link.lost) lost += 1;
    else if (link.path === 'relayed') relayed += 1;
    else if (link.path === 'direct') direct += 1;
    else if (link.connection === 'connected') unclassified += 1;
    else pending += 1;
  }
  if (relayed > 0) return direct > 0 ? 'mixed' : 'relayed';
  if (unclassified > 0) return 'unknown';
  if (pending > 0) return 'connecting';
  if (lost === links.length) return 'none';
  return 'direct';
}

/**
 * The badge, per path.
 *
 * 'relayed' names the relay AND keeps the encryption promise in the same
 * breath, because the two are separate facts and dropping the second turns an
 * honest disclosure into a scare: a relay forwards packets it cannot read.
 * 'unknown' claims nothing at all — the link is up and this browser would not
 * say by which route.
 */
export const CALL_PATH_LABEL: Record<CallPath, string> = {
  alone: 'Device-to-device',
  connecting: 'Connecting…',
  direct: 'Private · direct',
  relayed: 'Relayed · encrypted',
  mixed: 'Partly relayed',
  unknown: 'Connected',
  none: 'Not connected',
};

/** Name the people a sentence is about, without ever growing past a line. */
function nameList(names: readonly string[]): string {
  const [first, second] = names;
  if (first === undefined) return '';
  if (names.length === 1) return first;
  if (names.length === 2 && second !== undefined) return `${first} and ${second}`;
  return `${first} and ${String(names.length - 1)} others`;
}

/**
 * The sentence the owner's production test never got.
 *
 * Two people joined, both tiles rendered, the room said "2 IN CALL", and
 * neither could see or hear the other — with nothing on screen to say why. The
 * cause was a deployment with no relay configured, which the client knew from
 * its first credential fetch and never mentioned.
 *
 * Written for a person: no ICE, no NAT, no TURN. Precise enough to act on —
 * "a different network" is the move that actually works, and it is the only
 * one, because a reload rebuilds the same impossible link.
 *
 * It names WHO when only some links died, and stays whole-call only when every
 * other person is unreachable: the mesh is per-link, and one person on a
 * hostile network must not make a working call look broken.
 */
export function connectivityNote(input: {
  /** Display names of the people who cannot be reached. */
  names: readonly string[];
  /** How many other people are in the call altogether. */
  others: number;
  relay: RelayAvailability;
}): string | null {
  if (input.names.length === 0) return null;
  const everyone = input.others > 1 && input.names.length >= input.others;
  const subject = everyone ? 'anyone else' : nameList(input.names);
  if (input.relay === 'absent') {
    return (
      `Can’t connect to ${subject} — your networks can’t reach each other directly, and ` +
      'this room has no relay to pass the call through. Trying a different network, or a ' +
      'phone hotspot, usually gets around it.'
    );
  }
  return `Can’t connect to ${subject} — the connection never came up. Reloading the page usually fixes it.`;
}

const CallSessionContext = createContext<CallSessionValue | null>(null);

/** The live call. Must be used under <CallSessionProvider>. */
export function useCallSession(): CallSessionValue {
  const ctx = useContext(CallSessionContext);
  if (ctx === null) throw new Error('useCallSession must be used within <CallSessionProvider>');
  return ctx;
}

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
    // The graph MUST reach a destination. A remote WebRTC track routed into
    // Web Audio has its rendering taken over by the graph in Chromium, so a
    // chain that dead-ends at an AnalyserNode swallows the audio and the
    // <audio> element attached to the same track goes silent — inaudible
    // remote voice caused by the indicator that was only supposed to draw a
    // ring around it. Video never touches this code, which is why a call could
    // look perfect and sound like nothing. The sink is muted (gain 0) so the
    // path exists without ever making sound of its own.
    let sink: GainNode | null = null;
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
      sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);
      for (const source of current) {
        const node = ctx.createMediaStreamSource(new MediaStream([source.track]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        node.connect(analyser);
        analyser.connect(sink);
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
      try {
        sink?.disconnect();
      } catch {
        // Already torn down with the context.
      }
      void ctx?.close().catch(() => undefined);
    };
  }, [key, enabled]);

  return useMemo(() => new Set(speaking), [speaking]);
}

/**
 * May the content step back right now? (E18 — see lib/player/ducking.ts for
 * the envelope this boolean feeds, and lib/player/room-audio.ts for why this
 * signal is not the one the sync band reads.)
 *
 * Two exclusions, both of them the difference between help and harm:
 *
 *  • MY OWN MICROPHONE NEVER DUCKS MY OWN CONTENT. Echo cancellation is
 *    referenced against what the browser renders, not against arbitrary page
 *    audio, so a loud film leaks into my own mic on plenty of machines. Duck
 *    on that and it is a loop: film leaks in → level drops → leak stops →
 *    level climbs → leak returns. The film would breathe on its own with
 *    nobody saying a word. Ducking exists so I can hear THEM; the sound I
 *    make, I am already inside of.
 *  • NOT WHILE THIS BROWSER IS REFUSING TO PLAY THE CALL. The speaking ring is
 *    measured off the raw tracks by an AnalyserNode, which keeps working
 *    perfectly while autoplay policy is refusing the <audio> sinks
 *    (CALL_SOUND_BLOCKED_LABEL). Ducking on that reading would take the film
 *    away from someone to make room for voices they cannot hear at all —
 *    silence in both directions.
 */
export function shouldDuckContent(input: {
  participants: readonly CallParticipant[];
  soundBlocked: boolean;
}): boolean {
  if (input.soundBlocked) return false;
  return input.participants.some((p) => !p.isMe && p.speaking);
}

/* ────────────────────────────────────────────────────────────────────────────
   Who is in the call
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * How long a peer keeps their tile on the strength of their MEDIA alone, once
 * presence has stopped calling them 'in-call'.
 *
 * Long enough to cover a presence blip — a client re-announcing 'watching' or
 * 'listening' for its own reasons overwrites its call state for about one
 * round trip, and every other client used to drop that person's tile for the
 * duration. Short enough that someone who genuinely left cannot linger: their
 * tracks may end no faster than the next renegotiation, and a roster that
 * shows people who left is a different lie from the one being fixed.
 */
export const PRESENCE_BRIDGE_MS = 6_000;

/** How often we re-tell the server we are in the call while it disagrees. */
export const PRESENCE_REASSERT_MS = 2_000;

/** Link states where a tile must admit something is wrong. */
const TROUBLED_LINK: ReadonlySet<MeshConnectionState> = new Set<MeshConnectionState>([
  'disconnected',
  'failed',
]);

export interface CallRosterInput {
  me: UserId;
  presence: Record<UserId, PresenceEntry>;
  /** Peers whose media is arriving right now (retained by the mesh). */
  trackPeers: ReadonlySet<UserId>;
  /** Peers presence has called 'in-call' at any point in this session. */
  everInCall: ReadonlySet<UserId>;
  /**
   * When presence STOPPED calling each of them in — the moment the bridge
   * starts running from. Absent means it has only just happened (the bookkeeping
   * lands one tick later), which is precisely when a blip needs bridging most.
   */
  leftCallAt: ReadonlyMap<UserId, number>;
  now: number;
}

/**
 * Everyone except me who is in the call, from the two signals that exist.
 *
 * Presence is the DECLARATION and arrives over a round trip; a track arriving
 * is the EVIDENCE and cannot be faked — a peer only publishes a microphone
 * because they joined. Requiring both would make the roster a function of the
 * server's echo (the bug: one stale presence write blanks a working call);
 * accepting media alone would let a screen-share, which rides the same mesh
 * without joining anything, masquerade as a caller. So: presence says who is
 * in, and live media keeps someone in for a few seconds after presence stops
 * saying it — never longer, and never for someone presence never let in.
 */
export function callPeerIds(input: CallRosterInput): UserId[] {
  const { me, presence, trackPeers, everInCall, leftCallAt, now } = input;
  const ids: UserId[] = [];
  const seen = new Set<UserId>();
  const consider = (userId: UserId): void => {
    if (userId === me || seen.has(userId)) return;
    seen.add(userId);
    if (presence[userId]?.state === 'in-call') {
      ids.push(userId);
      return;
    }
    // Media alone is not membership: a screen-share rides the same mesh.
    if (!trackPeers.has(userId) || !everInCall.has(userId)) return;
    const at = leftCallAt.get(userId);
    if (at === undefined || now - at <= PRESENCE_BRIDGE_MS) ids.push(userId);
  };
  for (const entry of Object.values(presence)) consider(entry.userId);
  // A peer whose presence row expired while their media keeps arriving is
  // still in the call; presence is what went missing, not the person.
  for (const userId of trackPeers) consider(userId);
  return ids;
}

/* ────────────────────────────────────────────────────────────────────────────
   Session provider
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Autoplay policy refused the hidden <audio>. Swallowing that rejection —
 * `void el.play().catch(() => undefined)` — is a call where you hear NOBODY,
 * permanently, with no prompt and nothing to click: total silent failure of
 * the headline feature. One tap is all the policy wants.
 */
export const CALL_SOUND_BLOCKED_LABEL = 'Tap to enable sound';

/** Hidden sink for one remote audio track. */
function RemoteAudioTrack({
  track,
  resumeNonce,
  onPlayResult,
}: {
  track: MediaStreamTrack;
  /** Bumped by the affordance below; re-runs play() inside the user gesture. */
  resumeNonce: number;
  onPlayResult: (track: MediaStreamTrack, blocked: boolean) => void;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.srcObject = new MediaStream([track]);
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    let live = true;
    void el.play().then(
      () => {
        if (live) onPlayResult(track, false);
      },
      () => {
        // Muting an <audio> would only trade one silence for another, so this
        // one has to be reported and answered with a control.
        if (live) onPlayResult(track, true);
      },
    );
    return () => {
      live = false;
    };
  }, [track, resumeNonce, onPlayResult]);
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
  /** A local device ended by itself — see the handlers below. */
  const [micLost, setMicLost] = useState(false);
  const [camLost, setCamLost] = useState(false);
  const [localCam, setLocalCam] = useState<MediaStreamTrack | null>(null);
  const [remoteVideos, setRemoteVideos] = useState<RemoteTrackEntry[]>([]);
  const [remoteAudios, setRemoteAudios] = useState<RemoteTrackEntry[]>([]);
  const [connStates, setConnStates] = useState<ReadonlyMap<UserId, MeshConnectionState>>(
    () => new Map(),
  );
  /** Where each peer's media actually travels, once a stats poll classifies it. */
  const [linkPaths, setLinkPaths] = useState<ReadonlyMap<UserId, MeshLinkState>>(() => new Map());
  /** Peers the mesh has stopped trying to reach. */
  const [unreachable, setUnreachable] = useState<ReadonlySet<UserId>>(() => new Set());
  /** Whether this deployment has a relay at all — known before anyone dials. */
  const [relay, setRelay] = useState<RelayAvailability>('unknown');
  /**
   * Peers whose link has been up at least once this session.
   *
   * A ref, and correct as one: it only grows, and it is consulted about a link
   * that is down NOW, which is a later render than the one that recorded the
   * connection. It is what separates "Reconnecting…" from "Connecting…".
   */
  const everConnectedRef = useRef(new Set<UserId>());
  /** Track ids whose sink autoplay refused; non-empty means offer the tap. */
  const [soundBlocked, setSoundBlocked] = useState<ReadonlySet<string>>(() => new Set());
  const [resumeNonce, setResumeNonce] = useState(0);
  /** Bumped whenever some other surface claims or releases an audio sink. */
  const [claimTick, setClaimTick] = useState(0);
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
    const offLink = mesh.onConnectionState((userId, state) => {
      if (state === 'connected') everConnectedRef.current.add(userId);
      setConnStates((prev) => {
        if (prev.get(userId) === state) return prev;
        const next = new Map(prev);
        next.set(userId, state);
        return next;
      });
    });
    // Three signals the mesh has always had and the room never showed: which
    // route each link takes, which links it has given up on, and whether there
    // was ever a relay to fall back on.
    const offPath = mesh.onLinkState((userId, state) => {
      setLinkPaths((prev) => {
        if (prev.get(userId) === state) return prev;
        const next = new Map(prev);
        next.set(userId, state);
        return next;
      });
    });
    const offUnreachable = mesh.onUnreachablePeer((userId, lost) => {
      setUnreachable((prev) => {
        if (prev.has(userId) === lost) return prev;
        const next = new Set(prev);
        if (lost) next.add(userId);
        else next.delete(userId);
        return next;
      });
    });
    const offRelay = mesh.onRelayAvailability(setRelay);
    // The empty onError this used to pass is the whole of "it just doesn't
    // work and I have no idea why". The mesh sends one plain sentence per
    // kind of failure, and only once media is actually at stake.
    const offError = mesh.onError((note) => {
      toast.error(note);
    });
    return () => {
      offLocal();
      offRemote();
      offRemoved();
      offLink();
      offPath();
      offUnreachable();
      offRelay();
      offError();
    };
  }, [connection, me]);

  /* Leaving the room tears the mesh down; without this the peer connections
     outlive the page and keep sending. */
  useEffect(() => () => closeCallMesh(connection), [connection]);

  /* Another surface may already be playing one of these tracks — the share
     viewer plays the sharing host's sound with or without the call. Two
     elements on one track is a flanged double, so the call sink stands down
     for anything claimed (lib/call-mesh.ts). */
  useEffect(
    () =>
      onAudioSinkClaims(() => {
        setClaimTick((n) => n + 1);
      }),
    [],
  );
  /* claimTick is the clock: the claim registry lives outside React. */
  const unclaimedAudios = useMemo(
    () => remoteAudios.filter((entry) => !isAudioSinkClaimed(entry.track)),
    [remoteAudios, claimTick],
  );

  /* Read through the LIVE sinks rather than trusting the id set: a sink that
     unmounts while blocked never reports again, and an affordance left over
     from a track nobody is playing is a button that fixes nothing. */
  const soundIsBlocked = useMemo(
    () => unclaimedAudios.some((entry) => soundBlocked.has(entry.track.id)),
    [unclaimedAudios, soundBlocked],
  );

  const notePlayResult = useCallback((track: MediaStreamTrack, blocked: boolean): void => {
    setSoundBlocked((prev) => {
      if (prev.has(track.id) === blocked) return prev;
      const next = new Set(prev);
      if (blocked) next.add(track.id);
      else next.delete(track.id);
      return next;
    });
  }, []);

  /** What presence goes back to when the call ends: read off what is playing
   *  AT THAT MOMENT (music → 'listening'), not off any room-level mode. Read
   *  from the store directly so leave/unmount need no playback re-renders. */
  const idleState = useCallback(
    (): PresenceEntry['state'] =>
      presenceIdleStateFor(connection.useRoomState.getState().playback?.mediaRef ?? null),
    [connection],
  );

  /* ── local devices that vanish ─────────────────────────────────────────────
     A device disappearing does exactly ONE thing: it fires 'ended' on its
     track. No error, no permission change, nothing on the mesh — and the track
     object stays put with `enabled` still true, so every control keyed on our
     own `micOn` flag goes on drawing a live microphone while not one sample
     leaves the machine. Unplug a headset mid-sentence and you are muted for
     the rest of the call, looking at a mic-on icon. It is the swallowed play()
     rejection again in a different costume: someone who cannot tell they are
     broken.

     Both handlers begin with an identity guard. `stop()` is not specified to
     fire 'ended' and usually does not, but browsers differ — and a camera the
     USER turned off must never be reported as a fault, so a handler whose
     track is no longer the one we publish simply stands down. */
  const handleMicEnded = useCallback(
    (track: MediaStreamTrack): void => {
      if (micTrackRef.current !== track) return;
      micTrackRef.current = null;
      // A dead track left published is a sender the mesh keeps renegotiating
      // for and nobody can hear.
      getCallMesh(connection, me).setLocalTrack('mic', null);
      setMicLost(true);
      // Presence has to carry it too, or every other screen in the room keeps
      // a live mic drawn on a tile that has been silent for ten minutes.
      connection.presenceUpdate({ micOn: false });
      toast.error('Your microphone disconnected — nobody can hear you');
    },
    [connection, me],
  );

  const handleCamEnded = useCallback(
    (track: MediaStreamTrack): void => {
      if (camTrackRef.current !== track) return;
      camTrackRef.current = null;
      getCallMesh(connection, me).setLocalTrack('cam', null);
      setLocalCam(null);
      setCamOn(false);
      setCamLost(true);
      connection.presenceUpdate({ camOn: false });
      toast.error('Your camera disconnected — turn it back on when it is ready');
    },
    [connection, me],
  );

  const leave = useCallback((): void => {
    const mesh = getCallMesh(connection, me);
    micTrackRef.current?.stop();
    camTrackRef.current?.stop();
    micTrackRef.current = null;
    camTrackRef.current = null;
    mesh.setLocalTrack('mic', null);
    mesh.setLocalTrack('cam', null);
    setLocalCam(null);
    setMicLost(false);
    setCamLost(false);
    // Drop the intent BEFORE announcing: anything that re-announces presence
    // on our behalf must not re-assert a call we are leaving.
    setCallIntent(connection, false);
    connection.presenceUpdate({ state: idleState(), micOn: false, camOn: false });
    setPhase('idle');
    setMicOn(true);
    setCamOn(false);
  }, [connection, me, idleState]);

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
      setMicLost(false);
      mic?.addEventListener('ended', () => {
        handleMicEnded(mic);
      });
      mesh.setLocalTrack('mic', mic);
      // The intent is set first and read by everything that re-announces
      // presence for other reasons, so 'in-call' cannot be overwritten in the
      // round trip before the server echoes it back.
      setCallIntent(connection, true);
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
  }, [connection, handleMicEnded, me]);

  const join = useCallback((): void => {
    void joinMesh();
  }, [joinMesh]);

  /**
   * The way back from a lost microphone: ask for one again and republish it to
   * everyone already connected. Saying "your mic died" without this is only
   * half an answer — the other half was a page reload.
   */
  const recoverMic = useCallback((): void => {
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
        const mic = stream.getAudioTracks()[0] ?? null;
        if (mic === null) throw new Error('no microphone track');
        // THE MUTE LATCH IS THE USER'S. Swapping a dead headset for a live one
        // is not consent to be heard again, so the new track arrives in the
        // state the old one was left in.
        mic.enabled = micOn;
        micTrackRef.current = mic;
        mic.addEventListener('ended', () => {
          handleMicEnded(mic);
        });
        getCallMesh(connection, me).setLocalTrack('mic', mic);
        setMicLost(false);
        connection.presenceUpdate({ micOn });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          toast.error('Microphone permission denied — allow it in your browser to be heard');
        } else {
          toast.error(describeError(err, 'Could not reach a microphone'));
        }
      }
    })();
  }, [connection, handleMicEnded, me, micOn]);

  const toggleMic = useCallback((): void => {
    // There is nothing to unmute: the device ended and the track is gone.
    // Flipping the latch here would publish `micOn: true` to the whole room
    // over silence — the exact lie the loss handling exists to stop. The
    // surface offers recoverMic in this slot instead.
    if (micLost) return;
    const next = !micOn;
    const track = micTrackRef.current;
    if (track !== null) track.enabled = next;
    setMicOn(next);
    connection.presenceUpdate({ micOn: next });
  }, [connection, micLost, micOn]);

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
        cam?.addEventListener('ended', () => {
          handleCamEnded(cam);
        });
        // Publishing here re-offers to every peer already connected, so the
        // people already in the call see the camera — not just later joiners.
        mesh.setLocalTrack('cam', cam);
        setLocalCam(cam);
        setCamOn(true);
        setCamLost(false);
        connection.presenceUpdate({ camOn: true });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          toast.error('Camera permission denied — allow camera access in your browser');
        } else {
          toast.error(describeError(err, 'Camera unavailable'));
        }
      }
    })();
  }, [camOn, connection, handleCamEnded, me]);

  /* Unmount = leave (tracks stopped, presence restored). */
  useEffect(
    () => () => {
      if (micTrackRef.current !== null || camTrackRef.current !== null) {
        micTrackRef.current?.stop();
        camTrackRef.current?.stop();
        setCallIntent(connection, false);
        connection.presenceUpdate({
          state: idleState(),
          micOn: false,
          camOn: false,
        });
      }
    },
    [connection, idleState],
  );

  /* Self-healing presence. Other surfaces re-announce presence for their own
     reasons — the playback subscriber flips 'watching'/'listening' as a mixed
     queue moves between music and video — and any of those writes can land on
     top of 'in-call' and drop us out of everyone else's roster.

     This effect is edge-triggered on the SERVER's echo, so it must not fire
     once and give up: if the assertion is lost (a socket that went away
     mid-send, a write the server never applied) the echo never changes, the
     effect never re-runs, and the only cure left is the reload the owner found
     by hand. So it keeps saying it until the room agrees, and stops the moment
     it does — the deps carry the echo, so agreement ends the loop. */
  const myPresenceState: PresenceEntry['state'] | undefined = presence[me]?.state;
  useEffect(() => {
    if (phase !== 'in-call' || myPresenceState === 'in-call') return;
    const assert = (): void => {
      connection.presenceUpdate({ state: 'in-call', micOn, camOn });
    };
    assert();
    const handle = setInterval(assert, PRESENCE_REASSERT_MS);
    return () => {
      clearInterval(handle);
    };
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

  /** Peers whose media is arriving right now — the evidence half of the
   *  roster (callPeerIds). */
  const trackPeers = useMemo(() => {
    const ids = new Set<UserId>();
    for (const { userId } of remoteVideos) ids.add(userId);
    for (const { userId } of remoteAudios) ids.add(userId);
    return ids;
  }, [remoteVideos, remoteAudios]);

  /* Bridge bookkeeping, both written from the presence they describe.

     `everInCall` is a ref: it only ever grows, and it is consulted about peers
     who were in the call BEFORE this render, so being one tick behind is
     correct rather than merely tolerable. `leftCallAt` is state, because a
     bridge that expires has to re-render the roster to end. Anchoring on the
     moment presence stopped saying 'in-call' — rather than on the last time it
     said so — is what makes the window mean six seconds: presence only diffs
     when a field actually changes, so a quiet room's entries can be minutes
     old while everyone is still very much in the call. */
  const everInCallRef = useRef(new Set<UserId>());
  const [leftCallAt, setLeftCallAt] = useState<ReadonlyMap<UserId, number>>(() => new Map());
  const [bridgeTick, setBridgeTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const inCallNow = new Set<UserId>();
    for (const entry of Object.values(presence)) {
      if (entry.state === 'in-call') inCallNow.add(entry.userId);
    }
    for (const userId of inCallNow) everInCallRef.current.add(userId);
    setLeftCallAt((prev) => {
      let next: Map<UserId, number> | null = null;
      for (const userId of prev.keys()) {
        if (inCallNow.has(userId)) (next ??= new Map(prev)).delete(userId);
      }
      // A row that vanished entirely counts as leaving too — the peer may have
      // simply aged out of presence while their microphone kept arriving.
      for (const userId of everInCallRef.current) {
        if (inCallNow.has(userId) || prev.has(userId)) continue;
        (next ??= new Map(prev)).set(userId, now);
      }
      return next ?? prev;
    });
  }, [presence]);

  /* A bridged peer has to leave the roster when their few seconds are up, and
     a presence store that has gone quiet will not re-render us on its own. */
  useEffect(() => {
    const now = Date.now();
    let earliest: number | null = null;
    for (const userId of trackPeers) {
      if (presence[userId]?.state === 'in-call') continue;
      const at = leftCallAt.get(userId);
      if (at === undefined) continue;
      const dueIn = at + PRESENCE_BRIDGE_MS - now;
      if (dueIn <= 0) continue;
      if (earliest === null || dueIn < earliest) earliest = dueIn;
    }
    if (earliest === null) return;
    const handle = setTimeout(() => {
      setBridgeTick((n) => n + 1);
    }, earliest + 1);
    return () => {
      clearTimeout(handle);
    };
  }, [presence, trackPeers, leftCallAt, bridgeTick]);

  /* bridgeTick is the clock; everInCallRef is a ref by design (above). */
  const peerIds = useMemo(
    () =>
      callPeerIds({
        me,
        presence,
        trackPeers,
        everInCall: everInCallRef.current,
        leftCallAt,
        now: Date.now(),
      }),
    [me, presence, trackPeers, leftCallAt, bridgeTick],
  );

  const audioSources = useMemo<AudioSource[]>(() => {
    const list: AudioSource[] = remoteAudios.map(({ userId, track }) => ({ userId, track }));
    const mic = micTrackRef.current;
    if (phase === 'in-call' && mic !== null) list.unshift({ userId: me, track: mic });
    return list;
    // micTrackRef is a ref by design (the track outlives renders); phase and
    // micLost are what actually change whether it should be measured — a mic
    // that ended must leave the analyser, or the ring keeps its last reading.
  }, [remoteAudios, phase, me, micLost]);
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
        // A microphone that ended is not "on" by any honest reading, whatever
        // the mute latch still says — my own tile lies to me first.
        micOn: micOn && !micLost,
        camOn,
        sharing: presence[me]?.sharing === true,
        speaking: micOn && !micLost && speakingIds.has(me),
        videoTrack: camOn ? localCam : null,
        linkStatus: 'ok',
      });
    }
    for (const userId of peerIds) {
      // Presence keeps carrying mic/cam/sharing accurately even while its
      // `state` is momentarily wrong (the server merges partial patches), so
      // these read from it when it exists and from the media when it does not.
      const entry = presence[userId];
      const info = memberById.get(userId);
      const sharing = entry?.sharing === true;
      const video = videoByUser.get(userId) ?? null;
      const micOnPeer = entry?.micOn ?? true;
      const camOnPeer = entry?.camOn ?? video !== null;
      list.push({
        userId,
        name: info?.displayName ?? 'Someone',
        avatarUrl: info?.avatarUrl ?? null,
        accentColor: info?.accentColor ?? null,
        isMe: false,
        micOn: micOnPeer,
        camOn: camOnPeer,
        sharing,
        speaking: micOnPeer && speakingIds.has(userId),
        // A sharing peer's video is already on the stage, and the mesh cannot
        // tell their camera track from their screen track — show the avatar.
        videoTrack: camOnPeer && !sharing ? video : null,
        linkStatus: linkStatusFor({
          connection: connStates.get(userId),
          everConnected: everConnectedRef.current.has(userId),
          unreachable: unreachable.has(userId),
        }),
      });
    }
    return list;
    // everConnectedRef is a ref by design (above); connStates is the clock —
    // nothing joins that set without also moving a connection state.
  }, [
    phase,
    me,
    micOn,
    micLost,
    camOn,
    localCam,
    peerIds,
    presence,
    memberById,
    speakingIds,
    videoByUser,
    connStates,
    unreachable,
  ]);

  /* ── what the call may claim about itself ──────────────────────────────────
     Both of these fold over the CALL's links only. The mesh connects the whole
     room — it carries the DataChannel fabric, and a lurker's connection is as
     real as a caller's — so a badge folded over every peer would answer for
     links no call media has ever touched. */
  const mediaPath = useMemo(
    () =>
      callPathFrom(
        peerIds.map((userId) => ({
          connection: connStates.get(userId),
          path: linkPaths.get(userId) ?? 'unknown',
          lost: unreachable.has(userId),
        })),
      ),
    [peerIds, connStates, linkPaths, unreachable],
  );

  const connectivity = useMemo(
    () =>
      connectivityNote({
        names: participants
          .filter((p) => p.linkStatus === 'unreachable')
          // The roster's placeholder for a member row that has not loaded is a
          // capitalised 'Someone', which mid-sentence reads as a name.
          .map((p) => (p.name === 'Someone' ? 'someone' : p.name)),
        others: participants.filter((p) => !p.isMe).length,
        relay,
      }),
    [participants, relay],
  );

  /* ── what the content player has to answer to ──────────────────────────────
     Two signals, deliberately read from two different places (see
     lib/player/room-audio.ts). Publishing them here rather than passing them
     down keeps the stage — an iframe-owning subtree — out of a re-render every
     time somebody starts a sentence.

     SPEECH: measured, fast, drives ducking.
     VOICE:  presence mic state, slow, drives the drift band. It counts every
             open mic in the room, not only the ones on this call's roster,
             because the trade Consequence B describes is about live audio in
             the room and nothing else. */
  const duck = shouldDuckContent({ participants, soundBlocked: soundIsBlocked });
  useEffect(() => {
    publishSpeechActive(duck);
  }, [duck]);

  const voiceActive = useMemo(() => voiceActiveFrom(Object.values(presence)), [presence]);
  useEffect(() => {
    publishVoiceActive(voiceActive);
  }, [voiceActive]);

  /* Standing both down is the teardown that matters: a player left ducked, or
     left tightened, by a publisher that no longer exists has no control
     anywhere in the room that would put it back. Unmount-only on purpose —
     folding this into the effects above would publish false between every
     edge. */
  useEffect(
    () => () => {
      publishSpeechActive(false);
      publishVoiceActive(false);
    },
    [],
  );

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
      micLost,
      camLost,
      cameraAvailable: true,
      participants,
      publisherCap,
      capReached: inCallCount >= publisherCap && phase !== 'in-call',
      mediaPath,
      relayLabel: CALL_PATH_LABEL[mediaPath],
      connectivityNote: connectivity,
      join,
      leave,
      toggleMic,
      toggleCamera,
      recoverMic,
    }),
    [
      phase,
      micOn,
      camOn,
      micLost,
      camLost,
      mediaPath,
      connectivity,
      participants,
      publisherCap,
      inCallCount,
      join,
      leave,
      toggleMic,
      toggleCamera,
      recoverMic,
    ],
  );

  return (
    <CallSessionContext.Provider value={value}>
      {children}
      {phase === 'in-call' &&
        unclaimedAudios.map((entry) => (
          <RemoteAudioTrack
            key={entry.track.id}
            track={entry.track}
            resumeNonce={resumeNonce}
            onPlayResult={notePlayResult}
          />
        ))}
      {phase === 'in-call' && soundIsBlocked && (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center">
          <Button
            size="sm"
            onClick={() => {
              // Inside the gesture, which is the whole of what the policy
              // was waiting for. Each sink reports again from here.
              setResumeNonce((n) => n + 1);
            }}
          >
            {CALL_SOUND_BLOCKED_LABEL}
          </Button>
        </div>
      )}
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

/** How a link reads to a screen reader; the visible labels are uppercase. */
const LINK_STATUS_SPOKEN: Record<Exclude<LinkStatus, 'ok'>, string> = {
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  unreachable: 'cannot connect',
};

/** One person's state in words — the tile's accessible label, and the orb's. */
function statusOf(p: CallParticipant): string {
  const base = p.camOn ? (p.micOn ? 'mic on' : 'muted') : p.micOn ? 'camera off' : 'camera off, muted';
  // A tile is the only place a broken link is visible per person; the toast
  // says it once for the call, this says which tile it happened to.
  return p.linkStatus === 'ok' ? base : `${base}, ${LINK_STATUS_SPOKEN[p.linkStatus]}`;
}

/**
 * The chip that survives being drawn over arbitrary moving picture: the
 * measured `--scrim` wash and the absolute white ink. Neither is theme
 * relative on purpose — what is behind a call tile is a camera feed, and a
 * caption that inverted with the app's palette would be legible in one theme
 * and gone in the other.
 */
const OVER_VIDEO = 'bg-scrim text-[var(--ink-white)]';

/**
 * Presence orb (DESIGN.md §5.2) — the face, the person's own accent as its
 * edge, and the speaking ring measured from live audio.
 *
 * The halo is a SIBLING of the avatar, never a class on it: `pulse-ring` runs
 * 0.9 → 1.8 scale and 0.6 → 0 opacity, so whatever wears it expands and
 * vanishes. The halo is the thing that may do that; a face is not.
 *
 * Two rings, and the second one is not decoration. Under
 * `prefers-reduced-motion` globals.css collapses every animation to one 0.01ms
 * iteration, which leaves the halo parked at opacity 0 — so the still ring is
 * what says "speaking" for a reader who has asked the room to stop moving.
 */
function PresenceOrb({ participant, size }: { participant: CallParticipant; size: number }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {participant.speaking && (
        <>
          <span
            aria-hidden
            // The still ring carries the one glow this file is allowed. §4
            // permits glow on signature moments and nothing else, and §5.2 —
            // the presence orb with a ring measured from real audio — is one
            // of the five. It is also what makes the speaking state read at a
            // glance at the sizes this orb is actually drawn (32–64px), where
            // a 2px ring on its own is a hairline; and it survives
            // reduced-motion, where the halo below does not.
            className="pointer-events-none absolute -inset-1 rounded-full shadow-glow ring-2 ring-accent"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 animate-pulse-ring rounded-full ring-2 ring-accent"
          />
        </>
      )}
      <Avatar
        name={participant.name}
        src={participant.avatarUrl}
        accentColor={participant.accentColor}
        size={size}
        // Every caller wraps this in a <figure> that is already labelled with
        // the name and the state; an orb that announced the name again would
        // make every tile read out twice.
        decorative
      />
    </span>
  );
}

/**
 * The marker that overhangs an orb: muted, sharing, or the camera invitation.
 *
 * `surface-3`, and it has to be the TOP rung. The marker sits half on the
 * avatar and half on whatever is behind it, and behind it is the rail — which
 * IS `surface-1`, so the step this used to take made the plate invisible
 * against the one surface it most needed to separate from.
 */
function OrbMarker({ children, tone }: { children: ReactNode; tone: 'quiet' | 'danger' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full bg-surface-3',
        tone === 'danger' ? 'text-danger' : 'text-low',
      )}
    >
      {children}
    </span>
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
  const { name, micOn, camOn, sharing, speaking, videoTrack, isMe, linkStatus } = participant;
  return (
    <figure
      className={cn(
        'relative flex aspect-video items-center justify-center overflow-hidden rounded-card bg-surface-2',
        speaking && 'ring-2 ring-accent',
      )}
      aria-label={`${name} — ${statusOf(participant)}`}
    >
      {videoTrack !== null ? (
        <TrackVideo track={videoTrack} mirror={isMe} />
      ) : (
        <PresenceOrb participant={participant} size={compact ? 32 : 44} />
      )}

      {isMe && !camOn && onTurnOnCamera !== undefined && !compact && (
        <div className="absolute inset-x-0 bottom-0 flex justify-center pb-2">
          {/* D2 wants this prominent, and once you are in the call this region
              has no other gradient — the join affordance it replaces is gone. */}
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
        className={cn(
          'pointer-events-none absolute left-1 top-1 flex max-w-[calc(100%-0.5rem)] items-center',
          'gap-1 rounded-full px-1.5 py-0.5 text-label',
          OVER_VIDEO,
        )}
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
        <span
          className={cn(
            'pointer-events-none absolute right-1 top-1 rounded-full px-2 py-0.5 text-caption',
            OVER_VIDEO,
          )}
        >
          Sharing
        </span>
      )}

      {linkStatus !== 'ok' && (
        <span
          className={cn(
            'pointer-events-none absolute inset-x-1 bottom-1 truncate rounded-full px-2 py-0.5',
            'text-center text-caption',
            OVER_VIDEO,
          )}
        >
          {LINK_STATUS_LABEL[linkStatus]}
        </span>
      )}
    </figure>
  );
}

/**
 * The call as it looks almost all of the time: cameras are OFF by default
 * (D2), so a grid of 16:9 rectangles is a grid of empty boxes with a small
 * face in the middle of each. Orbs are the people — the same faces at twice
 * the size, named, in a cluster rather than a table.
 */
function OrbCluster({
  participants,
  compact,
  onTurnOnCamera,
}: {
  participants: CallParticipant[];
  compact: boolean;
  onTurnOnCamera?: (() => void) | undefined;
}) {
  const size = compact ? 36 : 64;
  return (
    <ul
      role="list"
      className={cn('flex list-none flex-wrap justify-center', compact ? 'gap-3' : 'gap-4')}
    >
      {participants.map((p) => {
        const offersCamera = p.isMe && !p.camOn && onTurnOnCamera !== undefined && !compact;
        return (
          <li key={p.userId} className={cn('flex flex-col items-center gap-2', !offersCamera && 'w-20')}>
            <figure
              className="flex flex-col items-center gap-2"
              aria-label={`${p.name} — ${statusOf(p)}`}
            >
              <span className="relative">
                <PresenceOrb participant={p} size={size} />
                {!p.micOn && (
                  <OrbMarker tone="danger">
                    <MicOffIcon size={12} />
                  </OrbMarker>
                )}
                {p.micOn && p.sharing && (
                  <OrbMarker tone="quiet">
                    <MonitorIcon size={12} />
                  </OrbMarker>
                )}
              </span>
              {!compact &&
                (offersCamera ? (
                  // D2's affordance, on my own tile. It takes the caption slot
                  // rather than sitting beside my name: "You" is the least
                  // informative word on this surface, and the invitation is the
                  // most useful one.
                  <Button size="sm" onClick={onTurnOnCamera} aria-label="Turn on camera">
                    <VideoIcon size={16} aria-hidden />
                    Turn on camera
                  </Button>
                ) : (
                  <figcaption className="w-full truncate text-center text-label text-hi">
                    {p.name}
                  </figcaption>
                ))}
            </figure>
            {p.linkStatus !== 'ok' && !compact && (
              // 'unreachable' is a verdict, not a wait: it takes the danger
              // rung so an orb that has stopped trying does not read like one
              // that is still going.
              <p
                className={cn(
                  'w-full truncate text-center text-caption',
                  p.linkStatus === 'unreachable' ? 'text-danger' : 'text-low',
                )}
              >
                {LINK_STATUS_LABEL[p.linkStatus]}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One rule for both surfaces: the moment anybody publishes a camera the call
 * becomes a picture and takes the tile grid; until then it is a room full of
 * people and takes the orbs.
 */
function CallTiles({
  participants,
  compact = false,
  onTurnOnCamera,
}: {
  participants: CallParticipant[];
  compact?: boolean;
  onTurnOnCamera?: (() => void) | undefined;
}) {
  if (!participants.some((p) => p.videoTrack !== null)) {
    return (
      <OrbCluster
        participants={participants}
        compact={compact}
        onTurnOnCamera={onTurnOnCamera}
      />
    );
  }
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
      {/* A mute toggle over a microphone that no longer exists is a control
          that does nothing, next to an icon that says everything is fine. The
          slot carries the recovery instead, for exactly as long as it is the
          only thing worth clicking. */}
      {call.micLost ? (
        <Button
          variant="secondary"
          size="sm"
          aria-label="Reconnect microphone"
          onClick={call.recoverMic}
        >
          <MicOffIcon size={size} aria-hidden className="text-danger" />
          {!compact && 'Reconnect mic'}
        </Button>
      ) : (
        <Button
          variant={call.micOn ? 'secondary' : 'ghost'}
          size="sm"
          aria-label={call.micOn ? 'Mute microphone' : 'Unmute microphone'}
          aria-pressed={!call.micOn}
          onClick={call.toggleMic}
        >
          {call.micOn ? (
            <MicIcon size={size} aria-hidden />
          ) : (
            <MicOffIcon size={size} aria-hidden />
          )}
        </Button>
      )}
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
 * The call surface at the top of the right rail. An invitation when the room
 * is not calling; orbs (or tiles, once a camera is on) plus one control bar
 * the moment anyone is.
 *
 * ── Why the idle state grew (2026-08-19) ──────────────────────────────────
 * Starting a call is the primary social action of the product and it was a
 * 13px text button in a rail header, ranked below the invite chip beside it.
 * It is now the only aurora gradient in this region, on a `title` line, with
 * one sentence of what it does — a block that says "this is the thing you came
 * here to do" instead of a row that says "here is a setting".
 *
 * It stays ONE interaction (§12: join the call, budget 1). Nothing about this
 * composition adds a step; the click that used to be on a whole-row button is
 * on a button.
 */
export function CallDock({ roomId, className }: { roomId: RoomId; className?: string }) {
  const call = useCallSession();
  const { participants, phase } = call;
  const empty = participants.length === 0;
  const lossNote = deviceLossNote(call);

  if (empty) {
    return (
      <section
        aria-label="Call"
        data-room={roomId}
        // `p-4` where the working state below takes `p-3`: an invitation is
        // given room, a surface you are operating is given density. Two rungs
        // of the same ramp saying two different things is the point (§4).
        className={cn('flex items-center gap-3 p-4', className)}
      >
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-ctl bg-surface-2 text-low"
        >
          <UsersIcon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-title text-hi">Start a call</p>
          <p className="truncate text-label text-low">
            Talk while you watch · {call.relayLabel}
          </p>
        </div>
        <Button
          className="shrink-0"
          onClick={call.join}
          disabled={call.capReached || phase === 'joining'}
          aria-label="Start a call"
        >
          {phase === 'joining' ? 'Joining…' : 'Start'}
        </Button>
      </section>
    );
  }

  return (
    <section aria-label="Call" data-room={roomId} className={cn('flex flex-col p-3', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-caption text-low">
          <span className="tabular-nums">{participants.length}</span> in call
        </p>
        <p className="shrink-0 text-caption text-low">{call.relayLabel}</p>
      </div>
      <div className="mt-3">
        <CallTiles
          participants={participants}
          onTurnOnCamera={call.cameraAvailable ? call.toggleCamera : undefined}
        />
      </div>
      {/* D2 forbids a silent empty call region, and a call of one is the
          quietest this surface ever gets: your own orb, and no way to tell
          whether the room is failing to connect anyone or nobody has come. */}
      {participants.length === 1 && (
        <p className="mt-3 text-center text-label text-low">
          Nobody else has joined yet — they can hop in whenever.
        </p>
      )}
      {/* The icons cannot carry this: the whole defect is that a dead track
          looks exactly like a live one. Say it in words. */}
      {lossNote !== null && (
        <p role="alert" className="mt-3 text-label text-danger">
          {lossNote}
        </p>
      )}
      {/* And the other half of the same rule: a tile that has stopped trying
          gets three words, and the reason gets a sentence. */}
      {call.connectivityNote !== null && (
        <p role="alert" className="mt-3 text-label text-danger">
          {call.connectivityNote}
        </p>
      )}
      {/* Wider than the gaps above it: the controls are a separate block from
          the people, not the last row of them. */}
      <div className="mt-4 flex items-center justify-center gap-2">
        {phase === 'in-call' ? <ControlBar /> : <JoinButton />}
      </div>
      {call.capReached && phase !== 'in-call' && (
        <p className="mt-2 text-center text-label text-low">
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
  const lossNote = deviceLossNote(call);

  if (participants.length === 0) return null;

  if (hidden) {
    return (
      <div className={cn(OVERLAY_ANCHOR, 'flex max-w-44 flex-col gap-1', className)}>
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Show call tiles — ${participants.length} in call`}
          onClick={() => setHidden(false)}
        >
          <UsersIcon size={16} aria-hidden />
          {participants.length}
        </Button>
        {/* Dismissing the tiles is not consent to be told nothing: a device
            that died, and a call nobody can reach you on, are the two things
            this collapsed state still owes you. */}
        {lossNote !== null && (
          <p role="alert" className="glass-raised rounded-ctl px-2 py-1 text-label text-danger">
            {lossNote}
          </p>
        )}
        {call.connectivityNote !== null && (
          <p role="alert" className="glass-raised rounded-ctl px-2 py-1 text-label text-danger">
            {call.connectivityNote}
          </p>
        )}
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
      <CallTiles participants={shown} compact />
      {overflow > 0 && <p className="text-label text-low">+{overflow} more in the call</p>}
      {/* Theater and mobile see this surface and no other, so the device-loss
          and connectivity sentences have to live here too. */}
      {lossNote !== null && (
        <p role="alert" className="text-label text-danger">
          {lossNote}
        </p>
      )}
      {call.connectivityNote !== null && (
        <p role="alert" className="text-label text-danger">
          {call.connectivityNote}
        </p>
      )}
      {call.phase === 'in-call' ? <ControlBar compact /> : <JoinButton />}
    </aside>
  );
}
