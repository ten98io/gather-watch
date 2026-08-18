/**
 * Mesh manager: owns one RTCPeerConnection per remote peer, drives perfect
 * negotiation over the room websocket, attaches the typed DataChannel fabric,
 * and fans local media tracks out to every current and future connection.
 *
 * Everything here is event-driven and defensive — a misbehaving peer, a stale
 * signal, or a throwing platform primitive must surface through `onError`,
 * never as an exception escaping an event path.
 */

import type { PresenceEntry, RoomId, UserId } from '@gather/contracts';
import { applyMaxBitrate, clearMaxBitrate } from './adaptation';
import { CHANNEL_IDS, ChannelFabric } from './channels';
import type { ChannelFabricOptions, ChannelLabel } from './channels';
import { classifyLinkStats } from './linkstate';
import type { MeshLinkState } from './linkstate';
import { PerfectNegotiator } from './negotiation';
import type {
  ClearTimeoutFn,
  ConnectionStateLike,
  IceServerLike,
  InboundSignal,
  MediaStreamTrackLike,
  NowFn,
  RtcConfigLike,
  RtcFactory,
  RtcPeerConnectionLike,
  RtpSenderLike,
  SetTimeoutFn,
  SignalSend,
  TimeoutHandle,
  TrackRole,
} from './types';

/** Per-peer connection state exposed to subscribers. */
export type MeshConnectionState = ConnectionStateLike;

/**
 * The fixed vocabulary of AUXILIARY meshes one identity may run alongside its
 * primary one.
 *
 * A person sharing from the extension is in the room twice: the web tab holds
 * the call, the offscreen document holds the screen capture, and both
 * authenticate as the same user — correctly, because the server stamps
 * `fromUserId` from the socket. The pair-derived connectionId then came out
 * IDENTICAL for both, so a viewer answered whichever spoke first and dropped
 * the other as a stale/glare-loser answer: about half the time it landed on
 * the call connection and never saw the share, the other half on the share
 * connection and never heard the voice.
 *
 * A lane names WHICH of that identity's meshes a connection belongs to, and it
 * is folded into the connectionId, so the two can no longer collide.
 *
 * The vocabulary is deliberately fixed and tiny rather than free-form. An
 * inbound signal is matched by ENUMERATING the handful of ids this pair could
 * have derived (see `remoteEndpointFor`), which keeps the "both sides compute
 * the same id with no round trip" property intact, needs no parsing of a
 * connectionId back into user ids — a UserId is only constrained to be a
 * non-empty string, so no separator can be relied on to split one — and bounds
 * the number of connections a remote can make us build to
 * MESH_LANES.length + 1, however many sockets it opens.
 */
export const MESH_LANES = ['share'] as const;

/** One of {@link MESH_LANES}. */
export type MeshLane = (typeof MESH_LANES)[number];

/** Options for {@link MeshManager}. */
export interface MeshManagerOptions {
  roomId: RoomId;
  localUserId: UserId;
  /**
   * Which of this identity's meshes this one is.
   *
   * Omitted — the default, and what every web/mobile client wants — makes it
   * the PRIMARY mesh: the one presence dials, the one that carries the call
   * and the DataChannel fabric, and the only one that will answer a remote
   * auxiliary endpoint.
   *
   * Set it only on a SECOND mesh the same user runs at the same time (today:
   * the extension's offscreen share document). An auxiliary mesh reaches
   * remote PRIMARY meshes only, and only by offering first — it is a one-way
   * media pipe, so it never needs a peer to dial IT, which is exactly why its
   * lane does not have to be discoverable in advance.
   */
  lane?: MeshLane;
  /** Injected platform peer-connection factory. */
  rtcFactory: RtcFactory;
  /** Outbound signaling transport (room WS). */
  send: SignalSend;
  /** Fresh ICE servers spliced into every NEW RTCPeerConnection
   *  (typically TurnCredentialManager.iceServers). Callers normally start that
   *  fetch without awaiting it, so this may legitimately return [] for the
   *  first few hundred ms of a room; see `fallbackIceServers`. */
  getIceServers?: () => IceServerLike[];
  /** Used INSTEAD of an empty getIceServers() result, and repaired away once
   *  real credentials show up. Defaults to public STUN. Pass [] to opt out and
   *  keep building peers with no ICE servers at all. */
  fallbackIceServers?: IceServerLike[];
  now: NowFn;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  /** Gap before an unanswered offer is re-sent (see {@link PerfectNegotiator}). */
  offerRetryMs?: number;
  /** Per-link stats poll implementation; defaults to pc.getStats?.(). */
  statsPollFn?: (pc: RtcPeerConnectionLike) => Promise<unknown>;
  /** Operator cost lever, off by default: no caller sets it, so every share
   *  runs at full quality. When set, the 'share' sender on any RELAYED link is
   *  bitrate-capped to this many kbps (maxBitrate on every encoding), and
   *  uncapped again when the link becomes 'direct'. Audio is never capped —
   *  not the microphone, and not the share's own soundtrack ('share-audio'),
   *  which is the half of a share people notice going missing. A share to a
   *  peer whose link has not been classified yet — a
   *  brand-new connection — runs uncapped for up to one pollStats interval,
   *  until the first poll classifies the link; a share started on an existing
   *  relayed link is capped from the first frame. */
  capRelayedVideoKbps?: number;
  /** Negotiation errors etc. surface here. */
  onError?: (peerId: UserId, context: string, err: unknown) => void;
  fabricOptions?: ChannelFabricOptions;
}

