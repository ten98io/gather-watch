/**
 * CallMesh — wires @playin/p2p's MeshManager to the browser: native
 * RTCPeerConnection, TURN credentials from the API (TurnCredentialManager
 * keeps them fresh), signaling over the room's shared RoomConnection
 * (webrtc.offer/answer/ice), and peer-set reconciliation from presence.
 *
 * One per room; created lazily by the panes that need media (the call
 * surface, Mode B share) so a room that never calls never opens a peer
 * connection.
 *
 * TRACK RETENTION (the reason "you join and see nobody" was unfixable in the
 * UI alone): `pc.ontrack` fires exactly once per track, whenever the peer
 * connection happens to negotiate it. A React pane that subscribes later —
 * because it mounted later, remounted on a layout change, or only mounts once
 * you press Join — used to miss every track that had already arrived, and
 * nothing ever re-delivered them. This class therefore subscribes to the mesh
 * ONCE in its constructor, keeps the live tracks, and replays them to every
 * new subscriber. Same for local tracks, so a remounted tile grid still finds
 * your own camera.
 */
import { MeshManager, TurnCredentialManager } from '@playin/p2p';
import type {
  IceServerLike,
  MeshConnectionState,
  RtcPeerConnectionLike,
  TrackRole,
} from '@playin/p2p';
import { GetEntitlementsResponse } from '@playin/contracts';
import type { Plan, UserId } from '@playin/contracts';
import { api, apiFetch } from './api';
import type { RoomConnection } from './room-connection';

const browserRtcFactory = (config: { iceServers: IceServerLike[] }): RtcPeerConnectionLike =>
  new RTCPeerConnection({
    iceServers: config.iceServers as RTCIceServer[],
  }) as unknown as RtcPeerConnectionLike;

/** Free-tier ceiling for a screen-share encode over a relayed link
 *  (docs/COST_MODEL.md: an uncapped relayed share costs the operator close to
 *  the full premium price, so the free plan degrades instead of refusing). */
export const FREE_SHARE_RELAY_KBPS = 400;

/** Link classification happens only inside MeshManager.pollStats(), and the
 *  app layer owns the interval — without this cadence the cap never applies. */
const LINK_POLL_MS = 5_000;

/** Shown once per share, only on a capped plan over a relayed link. The
 *  extension's share reply carries this exact sentence too — keep them in step. */
export const SHARE_RELAY_NOTE =
  'Sharing at reduced quality on this connection — Premium removes the limit.';

/* The account plan gates the relay cap. Fail-closed: until the plan is known
   to be premium, shares are capped — an undetermined plan is the operator's
   cost risk, and the premium path must be explicit. */
let sharePlan: Plan | null = null;
let sharePlanFetch: Promise<void> | null = null;

/** Seed the plan directly (tests, or a caller that already has entitlements). */
export function seedSharePlan(plan: Plan | null): void {
  sharePlan = plan;
}

/** Resolve the plan in the background. Cheap to call often; a failed fetch
 *  leaves the plan unknown (capped) and the next call retries. */
export function primeSharePlan(): void {
  if (sharePlan !== null || sharePlanFetch !== null) return;
  sharePlanFetch = apiFetch('/billing/entitlements', { schema: GetEntitlementsResponse })
    .then((res) => {
      sharePlan = res.entitlements.plan;
    })
    .catch(() => undefined)
    .finally(() => {
      sharePlanFetch = null;
    });
}

/** A remote track and the peer publishing it. */
export interface RemoteTrackEntry {
  userId: UserId;
  track: MediaStreamTrack;
}

type RemoteTrackListener = (source: UserId, track: MediaStreamTrack) => void;
type LocalTrackListener = (role: TrackRole, track: MediaStreamTrack | null) => void;

