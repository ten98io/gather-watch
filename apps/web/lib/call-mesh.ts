/**
 * CallMesh — wires @gather/p2p's MeshManager to the browser: native
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
 *
 * CREDENTIALS BEFORE PEERS (the "join, refresh the tab, join again" bug): an
 * RTCPeerConnection reads its ICE servers ONCE, at construction — WebRTC has
 * no way to hand a live connection a TURN server afterwards. start() used to
 * kick the credential fetch off and reconcile the peer set in the same tick,
 * so every peer built in the first round trip was permanently TURN-less and
 * only connected if both ends happened to be reachable directly. Reloading the
 * tab was the only thing that rebuilt those connections after the credentials
 * had landed — which is exactly what the owner found by hand. Reconciliation
 * now waits for the first credential attempt to SETTLE (succeed or fail), and
 * the wait is bounded so a hung fetch degrades the call instead of wedging it.
 */
import { MeshManager, TurnCredentialManager } from '@gather/p2p';
import type {
  IceServerLike,
  MediaStreamLike,
  MeshConnectionState,
  MeshLinkState,
  RtcPeerConnectionLike,
  TrackRole,
} from '@gather/p2p';
import type { UserId } from '@gather/contracts';
import { api } from './api';
import type { RoomConnection } from './room-connection';

const browserRtcFactory = (config: { iceServers: IceServerLike[] }): RtcPeerConnectionLike =>
  new RTCPeerConnection({
    iceServers: config.iceServers as RTCIceServer[],
  }) as unknown as RtcPeerConnectionLike;

/** One MediaStream per published ROLE, so the far side can name what it is
 *  receiving. The mesh reads only `.id` — the id is what rides in the SDP's
 *  msid and reaches the receiver's `ev.streams`. */
const browserMediaStreamFactory = (): MediaStreamLike => new MediaStream();

/** Link classification happens only inside MeshManager.pollStats(), and the
 *  app layer owns the interval — connection diagnostics read the result. */
const LINK_POLL_MS = 5_000;

/**
 * This TAB's endpoint token, generated once per page load.
 *
 * A UserId names a person, and one person is routinely in a room from two
 * places at once — laptop and phone, or two tabs of the same browser. Both used
 * to derive the same mesh connectionId, so the far side held ONE peer
 * connection for the pair: each device's offer re-pointed its single ICE agent
 * at the other, and the call flipped between them for as long as both stayed
 * open. It needed no "join call" to happen — the room shell starts the mesh,
 * and the fabric DataChannels make it negotiate with no media on it at all.
 *
 * Per PAGE rather than per CallMesh on purpose: a mesh that is closed and
 * re-acquired (StrictMode's double effect, a room remount) is the same tab, and
 * re-using the token keeps the connectionId it derives stable — which is what
 * lets the far side re-establish over the peer it already holds instead of
 * building another one and leaving the old to time out.
 */
const ENDPOINT_TOKEN = makeEndpointToken();

/** A token the mesh will accept: `[A-Za-z0-9_-]{1,64}`, so it survives being
 *  concatenated into a connectionId and compared whole. randomUUID is the
 *  cheap source of one; the fallback covers insecure origins, where
 *  `crypto.randomUUID` is not exposed at all. */
function makeEndpointToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return uuid;
  return `e${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * How long peer construction waits for the first TURN credential answer.
 *
 * The wait exists so peers are built WITH relay servers; the bound exists
 * because a fetch has no timeout of its own. A request that never answers must
 * cost the call a few degraded seconds, never the call itself — the room is
 * already open and the people in it are waiting.
 */
export const CREDENTIAL_WAIT_MS = 4_000;

/**
 * TURN credentials are what let two people on different networks reach each
 * other at all. Without them a call still works between two devices on one
 * network and fails on most others — so the sentence promises exactly that
 * much and no more.
 */
export const CALL_SETUP_NOTE =
  'Trouble setting up the call — people on other networks may not be able to hear or see you.';

/** A link that carried media died. MeshManager restarts ICE on it — on 'failed'
 *  at once, on 'disconnected' after a grace window — so "trying to get it back"
 *  is a description of what is happening, not hope. */
export const CALL_PEER_NOTE =
  'Lost the connection to someone in the call — trying to get it back.';

/**
 * The recovery budget ran out.
 *
 * The mesh restarts ICE a bounded number of times and then stops, because
 * restarting forever at a path that is genuinely gone is indistinguishable
 * from a working recovery: the tile says "trying to get it back" at a link
 * that never comes back. Once it stops, the honest thing to say is that it
 * stopped, and the only remaining move is the user's.
 */
export const CALL_PEER_LOST_NOTE =
  'Could not get the connection back to someone in the call — reloading the page usually fixes it.';

/**
 * How long someone keeps receiving our camera and microphone after presence
 * stops calling them 'in-call'.
 *
 * Presence blips: a client that re-announces 'watching' or 'listening' for its
 * own reasons overwrites its own call state for about a round trip. Pulling the
 * camera on that would cost two renegotiations and a black tile every time
 * somebody's queue moved between music and video. Short enough that a person
 * who genuinely left the call stops receiving a camera within seconds — which
 * is the entire point of publishing by membership.
 */
export const PUBLISH_BRIDGE_MS = 6_000;

/** A remote track and the peer publishing it. */
export interface RemoteTrackEntry {
  userId: UserId;
  track: MediaStreamTrack;
}

/** What kind of failure a note describes; one note per kind, per mesh. */
type FailureKind = 'setup' | 'peer' | 'peer-lost';

/**
 * A remote track arriving or leaving. `role` is what the publisher said it is,
 * or null when the mesh genuinely cannot tell — an older client that announces
 * nothing, or an announcement that never landed. Null is not a guess: a
 * listener's answer to it must be whatever it did before roles existed.
 */
type RemoteTrackListener = (
  source: UserId,
  track: MediaStreamTrack,
  role: TrackRole | null,
) => void;
type LocalTrackListener = (role: TrackRole, track: MediaStreamTrack | null) => void;
type FailureListener = (note: string) => void;
type ConnectionStateListener = (peerId: UserId, state: MeshConnectionState) => void;
type LinkStateListener = (peerId: UserId, state: MeshLinkState) => void;

export class CallMesh {
  private readonly mesh: MeshManager;
  private readonly turn: TurnCredentialManager;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly localTrackSubs = new Set<LocalTrackListener>();
  private readonly remoteTrackSubs = new Set<RemoteTrackListener>();
  private readonly remoteTrackRemovedSubs = new Set<RemoteTrackListener>();
  private readonly failureSubs = new Set<FailureListener>();
  private readonly connectionStateSubs = new Set<ConnectionStateListener>();
  private readonly linkStateSubs = new Set<LinkStateListener>();
  /** Live remote tracks, per peer, keyed by track id (replayed to new subs). */
  private readonly remoteTracks = new Map<UserId, Map<string, MediaStreamTrack>>();
  /** The role each live remote track was published as. Held beside the tracks
   *  rather than inside them so a REPLAYED track reaches a late subscriber
   *  with the same answer the first one got. */
  private readonly remoteRoles = new Map<MediaStreamTrack, TrackRole | null>();
  /** Live local tracks by role (replayed to new subs). */
  private readonly localTracks = new Map<TrackRole, MediaStreamTrack>();
  /** Failures worth telling the user about, held until media is at stake. */
  private readonly pendingNotes = new Map<FailureKind, string>();
  /** Kinds already told to the user — one sentence per kind, per mesh. */
  private readonly reportedKinds = new Set<FailureKind>();
  private started = false;
  private closedFlag = false;
  private pollHandle: ReturnType<typeof setTimeout> | null = null;
  /** True once the first credential attempt settled; peers wait for it. */
  private credentialsSettled = false;
  private credentialWaitHandle: ReturnType<typeof setTimeout> | null = null;
  /** Who is currently receiving our call media (see {@link reconcileAudience}). */
  private readonly publishing = new Set<UserId>();
  /** When presence stopped calling a peer 'in-call', for the bridge. */
  private readonly leftCallAt = new Map<UserId, number>();
  /** False until the first audience reaches the mesh — an EMPTY audience is a
   *  real answer ("nobody is on the call"), not the absence of one. */
  private audienceApplied = false;
  private audienceHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly conn: RoomConnection,
    private readonly localUserId: UserId,
    /** Operator lever: caps relayed share video to protect TURN bill. */
    private readonly capRelayedVideoKbps?: number,
    /** Operator lever: total camera uplink ceiling, divided among receivers. */
    private readonly capCamKbps?: number,
  ) {
    this.turn = new TurnCredentialManager({
      getTurnCredentials: () => api.rtc.turnCredentials(),
      now: () => Date.now(),
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      clearTimeoutFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onUpdate: () => {
        // Credentials that arrive AFTER a peer was built (the first fetch
        // failed, a retry succeeded) reach that peer here: MeshManager polls
        // for this on its own, and repairing on the tick the credentials land
        // saves a degraded call the wait. No-op for peers built with them.
        this.mesh.refreshIceServers();
      },
      onError: () => {
        // The manager keeps retrying on its own backoff; what the user needs
        // is one sentence, and only if they are actually trying to call.
        this.reportFailure('setup', CALL_SETUP_NOTE);
      },
    });
    this.mesh = new MeshManager({
      roomId: conn.roomId,
      localUserId,
      // Names this TAB, not this account: without it, two tabs of one person
      // derive one connectionId and take turns resetting each other's link.
      endpointId: ENDPOINT_TOKEN,
      rtcFactory: browserRtcFactory,
      // Without this a remote track carries no role and the share stage has
      // nothing to tell a screen from a camera by (see onRemoteTrack).
      mediaStreamFactory: browserMediaStreamFactory,

      send: (event) => {
        conn.rawSocket.send(event.type, event.payload);
      },
      getIceServers: () => this.turn.iceServers(),
      now: () => Date.now(),
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      clearTimeoutFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onError: (_peerId, context) => {
        // Per-link failures also reach the UI through connectionStates(); the
        // room stays usable when one peer can't be reached, but "nothing works
        // and I don't know why" is not an acceptable way to find that out.
        if (context === 'iceRecoveryExhausted') {
          this.reportFailure('peer-lost', CALL_PEER_LOST_NOTE);
          return;
        }
        // A platform that cannot mint a MediaStream costs role NAMES, not the
        // call: the share stage falls back to what it did before roles existed.
        // Telling the user their connection died would simply be untrue.
        if (context === 'mediaStreamFactory') return;
        this.reportFailure('peer', CALL_PEER_NOTE);
      },
      ...(capRelayedVideoKbps === undefined ? {} : { capRelayedVideoKbps }),
      ...(capCamKbps === undefined ? {} : { capCamKbps }),
    });

    // Retention starts at construction, BEFORE any pane subscribes — a track
    // that lands while the rail is closed is still there when it opens.
    this.unsubscribers.push(
      this.mesh.onRemoteTrack((peerId, raw, _streams, role) => {
        const track = raw as unknown as MediaStreamTrack;
        this.retainRemote(peerId, track, role);
      }),
    );
    this.unsubscribers.push(
      this.mesh.onConnectionState((peerId, state) => {
        // A closed connection ends its receivers' tracks; drop ours too so a
        // peer who leaves and returns does not resurrect a dead tile.
        if (state === 'closed') this.dropPeer(peerId);
        if (state === 'failed') this.reportFailure('peer', CALL_PEER_NOTE);
        for (const fn of [...this.connectionStateSubs]) fn(peerId, state);
      }),
    );
    this.unsubscribers.push(
      this.mesh.onLinkState((peerId, state) => {
        for (const fn of [...this.linkStateSubs]) fn(peerId, state);
      }),
    );
  }

  /** Begin presence-following + signal routing. Idempotent. */
  start(): void {
    if (this.started || this.closedFlag) return;
    this.started = true;

    // Signal routing and presence-following are wired immediately — only the
    // building of connections waits on credentials, and presence that changes
    // during the wait is read fresh when the gate opens.
    this.unsubscribers.push(
      this.conn.useRoomState.subscribe((s, prev) => {
        if (s.presence !== prev.presence) this.reconcilePeers();
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
    // link is classified from the moment it exists, so anything reading link
    // state has an answer before a share ever starts.
    this.schedulePoll();

    this.openGateWhenCredentialsSettle();
  }

  /**
   * Open the peer gate once the first credential attempt has SETTLED — which
   * is not the same as "succeeded". A refused or failing fetch must still let
   * the call proceed on whatever the manager yields (an empty list: host and
   * srflx candidates only), because a degraded call beats a call that never
   * starts. `TurnCredentialManager.start()` resolves either way and keeps
   * retrying on its own backoff; the timer covers the third case, a fetch that
   * simply never answers.
   */
  private openGateWhenCredentialsSettle(): void {
    let opened = false;
    const open = (): void => {
      if (opened) return;
      opened = true;
      if (this.credentialWaitHandle !== null) {
        clearTimeout(this.credentialWaitHandle);
        this.credentialWaitHandle = null;
      }
      this.credentialsSettled = true;
      this.reconcilePeers();
    };
    this.credentialWaitHandle = setTimeout(open, CREDENTIAL_WAIT_MS);
    void this.turn.start().then(open, open);
  }

  /** Reconcile the mesh toward whoever is present (non-offline). */
  private reconcilePeers(): void {
    if (this.closedFlag || !this.credentialsSettled) return;
    // Audience first: a peer built by applyPresence reads it as it is armed, so
    // somebody who joins the call and the mesh in one presence update gets our
    // camera on their first offer instead of on a second renegotiation.
    this.reconcileAudience();
    this.mesh.applyPresence(Object.values(this.conn.useRoomState.getState().presence));
  }

  /**
   * Point the camera and the microphone at the people who are on the CALL.
   *
   * The mesh connects the whole room — it carries the DataChannel fabric, and a
   * lurker's connection is as real as a caller's — so "we have a connection to
   * them" was never a reason to send them a camera. It used to be the only
   * reason: in a room of twelve where four were calling, each of those four
   * uploaded eleven copies of their camera, eight to people who never pressed
   * Join. Presence is what says who is in the call, and the bridge covers the
   * round trip where a client re-announcing its own state blips out of it.
   */
  private reconcileAudience(): void {
    if (this.closedFlag) return;
    const now = Date.now();
    const declared = new Set<UserId>();
    for (const entry of Object.values(this.conn.useRoomState.getState().presence)) {
      if (entry.userId === this.localUserId) continue;
      if (entry.state === 'in-call') declared.add(entry.userId);
    }
    // Someone who WAS receiving and is no longer declared starts their bridge.
    for (const userId of this.publishing) {
      if (!declared.has(userId) && !this.leftCallAt.has(userId)) this.leftCallAt.set(userId, now);
    }

    const audience = new Set(declared);
    let soonestMs: number | null = null;
    for (const [userId, at] of [...this.leftCallAt]) {
      const remaining = at + PUBLISH_BRIDGE_MS - now;
      if (declared.has(userId) || remaining <= 0) {
        this.leftCallAt.delete(userId);
        continue;
      }
      audience.add(userId);
      soonestMs = soonestMs === null ? remaining : Math.min(soonestMs, remaining);
    }

    // Presence churns for its own reasons — every queue move rewrites it — and
    // re-applying an unchanged audience would call replaceTrack on every live
    // sender each time. Apply only real changes.
    const changed =
      !this.audienceApplied ||
      audience.size !== this.publishing.size ||
      [...audience].some((userId) => !this.publishing.has(userId));
    if (changed) {
      this.audienceApplied = true;
      this.publishing.clear();
      for (const userId of audience) this.publishing.add(userId);
      this.mesh.setPublishAudience([...audience]);
    }

    // The bridge has to expire on its own clock: nothing guarantees another
    // presence event will ever arrive to close it.
    if (this.audienceHandle !== null) {
      clearTimeout(this.audienceHandle);
      this.audienceHandle = null;
    }
    if (soonestMs === null) return;
    this.audienceHandle = setTimeout(() => {
      this.audienceHandle = null;
      this.reconcileAudience();
    }, soonestMs);
  }

  /**
   * Run one link-stats poll now. Link classification (direct vs relayed) lives
   * in the p2p layer and only advances inside pollStats.
   */
  async pollLinkStats(): Promise<void> {
    if (this.closedFlag) return;
    await this.mesh.pollStats();
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
    // Publishing is the moment a broken call stops being hypothetical.
    if (track !== null) this.flushPendingNotes();
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
      for (const track of tracks.values()) fn(userId, track, this.remoteTrackRole(track));
    }
    return () => {
      this.remoteTrackSubs.delete(fn);
    };
  }

  /** What a live remote track was published as, or null when unknown. */
  remoteTrackRole(track: MediaStreamTrack): TrackRole | null {
    return this.remoteRoles.get(track) ?? null;
  }

  /** Subscribe to remote tracks going away (ended, or the peer disconnected). */
  onRemoteTrackRemoved(fn: RemoteTrackListener): () => void {
    this.remoteTrackRemovedSubs.add(fn);
    return () => {
      this.remoteTrackRemovedSubs.delete(fn);
    };
  }

  /**
   * Failures worth saying out loud — one plain sentence, at most one per kind
   * for the life of this mesh. Everything else stays in connectionStates().
   */
  onError(fn: FailureListener): () => void {
    this.failureSubs.add(fn);
    return () => {
      this.failureSubs.delete(fn);
    };
  }

  /**
   * Per-peer connection state as it changes, so the UI can say something true
   * about a tile instead of showing a still avatar over a dead link. Current
   * states are replayed to a new subscriber, like tracks.
   */
  onConnectionState(fn: ConnectionStateListener): () => void {
    this.connectionStateSubs.add(fn);
    for (const [peerId, state] of this.mesh.connectionStates()) fn(peerId, state);
    return () => {
      this.connectionStateSubs.delete(fn);
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

  /**
   * Which PATH each peer's media is taking: 'direct' peer-to-peer, 'relayed'
   * through a TURN server, or 'unknown' before the first stats poll classifies
   * it.
   *
   * This is the difference between "nobody but us can see this" and "every byte
   * of it is passing through a server we rent", and the app had no way to ask —
   * so the badge said 'Private' whatever was true, which is the one answer that
   * must never be a guess. A person is 'relayed' if ANY of their links is: a
   * call that is direct to one device and relayed to that person's phone is not
   * a private call.
   */
  linkStates(): Map<UserId, MeshLinkState> {
    return this.mesh.linkStates();
  }

  /** The path to one peer; 'unknown' for someone we hold no link to. */
  linkState(peerId: UserId): MeshLinkState {
    return this.mesh.linkState(peerId);
  }

  /** Link-path changes as they are classified. Current paths are replayed to a
   *  new subscriber, like tracks and connection states. */
  onLinkState(fn: LinkStateListener): () => void {
    this.linkStateSubs.add(fn);
    for (const [peerId, state] of this.mesh.linkStates()) fn(peerId, state);
    return () => {
      this.linkStateSubs.delete(fn);
    };
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    if (this.pollHandle !== null) {
      clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.credentialWaitHandle !== null) {
      clearTimeout(this.credentialWaitHandle);
      this.credentialWaitHandle = null;
    }
    if (this.audienceHandle !== null) {
      clearTimeout(this.audienceHandle);
      this.audienceHandle = null;
    }
    for (const off of this.unsubscribers.splice(0)) off();
    this.mesh.close();
    this.turn.stop();
    this.started = false;
    this.remoteTracks.clear();
    this.remoteRoles.clear();
    this.localTracks.clear();
    this.remoteTrackSubs.clear();
    this.remoteTrackRemovedSubs.clear();
    this.localTrackSubs.clear();
    this.failureSubs.clear();
    this.connectionStateSubs.clear();
    this.linkStateSubs.clear();
    this.pendingNotes.clear();
    this.publishing.clear();
    this.leftCallAt.clear();
  }

  // ---------- internals ----------

  /**
   * Tell the user once — but only when the failure can actually cost them
   * something. The mesh connects to everyone in the ROOM, not just to whoever
   * is calling, so a link that fails while no media rides it has no
   * user-visible consequence and gets no toast. A failure that happens before
   * anyone calls (the TURN fetch runs when the room opens) is held and
   * delivered the moment media IS at stake — which is the moment it becomes
   * true and actionable.
   */
  private reportFailure(kind: FailureKind, note: string): void {
    if (this.closedFlag || this.reportedKinds.has(kind)) return;
    if (!this.mediaAtStake()) {
      this.pendingNotes.set(kind, note);
      return;
    }
    this.pendingNotes.delete(kind);
    this.reportedKinds.add(kind);
    for (const fn of [...this.failureSubs]) fn(note);
  }

  /** Deliver anything that was waiting for media to matter. */
  private flushPendingNotes(): void {
    if (this.pendingNotes.size === 0 || !this.mediaAtStake()) return;
    for (const [kind, note] of [...this.pendingNotes]) {
      this.pendingNotes.delete(kind);
      this.reportedKinds.add(kind);
      for (const fn of [...this.failureSubs]) fn(note);
    }
  }

  /** Media is at stake once we publish anything, or anything arrives. */
  private mediaAtStake(): boolean {
    return this.localTracks.size > 0 || this.remoteTracks.size > 0;
  }

  private retainRemote(peerId: UserId, track: MediaStreamTrack, role: TrackRole | null): void {
    let byId = this.remoteTracks.get(peerId);
    if (byId === undefined) {
      byId = new Map();
      this.remoteTracks.set(peerId, byId);
    }
    if (byId.get(track.id) === track) return; // same track re-delivered
    byId.set(track.id, track);
    this.remoteRoles.set(track, role);
    this.flushPendingNotes();
    const onEnded = (): void => {
      track.removeEventListener('ended', onEnded);
      this.forgetRemote(peerId, track);
    };
    track.addEventListener('ended', onEnded);
    for (const fn of [...this.remoteTrackSubs]) fn(peerId, track, role);
  }

  private forgetRemote(peerId: UserId, track: MediaStreamTrack): void {
    const byId = this.remoteTracks.get(peerId);
    if (byId === undefined || !byId.has(track.id)) return;
    byId.delete(track.id);
    if (byId.size === 0) this.remoteTracks.delete(peerId);
    const role = this.remoteRoles.get(track) ?? null;
    this.remoteRoles.delete(track);
    for (const fn of [...this.remoteTrackRemovedSubs]) fn(peerId, track, role);
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

/**
 * Whether this client currently INTENDS to be in the room's call.
 *
 * This is the local truth, and it is ahead of the server's presence echo by a
 * full round trip. Anything that re-announces presence for its own reasons —
 * the playback subscriber in room-context, which flips 'watching'/'listening'
 * as a mixed queue moves between music and video — must consult it rather than
 * the echo, or a sync.state arriving within one RTT of joining overwrites
 * 'in-call' and every other client drops the tile.
 */
const callIntents = new WeakSet<RoomConnection>();

/** Called by the call surface as it joins/leaves; see {@link inCallIntent}. */
export function setCallIntent(conn: RoomConnection, inCall: boolean): void {
  if (inCall) callIntents.add(conn);
  else callIntents.delete(conn);
}

/** True while this client means to be in the call, echo or no echo. */
export function inCallIntent(conn: RoomConnection): boolean {
  return callIntents.has(conn);
}

/* ── audio sink ownership ────────────────────────────────────────────────── */

/**
 * Which surface is playing a given remote audio track — at most one, ever.
 *
 * Two media elements on one track play it twice, milliseconds apart: a flanged
 * double of the same voice, which is worse than silence and is exactly what
 * you get the moment a second surface starts sinking audio. So a track has one
 * owner. A surface that mounts its own sink CLAIMS the tracks it plays, and
 * the call's hidden sinks stand down for anything claimed.
 *
 * The claimant that matters is the share viewer: it plays the sharing host's
 * sound whether or not you ever joined the call, which is the whole point of
 * giving share audio a role of its own. What it claims is now exactly what it
 * plays — the mesh names a remote track's role (see {@link
 * CallMesh.remoteTrackRole}), so the host's MICROPHONE stays the call's to
 * sink. A track the mesh cannot name is claimed the old way, by the host it
 * came from: an older client that answers null must not lose its sound. When
 * no share viewer is mounted nothing is claimed and the call sinks behave
 * exactly as they always did.
 */
const audioSinkClaims = new Map<MediaStreamTrack, object>();
const audioSinkSubs = new Set<() => void>();

function notifyAudioSinkClaims(): void {
  for (const fn of [...audioSinkSubs]) fn();
}

/**
 * Claim `track` for `owner`; the returned function releases it. First claimant
 * wins — a second owner gets an inert release rather than stealing the track,
 * so a mount race cannot leave two elements fighting over one sound. Re-claims
 * by the same owner are idempotent (StrictMode runs every effect twice).
 */
export function claimAudioSink(track: MediaStreamTrack, owner: object): () => void {
  const held = audioSinkClaims.get(track);
  if (held !== undefined && held !== owner) return () => undefined;
  if (held === undefined) {
    audioSinkClaims.set(track, owner);
    notifyAudioSinkClaims();
  }
  return () => {
    if (audioSinkClaims.get(track) !== owner) return;
    audioSinkClaims.delete(track);
    notifyAudioSinkClaims();
  };
}

/** True while some other surface owns this track's sink. */
export function isAudioSinkClaimed(track: MediaStreamTrack): boolean {
  return audioSinkClaims.has(track);
}

/** Fires whenever a claim is taken or released, so a sink can stand down. */
export function onAudioSinkClaims(fn: () => void): () => void {
  audioSinkSubs.add(fn);
  return () => {
    audioSinkSubs.delete(fn);
  };
}

type MeshClosedListener = (conn: RoomConnection) => void;
const meshClosedSubs = new Set<MeshClosedListener>();

/** Fires when a room's mesh is torn down via closeCallMesh (room unmount).
 *  Anything holding live media on that mesh — the host share session — must
 *  release its capture, or the browser's recording indicator outlives every
 *  control that could stop it. */
export function onCallMeshClosed(fn: MeshClosedListener): () => void {
  meshClosedSubs.add(fn);
  return () => {
    meshClosedSubs.delete(fn);
  };
}

/** Default bitrate ceiling for relayed share video (kbps). 400 is the middle
 *  of the 300–500 band; the governor adapts down from here based on link RTT. */
export const DEFAULT_CAP_RELAYED_VIDEO_KBPS = 400;

/**
 * Default TOTAL camera uplink (kbps), divided among the people receiving it.
 *
 * A mesh sends one encode per receiver, so the camera is the one role whose
 * cost multiplies with the call: uncapped 720p is ~2.5 Mbps, and four
 * receivers is 10 Mbps of uplink from a laptop on hotel wifi — where the
 * failure is not a softer picture but a call that stops working. 1200 gives a
 * one-to-one call a good image and holds the total roughly flat as people
 * join, down to the floor the mesh refuses to divide past.
 */
export const DEFAULT_CAP_CAM_KBPS = 1200;

export function getCallMesh(
  conn: RoomConnection,
  localUserId: UserId,
  capRelayedVideoKbps = DEFAULT_CAP_RELAYED_VIDEO_KBPS,
  capCamKbps = DEFAULT_CAP_CAM_KBPS,
): CallMesh {
  const existing = meshes.get(conn);
  // A closed mesh is inert (StrictMode double-effects close then re-acquire),
  // so replace it rather than hand back a dead one.
  if (existing !== undefined && !existing.closed) return existing;
  const mesh = new CallMesh(conn, localUserId, capRelayedVideoKbps, capCamKbps);
  meshes.set(conn, mesh);
  return mesh;
}

/** Tear the room's mesh down (room unmount). Safe to call more than once. */
export function closeCallMesh(conn: RoomConnection): void {
  const mesh = meshes.get(conn);
  if (mesh === undefined) return;
  meshes.delete(conn);
  callIntents.delete(conn);
  mesh.close();
  for (const fn of [...meshClosedSubs]) fn(conn);
}
