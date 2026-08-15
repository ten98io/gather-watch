/**
 * CallMesh — wires @playin/p2p's MeshManager to the browser: native
 * RTCPeerConnection, TURN credentials from the API (TurnCredentialManager
 * keeps them fresh), signaling over the room's shared RoomConnection
 * (webrtc.offer/answer/ice), and peer-set reconciliation from presence.
 *
 * One per room; created lazily by the panes that need media (CallStrip,
 * Mode B share) so a room that never calls never opens a peer connection.
 */
import { MeshManager, TurnCredentialManager } from '@playin/p2p';
import type {
  IceServerLike,
  MeshConnectionState,
  RtcPeerConnectionLike,
  TrackRole,
} from '@playin/p2p';
import type { UserId } from '@playin/contracts';
import { api } from './api';
import type { RoomConnection } from './room-connection';

const browserRtcFactory = (config: { iceServers: IceServerLike[] }): RtcPeerConnectionLike =>
  new RTCPeerConnection({
    iceServers: config.iceServers as RTCIceServer[],
  }) as unknown as RtcPeerConnectionLike;

export class CallMesh {
  private readonly mesh: MeshManager;
  private readonly turn: TurnCredentialManager;
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;

  constructor(private readonly conn: RoomConnection, private readonly localUserId: UserId) {
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
    });
  }

  /** Begin presence-following + signal routing. Idempotent. */
  start(): void {
    if (this.started) return;
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
  }

  /** Publish/replace/remove a local track for a role on every peer link. */
  setLocalTrack(role: TrackRole, track: MediaStreamTrack | null): void {
    this.mesh.setLocalTrack(role, track as unknown as Parameters<MeshManager['setLocalTrack']>[1]);
  }

  /** Subscribe to remote tracks; `source` is the publishing user id. */
  onRemoteTrack(fn: (source: UserId, track: MediaStreamTrack) => void): () => void {
    return this.mesh.onRemoteTrack((peerId, track) => {
      fn(peerId, track as unknown as MediaStreamTrack);
    });
  }

  /** Per-peer connection states (diagnostics / uplink honesty). */
  connectionStates(): Map<UserId, MeshConnectionState> {
    return this.mesh.connectionStates();
  }

  close(): void {
    for (const off of this.unsubscribers.splice(0)) off();
    this.mesh.close();
    this.turn.stop();
    this.started = false;
  }
}

/* Lazy per-connection registry: panes share one mesh per room connection. */
const meshes = new WeakMap<RoomConnection, CallMesh>();

export function getCallMesh(conn: RoomConnection, localUserId: UserId): CallMesh {
  let mesh = meshes.get(conn);
  if (mesh === undefined) {
    mesh = new CallMesh(conn, localUserId);
    meshes.set(conn, mesh);
  }
  return mesh;
}
