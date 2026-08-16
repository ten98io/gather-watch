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
  RtcFactory,
  RtcPeerConnectionLike,
  RtpSenderLike,
  SetTimeoutFn,
  SignalSend,
  TrackRole,
} from './types';

/** Per-peer connection state exposed to subscribers. */
export type MeshConnectionState = ConnectionStateLike;

/** Options for {@link MeshManager}. */
export interface MeshManagerOptions {
  roomId: RoomId;
  localUserId: UserId;
  /** Injected platform peer-connection factory. */
  rtcFactory: RtcFactory;
  /** Outbound signaling transport (room WS). */
  send: SignalSend;
  /** Fresh ICE servers spliced into every NEW RTCPeerConnection
   *  (typically TurnCredentialManager.iceServers). Default: () => []. */
  getIceServers?: () => IceServerLike[];
  now: NowFn;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  /** Per-link stats poll implementation; defaults to pc.getStats?.(). */
  statsPollFn?: (pc: RtcPeerConnectionLike) => Promise<unknown>;
  /** When set, the 'share' sender on any RELAYED link is bitrate-capped to
   *  this many kbps (maxBitrate on every encoding), and uncapped again when
   *  the link becomes 'direct'. Voice ('mic') is never capped. A share to a
   *  peer whose link has not been classified yet — a brand-new connection —
   *  runs uncapped for up to one pollStats interval, until the first poll
   *  classifies the link; a share started on an existing relayed link is
   *  capped from the first frame. */
  capRelayedVideoKbps?: number;
  /** Negotiation errors etc. surface here. */
  onError?: (peerId: UserId, context: string, err: unknown) => void;
  fabricOptions?: ChannelFabricOptions;
}

/** Everything the mesh keeps per remote peer. */
interface MeshPeer {
  pc: RtcPeerConnectionLike;
  negotiator: PerfectNegotiator;
  senders: Map<TrackRole, RtpSenderLike>;
  state: MeshConnectionState;
  connectionId: string;
  /** Last REPORTED link path (post-debounce), not the raw last classification. */
  linkState: MeshLinkState;
  /** Consecutive 'unknown' classifications while linkState is known. */
  unknownStreak: number;
  /** Whether the relay cap was pushed onto the current 'share' sender. */
  capApplied: boolean;
}

/** The fixed channel labels created pre-negotiated on every connection. */
const FABRIC_LABELS: readonly ChannelLabel[] = ['sync', 'file', 'emote'];

/** A known link state only demotes to 'unknown' after this many consecutive
 *  unknown classifications — stats gaps during ICE restarts are transient and
 *  must not flap the reported state (or the user-facing copy) every poll. */