export class CallMesh {
  private readonly mesh: MeshManager;
  private readonly turn: TurnCredentialManager;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly localTrackSubs = new Set<LocalTrackListener>();
  private readonly remoteTrackSubs = new Set<RemoteTrackListener>();
  private readonly remoteTrackRemovedSubs = new Set<RemoteTrackListener>();
  /** Live remote tracks, per peer, keyed by track id (replayed to new subs). */
  private readonly remoteTracks = new Map<UserId, Map<string, MediaStreamTrack>>();
  /** Live local tracks by role (replayed to new subs). */
  private readonly localTracks = new Map<TrackRole, MediaStreamTrack>();
  private started = false;
  private closedFlag = false;
  /** Whether this mesh carries the free-tier relay cap. Fixed at construction —
   *  MeshManager takes the cap as a constructor option — from the plan known
   *  at that moment (unknown counts as capped). */
  private readonly relayCapped: boolean;
  private pollHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly conn: RoomConnection,
    private readonly localUserId: UserId,
  ) {
    this.relayCapped = sharePlan !== 'premium';
    this.turn = new TurnCredentialManager({
      getTurnCredentials: () => api.rtc.turnCredentials(),
      now: () => Date.now(),
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      clearTimeoutFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    this.mesh = new MeshManager({
      roomId: conn.roomId,
      localUserId,
      rtcFactory: browserRtcFactory,
      send: (event) => {
        conn.rawSocket.send(event.type, event.payload);
      },
      getIceServers: () => this.turn.iceServers(),
      now: () => Date.now(),
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      clearTimeoutFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onError: () => {
        // Per-link failures are surfaced through connectionStates(); the room
        // stays usable when one peer can't be reached.
      },
      ...(this.relayCapped ? { capRelayedVideoKbps: FREE_SHARE_RELAY_KBPS } : {}),
    });

    // Retention starts at construction, BEFORE any pane subscribes — a track
    // that lands while the rail is closed is still there when it opens.
    this.unsubscribers.push(
      this.mesh.onRemoteTrack((peerId, raw) => {
        const track = raw as unknown as MediaStreamTrack;
        this.retainRemote(peerId, track);
      }),
    );
    this.unsubscribers.push(
      this.mesh.onConnectionState((peerId, state) => {
        // A closed connection ends its receivers' tracks; drop ours too so a
        // peer who leaves and returns does not resurrect a dead tile.
        if (state === 'closed') this.dropPeer(peerId);
      }),
    );
  }

  /** Begin presence-following + signal routing. Idempotent. */
  start(): void {
    if (this.started || this.closedFlag) return;
    this.started = true;
    void this.turn.start();

    // Reconcile the mesh toward whoever is present (non-offline).
    const applyPresence = (): void => {
      this.mesh.applyPresence(Object.values(this.conn.useRoomState.getState().presence));
    };
    applyPresence();
    this.unsubscribers.push(
      this.conn.useRoomState.subscribe((s, prev) => {
        if (s.presence !== prev.presence) applyPresence();
      }),
    );

    for (const type of ['webrtc.offer', 'webrtc.answer', 'webrtc.ice'] as const) {
      this.unsubscribers.push(
        this.conn.on(type, (ev) => {
          this.mesh.handleSignal(ev);
        }),
      );
    }

    // Polling starts with the mesh, not with a share: the pre-share (voice)
    // link must already be classified so a share onto a relayed link is
    // capped before its first frame.
    this.schedulePoll();
  }

  /**
   * Run one link-stats poll now (classification and the relay cap both live in
   * the p2p layer and only advance inside pollStats). A premium plan never
   * polls: its links may stay 'unknown', and skipping the poll also keeps a
   * mesh that was built before the plan resolved from ever applying its cap.
   */
  async pollLinkStats(): Promise<void> {
    if (this.closedFlag || sharePlan === 'premium') return;
    await this.mesh.pollStats();
  }

  /**
   * Notify AT MOST ONCE when a share from this mesh is (or becomes) limited
   * because a link runs relayed on a capped plan. Links that were already
   * relayed when the share started never re-fire onLinkState, so the snapshot
   * is checked first. Never fires on premium, even when premium resolved after
   * this mesh was built.
   */
  onShareRelayed(fn: () => void): () => void {
    if (!this.relayCapped) return () => undefined;
    for (const state of this.mesh.linkStates().values()) {
      if (state === 'relayed' && sharePlan !== 'premium') {
        fn();
        return () => undefined;
      }
    }
    let fired = false;
    return this.mesh.onLinkState((_peerId, state) => {
      if (fired || state !== 'relayed' || sharePlan === 'premium') return;
      fired = true;
      fn();
    });
  }

  private schedulePoll(): void {
    if (this.closedFlag) return;
    this.pollHandle = setTimeout(() => {
      void this.pollLinkStats()
        .catch(() => undefined)
        .then(() => {
          this.schedulePoll();
        });
    }, LINK_POLL_MS);
  }

  /** True once close() ran; a closed mesh is inert and must be replaced. */
  get closed(): boolean {
    return this.closedFlag;
  }

  /**
   * Publish/replace/remove a local track for a role on every peer link.
   *
   * Publishing mid-call is the interesting case: MeshManager adds the track to
   * every EXISTING RTCPeerConnection, which fires `negotiationneeded` and the
   * perfect negotiator re-offers — so turning the camera on reaches the people
   * already in the call, not only whoever joins afterwards.
   */
  setLocalTrack(role: TrackRole, track: MediaStreamTrack | null): void {
    if (this.closedFlag) return;
    if (track === null) this.localTracks.delete(role);
    else this.localTracks.set(role, track);
    this.mesh.setLocalTrack(role, track as unknown as Parameters<MeshManager['setLocalTrack']>[1]);
    for (const fn of [...this.localTrackSubs]) fn(role, track);
  }

  /** The live local track for a role, if any. */
  localTrack(role: TrackRole): MediaStreamTrack | null {
    return this.localTracks.get(role) ?? null;
  }

  /**
   * Local track changes (own camera preview). New subscribers are replayed the
   * tracks that are already live, so a remounted grid still shows your camera.
   */
  onLocalTrack(fn: LocalTrackListener): () => void {
    this.localTrackSubs.add(fn);
    for (const [role, track] of this.localTracks) fn(role, track);
    return () => {
      this.localTrackSubs.delete(fn);
    };
  }

  /**
   * Subscribe to remote tracks; `source` is the publishing user id. Tracks
   * that arrived before this call are replayed immediately.
   */
  onRemoteTrack(fn: RemoteTrackListener): () => void {
    this.remoteTrackSubs.add(fn);
    for (const [userId, tracks] of this.remoteTracks) {
      for (const track of tracks.values()) fn(userId, track);
    }
    return () => {
      this.remoteTrackSubs.delete(fn);
    };
  }

  /** Subscribe to remote tracks going away (ended, or the peer disconnected). */
  onRemoteTrackRemoved(fn: RemoteTrackListener): () => void {
    this.remoteTrackRemovedSubs.add(fn);
    return () => {
      this.remoteTrackRemovedSubs.delete(fn);
    };
  }

  /** Snapshot of the live remote tracks (post-replay reads, tests). */
  remoteTrackList(): RemoteTrackEntry[] {
    const out: RemoteTrackEntry[] = [];
    for (const [userId, tracks] of this.remoteTracks) {
      for (const track of tracks.values()) out.push({ userId, track });
    }
    return out;
  }

  /** Per-peer connection states (diagnostics / uplink honesty). */
  connectionStates(): Map<UserId, MeshConnectionState> {
    return this.mesh.connectionStates();
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    if (this.pollHandle !== null) {
      clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    for (const off of this.unsubscribers.splice(0)) off();
    this.mesh.close();
    this.turn.stop();
    this.started = false;
    this.remoteTracks.clear();
    this.localTracks.clear();
    this.remoteTrackSubs.clear();
    this.remoteTrackRemovedSubs.clear();
    this.localTrackSubs.clear();
  }

  // ---------- internals ----------

  private retainRemote(peerId: UserId, track: MediaStreamTrack): void {
    let byId = this.remoteTracks.get(peerId);
    if (byId === undefined) {
      byId = new Map();
      this.remoteTracks.set(peerId, byId);
    }
    if (byId.get(track.id) === track) return; // same track re-delivered
    byId.set(track.id, track);
    const onEnded = (): void => {
      track.removeEventListener('ended', onEnded);
      this.forgetRemote(peerId, track);
    };
    track.addEventListener('ended', onEnded);
    for (const fn of [...this.remoteTrackSubs]) fn(peerId, track);
  }

  private forgetRemote(peerId: UserId, track: MediaStreamTrack): void {
    const byId = this.remoteTracks.get(peerId);
    if (byId === undefined || !byId.has(track.id)) return;
    byId.delete(track.id);
    if (byId.size === 0) this.remoteTracks.delete(peerId);
    for (const fn of [...this.remoteTrackRemovedSubs]) fn(peerId, track);
  }

  private dropPeer(peerId: UserId): void {
    const byId = this.remoteTracks.get(peerId);
    if (byId === undefined) return;
    for (const track of [...byId.values()]) this.forgetRemote(peerId, track);
  }

  /** The user this mesh publishes as (asserted by the signaling server). */
  get userId(): UserId {
    return this.localUserId;
  }
}

/* Lazy per-connection registry: panes share one mesh per room connection. */
const meshes = new WeakMap<RoomConnection, CallMesh>();

export function getCallMesh(conn: RoomConnection, localUserId: UserId): CallMesh {
  // Kick the plan lookup on every acquire: the earlier it resolves, the more
  // likely the mesh a premium share rides was built uncapped.
  primeSharePlan();
  const existing = meshes.get(conn);
  // A closed mesh is inert (StrictMode double-effects close then re-acquire),
  // so replace it rather than hand back a dead one.
  if (existing !== undefined && !existing.closed) return existing;
  const mesh = new CallMesh(conn, localUserId);
  meshes.set(conn, mesh);
  return mesh;
}

/** Tear the room's mesh down (room unmount). Safe to call more than once. */
export function closeCallMesh(conn: RoomConnection): void {
  const mesh = meshes.get(conn);
  if (mesh === undefined) return;
  meshes.delete(conn);
  mesh.close();
}