/** Everything the mesh keeps per remote ENDPOINT. One remote identity may hold
 *  more than one: their call and their share are two of these. */
interface MeshPeer {
  pc: RtcPeerConnectionLike;
  negotiator: PerfectNegotiator;
  senders: Map<TrackRole, RtpSenderLike>;
  state: MeshConnectionState;
  connectionId: string;
  /** The remote identity. Several endpoints may share one. */
  userId: UserId;
  /** The remote endpoint's lane; null when it is that user's primary mesh. */
  lane: MeshLane | null;
  /** Last REPORTED link path (post-debounce), not the raw last classification. */
  linkState: MeshLinkState;
  /** Consecutive 'unknown' classifications while linkState is known. */
  unknownStreak: number;
  /** Whether the relay cap was pushed onto the current 'share' sender. */
  capApplied: boolean;
  /** Built on the fallback ICE list because getIceServers() was still empty.
   *  Repaired (and cleared) as soon as real credentials appear. */
  iceProvisional: boolean;
}

/** The fixed channel labels created pre-negotiated on every connection. */
const FABRIC_LABELS: readonly ChannelLabel[] = ['sync', 'file', 'emote'];

/** A known link state only demotes to 'unknown' after this many consecutive
 *  unknown classifications — stats gaps during ICE restarts are transient and
 *  must not flap the reported state (or the user-facing copy) every poll. */
const UNKNOWN_POLLS_TO_DEMOTE = 2;

/** Stand-in for credentials that have not arrived — or never will. A peer
 *  built with NO ice servers can only ever offer host candidates, so it fails
 *  for everyone off the local network, permanently: WebRTC does not re-read
 *  the configuration of a live connection. Public STUN is the smallest thing
 *  that keeps such a peer usable. */