const UNKNOWN_POLLS_TO_DEMOTE = 2;

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
  private readonly rtcFactory: RtcFactory;
  private readonly send: SignalSend;
  private readonly getIceServers: () => IceServerLike[];
  private readonly now: NowFn;
  private readonly statsPollFn: ((pc: RtcPeerConnectionLike) => Promise<unknown>) | undefined;
  private readonly capRelayedVideoKbps: number | undefined;
  private readonly onError: (peerId: UserId, context: string, err: unknown) => void;

  private readonly peerMap = new Map<UserId, MeshPeer>();
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
    this.rtcFactory = opts.rtcFactory;
    this.send = opts.send;
    this.getIceServers = opts.getIceServers ?? (() => []);
    this.now = opts.now;
    this.statsPollFn = opts.statsPollFn;
    this.capRelayedVideoKbps = opts.capRelayedVideoKbps;
    this.onError = opts.onError ?? (() => {});
    this.fabric = new ChannelFabric(opts.fabricOptions);
  }

  /** Reconcile toward the desired remote-peer set (adds + removes). */
  syncPeers(userIds: UserId[]): void {
    if (this.closed) return;
    const desired = new Set(userIds);
    for (const peerId of desired) {
      if (peerId === this.localUserId) continue;
      if (!this.peerMap.has(peerId)) this.addPeer(peerId);
    }
    for (const peerId of [...this.peerMap.keys()]) {
      if (!desired.has(peerId)) this.removePeer(peerId);
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

  /** Route a server-relayed webrtc.* event to the right negotiator. Signals for
   *  unknown peers or stale connectionIds are dropped. */
  handleSignal(ev: InboundSignal): void {
    const peer = this.peerMap.get(ev.payload.fromUserId);
    if (peer === undefined) return;
    if (ev.payload.connectionId !== peer.connectionId) return;
    peer.negotiator.handleSignal(ev).catch((err: unknown) => {
      this.onError(ev.payload.fromUserId, 'signal', err);
    });
  }

  /** Publish/replace/remove a local media track for a role on every current and
   *  future peer connection. null removes. */
  setLocalTrack(role: TrackRole, track: MediaStreamTrackLike | null): void {
    if (track === null) {
      this.localTracks.delete(role);
    } else {
      this.localTracks.set(role, track);
    }
    for (const [peerId, peer] of this.peerMap) {
      try {
        this.applyTrackToPeer(peerId, peer, role, track);
      } catch (err) {
        this.onError(peerId, 'setLocalTrack', err);
      }
    }
  }

  /** Snapshot of per-peer connection states. */
  connectionStates(): Map<UserId, MeshConnectionState> {
    const out = new Map<UserId, MeshConnectionState>();
    for (const [peerId, peer] of this.peerMap) out.set(peerId, peer.state);
    return out;
  }

  /** Currently connected (or connecting) remote peers. */
  peers(): UserId[] {
    return [...this.peerMap.keys()];
  }

  /** Poll per-link stats via statsPollFn (or pc.getStats). Peers whose poll
   *  rejects or lacks getStats are omitted. Each successful poll also
   *  classifies the link path (direct/relayed/unknown) from the selected
   *  candidate pair and drives the relay share cap. */
  async pollStats(): Promise<Map<UserId, unknown>> {
    const out = new Map<UserId, unknown>();
    await Promise.all(
      [...this.peerMap.entries()].map(async ([peerId, peer]) => {
        try {
          let stats: unknown;
          if (this.statsPollFn !== undefined) {
            stats = await this.statsPollFn(peer.pc);
          } else {
            if (peer.pc.getStats === undefined) return;
            stats = await peer.pc.getStats();
          }
          if (stats !== undefined) out.set(peerId, stats);
          // The peer may have been removed while the poll was in flight.
          if (this.peerMap.get(peerId) !== peer) return;
          this.noteLinkClassification(peerId, peer, classifyLinkStats(stats));
        } catch (err) {
          this.onError(peerId, 'pollStats', err);
        }
      }),
    );
    return out;
  }

  /** Snapshot of per-peer link path states (post-debounce). */
  linkStates(): Map<UserId, MeshLinkState> {
    const out = new Map<UserId, MeshLinkState>();
    for (const [peerId, peer] of this.peerMap) out.set(peerId, peer.linkState);
    return out;
  }

  /** Preflight for Mode B: the link path of a peer ALREADY connected (e.g.
   *  for voice), answered from the last completed stats poll — so whether a
   *  share would be relay-capped is known BEFORE the share track is added.
   *  'unknown' for unknown peers, and for links no poll has classified yet:
   *  a share to such a peer may run uncapped for up to one poll interval. */
  linkState(peerId: UserId): MeshLinkState {
    return this.peerMap.get(peerId)?.linkState ?? 'unknown';
  }

  /** Subscribe to per-peer link path CHANGES (debounced — one event per
   *  reported transition, never one per poll). Return unsubscribe. */
  onLinkState(fn: (peerId: UserId, state: MeshLinkState) => void): () => void {
    this.linkSubs.add(fn);
    return () => {
      this.linkSubs.delete(fn);
    };
  }

  /** Trigger an ICE restart on one peer connection. */
  restartIce(peerId: UserId): void {
    this.peerMap.get(peerId)?.negotiator.restartIce();
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
    for (const peerId of [...this.peerMap.keys()]) this.removePeer(peerId);
    this.fabric.close();
    this.trackSubs.clear();
    this.stateSubs.clear();
    this.linkSubs.clear();
    this.localTracks.clear();
  }

  // ---------- internals ----------

  /** Stable connection id for a pair: identical on both sides. */
  private connectionIdFor(peerId: UserId): string {
    const [a, b] =
      this.localUserId < peerId ? [this.localUserId, peerId] : [peerId, this.localUserId];
    return `mesh:${this.roomId}:${a}~${b}`;
  }

  private addPeer(peerId: UserId): void {
    try {
      const pc = this.rtcFactory({ iceServers: this.getIceServers() });
      const connectionId = this.connectionIdFor(peerId);

      // Pre-negotiated fabric channels: both sides create the same fixed ids,
      // so no in-band datachannel negotiation is needed.
      for (const label of FABRIC_LABELS) {
        const dc = pc.createDataChannel(label, {
          negotiated: true,
          id: CHANNEL_IDS[label],
          ordered: true,
        });
        this.fabric.attach(peerId, label, dc);
      }

      const negotiator = new PerfectNegotiator({
        pc,
        roomId: this.roomId,
        localUserId: this.localUserId,
        remoteUserId: peerId,
        connectionId,
        send: this.send,
        now: this.now,
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
        linkState: 'unknown',
        unknownStreak: 0,
        capApplied: false,
      };
      this.peerMap.set(peerId, peer);

      pc.ontrack = (ev) => {
        for (const fn of [...this.trackSubs]) fn(peerId, ev.track, ev.streams);
      };
      pc.onconnectionstatechange = () => {
        peer.state = pc.connectionState;
        for (const fn of [...this.stateSubs]) fn(peerId, peer.state);
        if (peer.state === 'failed') negotiator.restartIce();
      };
      // Defensive: a non-negotiated inbound channel with a known label joins
      // the fabric like any other.
      pc.ondatachannel = (ev) => {
        const label = ev.channel.label;
        if (label === 'sync' || label === 'file' || label === 'emote') {
          this.fabric.attach(peerId, label, ev.channel);
        }
      };

      // Tracks published before this peer existed join its connection now.
      for (const [role, track] of this.localTracks) {
        peer.senders.set(role, pc.addTrack(track));
      }
    } catch (err) {
      // A partially constructed peer (e.g. createDataChannel threw after the
      // first channel attached) must not leave fabric zombies behind.
      this.fabric.detachPeer(peerId);
      this.onError(peerId, 'addPeer', err);
    }
  }

  private removePeer(peerId: UserId): void {
    const peer = this.peerMap.get(peerId);
    if (peer === undefined) return;
    this.peerMap.delete(peerId);
    try {
      peer.negotiator.dispose();
      peer.pc.ontrack = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.ondatachannel = null;
      peer.pc.close();
    } catch (err) {
      this.onError(peerId, 'removePeer', err);
    }
    this.fabric.detachPeer(peerId);
    for (const fn of [...this.stateSubs]) fn(peerId, 'closed');
  }

  private applyTrackToPeer(
    peerId: UserId,
    peer: MeshPeer,
    role: TrackRole,
    track: MediaStreamTrackLike | null,
  ): void {
    const sender = peer.senders.get(role);
    if (track === null) {
      if (sender !== undefined) {
        peer.pc.removeTrack(sender);
        peer.senders.delete(role);
        if (role === 'share') peer.capApplied = false;
      }
      return;
    }
    if (sender === undefined) {
      peer.senders.set(role, peer.pc.addTrack(track));
      // Preflight payoff: on a link already classified relayed, the brand-new
      // share sender is capped before its first frame, not at the next poll.
      if (role === 'share') {
        peer.capApplied = false;
        this.reconcileShareCap(peerId, peer);
      }
      return;
    }
    if (sender.replaceTrack !== undefined) {
      // Same sender, same parameters: an existing cap survives the swap.
      sender.replaceTrack(track).catch((err: unknown) => {
        // A failed swap leaves the old track publishing, which is strictly
        // safer than dropping the role.
        this.onError(peerId, 'replaceTrack', err);
      });
      return;
    }
    peer.pc.removeTrack(sender);
    peer.senders.set(role, peer.pc.addTrack(track));
    if (role === 'share') {
      peer.capApplied = false;
      this.reconcileShareCap(peerId, peer);
    }
  }

  /** Fold one poll's classification into the reported link state. Same-state
   *  polls are silent; a KNOWN state demotes to 'unknown' only after
   *  UNKNOWN_POLLS_TO_DEMOTE consecutive unknown reads (ICE-restart flap
   *  damping), while direct<->relayed transitions report immediately. */
  private noteLinkClassification(peerId: UserId, peer: MeshPeer, next: MeshLinkState): void {
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
    for (const fn of [...this.linkSubs]) fn(peerId, next);
    this.reconcileShareCap(peerId, peer);
  }

  /** Bring the 'share' sender's relay cap in line with the reported link
   *  state: cap on 'relayed', uncap on 'direct', leave 'unknown' as-is (an
   *  uncertain path keeps whatever cap it has — cost-safe). setParameters is
   *  async and may reject; a rejection surfaces via onError and never
   *  interrupts the share. */
  private reconcileShareCap(peerId: UserId, peer: MeshPeer): void {
    if (this.capRelayedVideoKbps === undefined) return;
    const capBps = this.capRelayedVideoKbps * 1000;
    const sender = peer.senders.get('share');
    if (sender === undefined) return;
    if (peer.linkState === 'relayed' && !peer.capApplied) {
      peer.capApplied = true;
      applyMaxBitrate(sender, capBps).catch((err: unknown) => {
        this.onError(peerId, 'shareCap', err);
      });
    } else if (peer.linkState === 'direct' && peer.capApplied) {
      peer.capApplied = false;
      clearMaxBitrate(sender, capBps).catch((err: unknown) => {
        this.onError(peerId, 'shareCap', err);
      });
    }
  }
}