const DEFAULT_FALLBACK_ICE_SERVERS: IceServerLike[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/** How often a mesh holding provisional peers re-reads getIceServers(). */
const ICE_REPAIR_POLL_MS = 250;

/** How long that re-read keeps going before the fallback is accepted as final.
 *  Long enough to cover the credential manager's first couple of retries. */
const ICE_REPAIR_WINDOW_MS = 30_000;

/** How long a peer that presence took away is refused re-admission by an
 *  inbound signal. Long enough to swallow the signals already in flight behind
 *  the departure, short enough that a peer who is genuinely still there — our
 *  presence being the thing that is wrong — gets back in on its next re-offer
 *  instead of being locked out until presence recovers. */
const ADMIT_SUPPRESS_MS = 5000;

/** How usable each connection state is. When one identity holds several
 *  endpoints, the best of them stands for the person: the app's question is
 *  "can I reach them", and one live link answers yes. It also keeps 'closed'
 *  meaning what the app relies on it meaning — nothing of theirs is left — so
 *  a share ending cannot make a caller drop the tracks of the call. */
const STATE_RANK: Record<MeshConnectionState, number> = {
  connected: 5,
  connecting: 4,
  new: 3,
  disconnected: 2,
  failed: 1,
  closed: 0,
};

/** The optional live-reconfiguration method: present on browser and
 *  react-native RTCPeerConnection, absent from RtcPeerConnectionLike because
 *  not every injected primitive has to provide it. Probed structurally. */
type Reconfigurable = { setConfiguration?: (config: RtcConfigLike) => void };

/** Map key for one remote endpoint. The lane leads and is separated by a NUL:
 *  a UserId is only constrained to be a non-empty string, so a user could in
 *  principle be named `bob/share` and collide with bob's share endpoint in any
 *  printable-separator scheme. Nothing puts a NUL in an id. */
function peerKey(userId: UserId, lane: MeshLane | null): string {
  return `${lane ?? ''}\u0000${userId}`;
}

/** How an endpoint names itself INSIDE a connectionId. A primary endpoint is
 *  its bare user id, so a room where nobody runs a second mesh derives exactly
 *  the ids it always did and old and new builds still meet each other. */
function endpointName(userId: UserId, lane: MeshLane | null): string {
  return lane === null ? userId : `${userId}/${lane}`;
}

/** Fold one endpoint's link path into the answer for the whole person.
 *  Conservative about cost — any relayed endpoint makes the person relayed,
 *  because that is the one that spends TURN egress — and optimistic about
 *  classification, so an endpoint no poll has reached yet does not erase what
 *  another one already established. */
function foldLink(seen: MeshLinkState | undefined, next: MeshLinkState): MeshLinkState {
  if (seen === undefined) return next;
  if (seen === 'relayed' || next === 'relayed') return 'relayed';
  if (seen === 'direct' || next === 'direct') return 'direct';
  return 'unknown';
}

/**
 * Owns the full-mesh lifecycle: reconcile the desired peer set, route
 * signaling, manage local track publication, and expose remote tracks,
 * per-peer states, and link stats to the app layer.
 */
export class MeshManager {
  /** The typed DataChannel fabric shared by beacon/fileshare/emote layers. */
  readonly fabric: ChannelFabric;

  private readonly roomId: RoomId;
  private readonly localUserId: UserId;
  private readonly lane: MeshLane | null;
  /** How THIS endpoint names itself inside a connectionId. */
  private readonly localName: string;
  private readonly rtcFactory: RtcFactory;
  private readonly send: SignalSend;
  private readonly getIceServers: () => IceServerLike[];
  /** False when the caller supplied no getIceServers at all: there is then no
   *  pending fetch to wait on, so nothing is ever provisional. */
  private readonly iceServersProvided: boolean;
  private readonly fallbackIceServers: IceServerLike[];
  private readonly now: NowFn;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly offerRetryMs: number | undefined;
  private readonly statsPollFn: ((pc: RtcPeerConnectionLike) => Promise<unknown>) | undefined;
  private readonly capRelayedVideoKbps: number | undefined;
  private readonly onError: (peerId: UserId, context: string, err: unknown) => void;

  /** Every remote ENDPOINT, keyed by {@link peerKey}. One identity can hold
   *  several: their call and their share are two connections. */
  private readonly peerMap = new Map<string, MeshPeer>();
  /** Last state announced per USER, so a person with two endpoints produces
   *  one stream of events rather than two interleaved ones. */
  private readonly reportedStates = new Map<UserId, MeshConnectionState>();
  private readonly reportedLinks = new Map<UserId, MeshLinkState>();
  /** Peers an explicit reconcile took away, and the moment they may be admitted
   *  by signal again. Presence is authoritative about who LEFT, so the signals
   *  still in flight behind a departure must not resurrect the peer. Keyed by
   *  USER: a person presence took away takes every endpoint of theirs with them. */
  private readonly admitSuppressedUntil = new Map<UserId, number>();
  private iceRepairTimer: TimeoutHandle | null = null;
  private iceRepairDeadline = 0;
  private readonly localTracks = new Map<TrackRole, MediaStreamTrackLike>();
  private readonly trackSubs = new Set<
    (peerId: UserId, track: MediaStreamTrackLike, streams: unknown[]) => void
  >();
  private readonly stateSubs = new Set<(peerId: UserId, state: MeshConnectionState) => void>();
  private readonly linkSubs = new Set<(peerId: UserId, state: MeshLinkState) => void>();
  private closed = false;

  constructor(opts: MeshManagerOptions) {
    this.roomId = opts.roomId;
    this.localUserId = opts.localUserId;
    this.lane = opts.lane ?? null;
    this.localName = endpointName(opts.localUserId, this.lane);
    this.rtcFactory = opts.rtcFactory;
    this.send = opts.send;
    this.getIceServers = opts.getIceServers ?? (() => []);
    this.iceServersProvided = opts.getIceServers !== undefined;
    this.fallbackIceServers = opts.fallbackIceServers ?? DEFAULT_FALLBACK_ICE_SERVERS;
    this.now = opts.now;
    this.setTimeoutFn = opts.setTimeoutFn;
    this.clearTimeoutFn = opts.clearTimeoutFn;
    this.offerRetryMs = opts.offerRetryMs;
    this.statsPollFn = opts.statsPollFn;
    this.capRelayedVideoKbps = opts.capRelayedVideoKbps;
    this.onError = opts.onError ?? (() => {});
    this.fabric = new ChannelFabric(opts.fabricOptions);
  }

  /** Reconcile toward the desired remote-peer set (adds + removes).
   *
   *  Presence names PEOPLE, and the endpoint it names is always the primary
   *  one: an auxiliary endpoint is not dialled, it announces itself by
   *  offering (see {@link handleSignal}). A departure still takes every
   *  endpoint of that person with it — presence is authoritative about who
   *  left, whatever they had open. */
  syncPeers(userIds: UserId[]): void {
    if (this.closed) return;
    const desired = new Set(userIds);
    for (const peerId of desired) {
      if (peerId === this.localUserId) continue;
      this.admitSuppressedUntil.delete(peerId);
      if (!this.peerMap.has(peerKey(peerId, null))) this.addPeer(peerId, null);
    }
    for (const [key, peer] of [...this.peerMap]) {
      if (desired.has(peer.userId)) continue;
      // Note the departure: signals from this peer may still be in flight
      // behind the presence update, and they must not re-open the connection.
      this.admitSuppressedUntil.set(peer.userId, this.now() + ADMIT_SUPPRESS_MS);
      this.removePeer(key);
    }
  }

  /** Convenience: derive the desired set from presence entries — everyone who is
   *  not the local user and not 'offline'. */
  applyPresence(entries: PresenceEntry[]): void {
    this.syncPeers(
      entries
        .filter((e) => e.userId !== this.localUserId && e.state !== 'offline')
        .map((e) => e.userId),
    );
  }

  /**
   * Route a server-relayed webrtc.* event to the right negotiator, ADMITTING
   * the sender as a peer when we have not built one yet.
   *
   * Admission is what keeps the mesh convergent. Peers are otherwise derived
   * from presence, which each client receives on its own schedule, so there is
   * a window where A has B and B does not yet have A. Dropping B's view of A's
   * offer used to end the pair there and then: `negotiationneeded` does not
   * re-fire, so nothing ever re-offered and only a reload rebuilt both sides.
   *
   * Admitting is safe because the SERVER stamps `fromUserId` from the
   * authenticated socket (see the hub's webrtc.* handlers) — it is not a
   * client-supplied field. An inbound signal is therefore proof that an
   * authenticated member of THIS room is trying to reach us, which is exactly
   * the set presence would have listed a moment later.
   *
   * Churn is bounded from the other side: `syncPeers` stays authoritative, so
   * an admitted peer presence never confirms is removed by the next reconcile,
   * and a peer presence has just taken away is refused for ADMIT_SUPPRESS_MS
   * so its trailing signals cannot leave a phantom connection behind.
   *
   * Admission is also the ONLY way an auxiliary endpoint (a share running
   * beside somebody's call) ever gets a connection: nothing announces that a
   * person has a second mesh, so the second mesh offers and is recognised by
   * the id it offers under.
   */
  handleSignal(ev: InboundSignal): void {
    if (this.closed) return;
    const fromUserId = ev.payload.fromUserId;
    if (fromUserId === this.localUserId) return;
    // The connectionId is derived from (room, both ENDPOINTS): both sides
    // compute the same one, and — crucially — it does not change when either
    // side rebuilds its connection, so a rebuilt peer re-establishes against the
    // remote's existing one. Anything else is misrouted or forged, and drops.
    // The one case that is neither is a LIVE local peer holding some other id
    // (only reachable across incompatible builds): the canonical id supersedes
    // it, so the pair converges instead of being stranded on a dead incarnation.
    const endpoint = this.remoteEndpointFor(fromUserId, ev.payload.connectionId);
    if (endpoint === null) return;
    const canonical = this.connectionIdFor(fromUserId, endpoint.lane);
    const key = peerKey(fromUserId, endpoint.lane);
    let peer = this.peerMap.get(key);
    if (peer !== undefined && peer.connectionId !== canonical) {
      this.removePeer(key);
      peer = undefined;
    }
    if (peer === undefined) {
      if (this.admitSuppressed(fromUserId)) return;
      this.addPeer(fromUserId, endpoint.lane);
      peer = this.peerMap.get(key);
      // addPeer failed and already reported through onError.
      if (peer === undefined) return;
    }
    peer.negotiator.handleSignal(ev).catch((err: unknown) => {
      this.onError(fromUserId, 'signal', err);
    });
  }

  /** Publish/replace/remove a local media track for a role on every current and
   *  future peer connection. null removes.
   *
   *  Nothing of ours goes onto a link whose far end is an AUXILIARY endpoint:
   *  that endpoint is somebody's outbound-only share pipe (an offscreen
   *  document with no UI and no use for a camera), so sending to it would
   *  spend the local uplink twice over on media nobody renders. */
  setLocalTrack(role: TrackRole, track: MediaStreamTrackLike | null): void {
    if (track === null) {
      this.localTracks.delete(role);
    } else {
      this.localTracks.set(role, track);
    }
    for (const peer of this.peerMap.values()) {
      if (peer.lane !== null) continue;
      try {
        this.applyTrackToPeer(peer, role, track);
      } catch (err) {
        this.onError(peer.userId, 'setLocalTrack', err);
      }
    }
  }

  /** Snapshot of connection state PER PERSON: the best state across every
   *  endpoint they hold (see {@link STATE_RANK}). */
  connectionStates(): Map<UserId, MeshConnectionState> {
    const out = new Map<UserId, MeshConnectionState>();
    for (const peer of this.peerMap.values()) {
      const seen = out.get(peer.userId);
      if (seen === undefined || STATE_RANK[peer.state] > STATE_RANK[seen]) {
        out.set(peer.userId, peer.state);
      }
    }
    return out;
  }

  /** Currently connected (or connecting) remote peers, one entry per person
   *  however many endpoints they hold. */
  peers(): UserId[] {
    const out: UserId[] = [];
    const seen = new Set<UserId>();
    for (const peer of this.peerMap.values()) {
      if (seen.has(peer.userId)) continue;
      seen.add(peer.userId);
      out.push(peer.userId);
    }
    return out;
  }

  /** Poll per-link stats via statsPollFn (or pc.getStats). Peers whose poll
   *  rejects or lacks getStats are omitted. Each successful poll also
   *  classifies the link path (direct/relayed/unknown) from the selected
   *  candidate pair and drives the relay share cap.
   *
   *  Every endpoint is polled — classification drives the cap on each link
   *  independently — but the returned map is keyed by PERSON, so a person
   *  holding two endpoints is represented by their primary one. */
  async pollStats(): Promise<Map<UserId, unknown>> {
    const out = new Map<UserId, unknown>();
    await Promise.all(
      [...this.peerMap.entries()].map(async ([key, peer]) => {
        try {
          let stats: unknown;
          if (this.statsPollFn !== undefined) {
            stats = await this.statsPollFn(peer.pc);
          } else {
            if (peer.pc.getStats === undefined) return;
            stats = await peer.pc.getStats();
          }
          if (stats !== undefined && (peer.lane === null || !out.has(peer.userId))) {
            out.set(peer.userId, stats);
          }
          // The peer may have been removed while the poll was in flight.
          if (this.peerMap.get(key) !== peer) return;
          this.noteLinkClassification(peer, classifyLinkStats(stats));
        } catch (err) {
          this.onError(peer.userId, 'pollStats', err);
        }
      }),
    );
    return out;
  }

  /** Snapshot of link path states per PERSON (post-debounce). */
  linkStates(): Map<UserId, MeshLinkState> {
    const out = new Map<UserId, MeshLinkState>();
    for (const peer of this.peerMap.values()) {
      out.set(peer.userId, foldLink(out.get(peer.userId), peer.linkState));
    }
    return out;
  }

  /** Preflight for Mode B: the link path of a peer ALREADY connected (e.g.
   *  for voice), answered from the last completed stats poll — so whether a
   *  share would be relay-capped is known BEFORE the share track is added.
   *  'unknown' for unknown peers, and for links no poll has classified yet:
   *  a share to such a peer may run uncapped for up to one poll interval. */
  linkState(peerId: UserId): MeshLinkState {
    let seen: MeshLinkState | undefined;
    for (const peer of this.peerMap.values()) {
      if (peer.userId === peerId) seen = foldLink(seen, peer.linkState);
    }
    return seen ?? 'unknown';
  }

  /** Subscribe to per-peer link path CHANGES (debounced — one event per
   *  reported transition, never one per poll). Return unsubscribe. */
  onLinkState(fn: (peerId: UserId, state: MeshLinkState) => void): () => void {
    this.linkSubs.add(fn);
    return () => {
      this.linkSubs.delete(fn);
    };
  }

  /** Trigger an ICE restart on every connection to this person. */
  restartIce(peerId: UserId): void {
    for (const peer of this.peerMap.values()) {
      if (peer.userId === peerId) peer.negotiator.restartIce();
    }
  }

  /**
   * Re-read getIceServers() and repair every peer that was built before the
   * credentials arrived. A live RTCPeerConnection never re-reads its own
   * configuration, so without this a peer created during the fetch keeps its
   * fallback list forever.
   *
   * The mesh calls this itself on a short poll while such peers exist, so no
   * caller is REQUIRED to; a caller that owns the credential manager can call
   * it from onUpdate to repair on the same tick the credentials land.
   * Cheap and idempotent: with no provisional peers it does nothing, and peers
   * built WITH credentials are never touched (rotating TURN credentials must
   * not disturb a call that is already up).
   */
  refreshIceServers(): void {
    if (this.closed) return;
    const servers = this.getIceServers();
    if (servers.length === 0) return;
    for (const [key, peer] of [...this.peerMap]) {
      if (!peer.iceProvisional) continue;
      peer.iceProvisional = false;
      this.applyIceServers(key, peer, servers);
    }
  }

  /** Subscribe to remote tracks. Return unsubscribe. */
  onRemoteTrack(
    fn: (peerId: UserId, track: MediaStreamTrackLike, streams: unknown[]) => void,
  ): () => void {
    this.trackSubs.add(fn);
    return () => {
      this.trackSubs.delete(fn);
    };
  }

  /** Subscribe to per-peer connection state changes. Return unsubscribe. */
  onConnectionState(fn: (peerId: UserId, state: MeshConnectionState) => void): () => void {
    this.stateSubs.add(fn);
    return () => {
      this.stateSubs.delete(fn);
    };
  }

  /** Close every connection and the fabric. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIceRepairTimer();
    for (const key of [...this.peerMap.keys()]) this.removePeer(key);
    this.fabric.close();
    this.trackSubs.clear();
    this.stateSubs.clear();
    this.linkSubs.clear();
    this.localTracks.clear();
    this.admitSuppressedUntil.clear();
    this.reportedStates.clear();
    this.reportedLinks.clear();
  }

  // ---------- internals ----------

  /** Whether an inbound signal from this peer is still being ignored because
   *  presence removed them a moment ago. Expired entries are pruned here. */
  private admitSuppressed(peerId: UserId): boolean {
    const until = this.admitSuppressedUntil.get(peerId);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.admitSuppressedUntil.delete(peerId);
    return false;
  }

  /** Poll getIceServers() while any peer is running on the fallback list. Stops
   *  as soon as the last one is repaired, or when the window closes and the
   *  fallback becomes the final answer (a credential fetch that never
   *  succeeds must leave a working STUN-only call, not a pending one). */
  private scheduleIceRepair(): void {
    if (this.closed) return;
    if (this.iceRepairTimer !== null) return;
    if (this.now() >= this.iceRepairDeadline) return;
    this.iceRepairTimer = this.setTimeoutFn(() => {
      this.iceRepairTimer = null;
      this.refreshIceServers();
      if (this.hasProvisionalPeers()) this.scheduleIceRepair();
    }, ICE_REPAIR_POLL_MS);
  }

  private clearIceRepairTimer(): void {
    if (this.iceRepairTimer === null) return;
    this.clearTimeoutFn(this.iceRepairTimer);
    this.iceRepairTimer = null;
  }

  private hasProvisionalPeers(): boolean {
    for (const peer of this.peerMap.values()) {
      if (peer.iceProvisional) return true;
    }
    return false;
  }

  /** Move one live peer onto a real ICE server list. setConfiguration keeps the
   *  connection, its senders and its channels alive, so it is applied to every
   *  provisional peer — a link that came up on STUN alone then has TURN to fall
   *  back on when it later fails. Only a link that has NOT come up gets the ICE
   *  restart that re-gathers candidates through the new servers. */
  private applyIceServers(key: string, peer: MeshPeer, servers: IceServerLike[]): void {
    const pc: RtcPeerConnectionLike & Reconfigurable = peer.pc;
    if (pc.setConfiguration !== undefined) {
      try {
        pc.setConfiguration({ iceServers: [...servers] });
        if (peer.state !== 'connected') peer.negotiator.restartIce();
        return;
      } catch (err) {
        this.onError(peer.userId, 'setConfiguration', err);
      }
    }
    // Without setConfiguration the only route onto the new list is a new
    // connection. Worth it for a peer still trying to reach us — that is the
    // one that needs TURN — and never worth dropping a call that already works.
    if (peer.state === 'connected') return;
    // The endpoint pair's connectionId does not change, so the remote answers
    // the fresh offer on the peer it already has; it does not rebuild too.
    this.removePeer(key);
    this.addPeer(peer.userId, peer.lane);
  }

  /**
   * Stable connection id for a pair of ENDPOINTS: identical on both sides,
   * because each side sorts the same two names.
   *
   * With neither side laned this is byte-for-byte the id this package has
   * always produced, which is what lets a client on the old build and one on
   * the new build still find each other.
   */
  private connectionIdFor(peerId: UserId, lane: MeshLane | null): string {
    const remote = endpointName(peerId, lane);
    const [a, b] =
      this.localName < remote ? [this.localName, remote] : [remote, this.localName];
    return `mesh:${this.roomId}:${a}~${b}`;
  }

  /**
   * Which of the sender's endpoints an inbound signal belongs to, or null when
   * the id is not one this pair could have derived (misrouted, forged, or —
   * the common case now — addressed to the OTHER mesh of an identity whose
   * signals the hub fans out to all of their sockets).
   *
   * Candidates are ENUMERATED and compared whole, never parsed back out of the
   * id: a UserId is only constrained to be a non-empty string, so no separator
   * can be relied on to split one.
   */
  private remoteEndpointFor(
    fromUserId: UserId,
    connectionId: string,
  ): { lane: MeshLane | null } | null {
    if (connectionId === this.connectionIdFor(fromUserId, null)) return { lane: null };
    // An auxiliary mesh answers primaries and nobody else. Two auxiliaries are
    // both outbound-only media pipes with nothing to say to each other, and
    // refusing them here is what keeps the "always offers first" rule — and so
    // the no-round-trip derivation — sound in both directions.
    if (this.lane !== null) return null;
    for (const lane of MESH_LANES) {
      if (connectionId === this.connectionIdFor(fromUserId, lane)) return { lane };
    }
    return null;
  }

  private addPeer(peerId: UserId, lane: MeshLane | null): void {
    const key = peerKey(peerId, lane);
    // The DataChannel fabric is keyed by USER, so only a link between two
    // PRIMARY meshes may own it: an auxiliary link attaching 'sync' under the
    // same user id would replace the call's channels with a share's and take
    // sync, file transfer and emotes down with it. An auxiliary link carries
    // media and nothing else.
    const fabricLink = this.lane === null && lane === null;
    try {
      // An empty list here does NOT mean "no ice servers wanted": callers start
      // the TURN credential fetch without awaiting it, so every peer built in
      // that window would otherwise run host-candidate-only for its whole life.
      const configured = this.getIceServers();
      const iceProvisional = this.iceServersProvided && configured.length === 0;
      const iceServers = configured.length === 0 ? [...this.fallbackIceServers] : configured;
      const pc = this.rtcFactory({ iceServers });
      const connectionId = this.connectionIdFor(peerId, lane);

      // Pre-negotiated fabric channels: both sides create the same fixed ids,
      // so no in-band datachannel negotiation is needed.
      if (fabricLink) {
        for (const label of FABRIC_LABELS) {
          const dc = pc.createDataChannel(label, {
            negotiated: true,
            id: CHANNEL_IDS[label],
            ordered: true,
          });
          this.fabric.attach(peerId, label, dc);
        }
      }

      const negotiator = new PerfectNegotiator({
        pc,
        roomId: this.roomId,
        localUserId: this.localUserId,
        remoteUserId: peerId,
        connectionId,
        send: this.send,
        now: this.now,
        setTimeoutFn: this.setTimeoutFn,
        clearTimeoutFn: this.clearTimeoutFn,
        ...(this.offerRetryMs === undefined ? {} : { offerRetryMs: this.offerRetryMs }),
        onError: (context, err) => {
          this.onError(peerId, context, err);
        },
      });

      const peer: MeshPeer = {
        pc,
        negotiator,
        senders: new Map(),
        state: pc.connectionState,
        connectionId,
        userId: peerId,
        lane,
        linkState: 'unknown',
        unknownStreak: 0,
        capApplied: false,
        iceProvisional,
      };
      this.peerMap.set(key, peer);

      pc.ontrack = (ev) => {
        for (const fn of [...this.trackSubs]) fn(peerId, ev.track, ev.streams);
      };
      pc.onconnectionstatechange = () => {
        peer.state = pc.connectionState;
        this.reportState(peerId);
        if (peer.state !== 'failed') return;
        if (lane === null) {
          negotiator.restartIce();
          return;
        }
        // An AUXILIARY endpoint is not ours to repair. Presence still lists
        // the person — their call is right there — so no reconcile will ever
        // clean this up, and restarting ICE at an offscreen document that
        // closed when the share ended retries forever at nothing. Drop it: a
        // share that comes back offers again and is admitted again.
        this.removePeer(key);
      };
      if (fabricLink) {
        // Defensive: a non-negotiated inbound channel with a known label joins
        // the fabric like any other.
        pc.ondatachannel = (ev) => {
          const label = ev.channel.label;
          if (label === 'sync' || label === 'file' || label === 'emote') {
            this.fabric.attach(peerId, label, ev.channel);
          }
        };
      }

      // Tracks published before this peer existed join its connection now —
      // unless the far end is an auxiliary endpoint, which publishes to us and
      // renders nothing of ours (see setLocalTrack).
      if (lane === null) {
        for (const [role, track] of this.localTracks) {
          peer.senders.set(role, pc.addTrack(track));
        }
      }

      if (iceProvisional) {
        this.iceRepairDeadline = this.now() + ICE_REPAIR_WINDOW_MS;
        this.scheduleIceRepair();
      }
    } catch (err) {
      // A partially constructed peer (e.g. createDataChannel threw after the
      // first channel attached) must not leave fabric zombies behind.
      if (fabricLink) this.fabric.detachPeer(peerId);
      this.onError(peerId, 'addPeer', err);
    }
  }

  private removePeer(key: string): void {
    const peer = this.peerMap.get(key);
    if (peer === undefined) return;
    this.peerMap.delete(key);
    try {
      peer.negotiator.dispose();
      peer.pc.ontrack = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.ondatachannel = null;
      peer.pc.close();
    } catch (err) {
      this.onError(peer.userId, 'removePeer', err);
    }
    if (this.lane === null && peer.lane === null) this.fabric.detachPeer(peer.userId);
    // 'closed' means the PERSON has nothing left — callers drop their retained
    // tracks on it. A share ending while its owner is still on the call must
    // therefore not announce it; the call's own state is re-announced instead.
    if (this.hasEndpoints(peer.userId)) {
      this.reportState(peer.userId);
      this.reportLink(peer.userId);
      return;
    }
    this.reportedStates.delete(peer.userId);
    this.reportedLinks.delete(peer.userId);
    for (const fn of [...this.stateSubs]) fn(peer.userId, 'closed');
  }

  private hasEndpoints(userId: UserId): boolean {
    for (const peer of this.peerMap.values()) {
      if (peer.userId === userId) return true;
    }
    return false;
  }

  /** The best state across a person's endpoints — see {@link STATE_RANK} —
   *  or undefined when they hold none. */
  private stateOf(userId: UserId): MeshConnectionState | undefined {
    let best: MeshConnectionState | undefined;
    for (const peer of this.peerMap.values()) {
      if (peer.userId !== userId) continue;
      if (best === undefined || STATE_RANK[peer.state] > STATE_RANK[best]) best = peer.state;
    }
    return best;
  }

  /** Announce a person's connection state, when the fold over their endpoints
   *  has actually moved. Someone with two endpoints must produce one stream of
   *  events, not two interleaved ones a subscriber would see flap. */
  private reportState(userId: UserId): void {
    const state = this.stateOf(userId);
    if (state === undefined) return;
    if (this.reportedStates.get(userId) === state) return;
    this.reportedStates.set(userId, state);
    for (const fn of [...this.stateSubs]) fn(userId, state);
  }

  /** Announce a person's link path, when the fold over their endpoints has
   *  actually moved. */
  private reportLink(userId: UserId): void {
    if (!this.hasEndpoints(userId)) return;
    const state = this.linkState(userId);
    if (this.reportedLinks.get(userId) === state) return;
    this.reportedLinks.set(userId, state);
    for (const fn of [...this.linkSubs]) fn(userId, state);
  }

  private applyTrackToPeer(
    peer: MeshPeer,
    role: TrackRole,
    track: MediaStreamTrackLike | null,
  ): void {
    const sender = peer.senders.get(role);
    if (track === null) {
      if (sender === undefined) return;
      // Mute, do not demolish. `removeTrack` retires the transceiver and forces
      // a full renegotiation, and on a sendrecv m-line that disturbs the
      // RECEIVE direction too — turning your own camera off could stop the
      // remote camera arriving on that line. Turning it back on then added a
      // second renegotiation immediately behind the first, and whichever one
      // glare handling discarded, the camera did not come back until you
      // toggled again. `replaceTrack(null)` keeps the sender and the
      // transceiver, needs NO renegotiation at all, and re-arms instantly when
      // a track returns through the replaceTrack branch below.
      if (sender.replaceTrack !== undefined) {
        sender.replaceTrack(null).catch((err: unknown) => {
          this.onError(peer.userId, 'replaceTrack', err);
        });
        if (role === 'share') peer.capApplied = false;
        return;
      }
      // No replaceTrack on this platform: the old teardown is the only option.
      peer.pc.removeTrack(sender);
      peer.senders.delete(role);
      if (role === 'share') peer.capApplied = false;
      return;
    }
    if (sender === undefined) {
      peer.senders.set(role, peer.pc.addTrack(track));
      // Preflight payoff: on a link already classified relayed, the brand-new
      // share sender is capped before its first frame, not at the next poll.
      if (role === 'share') {
        peer.capApplied = false;
        this.reconcileShareCap(peer);
      }
      return;
    }
    if (sender.replaceTrack !== undefined) {
      // Same sender, same parameters: an existing cap survives the swap.
      sender.replaceTrack(track).catch((err: unknown) => {
        // A failed swap leaves the old track publishing, which is strictly
        // safer than dropping the role.
        this.onError(peer.userId, 'replaceTrack', err);
      });
      return;
    }
    peer.pc.removeTrack(sender);
    peer.senders.set(role, peer.pc.addTrack(track));
    if (role === 'share') {
      peer.capApplied = false;
      this.reconcileShareCap(peer);
    }
  }

  /** Fold one poll's classification into the reported link state. Same-state
   *  polls are silent; a KNOWN state demotes to 'unknown' only after
   *  UNKNOWN_POLLS_TO_DEMOTE consecutive unknown reads (ICE-restart flap
   *  damping), while direct<->relayed transitions report immediately. */
  private noteLinkClassification(peer: MeshPeer, next: MeshLinkState): void {
    if (next === peer.linkState) {
      peer.unknownStreak = 0;
      return;
    }
    if (next === 'unknown') {
      peer.unknownStreak += 1;
      if (peer.unknownStreak < UNKNOWN_POLLS_TO_DEMOTE) return;
    }
    peer.unknownStreak = 0;
    peer.linkState = next;
    this.reportLink(peer.userId);
    this.reconcileShareCap(peer);
  }

  /** Bring the 'share' sender's relay cap in line with the reported link
   *  state, when an operator configured one at all (capRelayedVideoKbps —
   *  nothing in the product sets it): cap on 'relayed', uncap on 'direct',
   *  leave 'unknown' as-is (an uncertain path keeps whatever cap it has).
   *  setParameters is async and may reject; a rejection surfaces via onError
   *  and never interrupts the share. */
  private reconcileShareCap(peer: MeshPeer): void {
    if (this.capRelayedVideoKbps === undefined) return;
    const capBps = this.capRelayedVideoKbps * 1000;
    const sender = peer.senders.get('share');
    if (sender === undefined) return;
    if (peer.linkState === 'relayed' && !peer.capApplied) {
      peer.capApplied = true;
      applyMaxBitrate(sender, capBps).catch((err: unknown) => {
        this.onError(peer.userId, 'shareCap', err);
      });
    } else if (peer.linkState === 'direct' && peer.capApplied) {
      peer.capApplied = false;
      clearMaxBitrate(sender, capBps).catch((err: unknown) => {
        this.onError(peer.userId, 'shareCap', err);
      });
    }
  }
}
