/**
 * Relay provider abstraction: one uniform media-plane interface over the three
 * supported topologies — p2p mesh (default), Cloudflare Realtime SFU (premium
 * Theater mode), and LiveKit (self-host, gated behind ENABLE_SFU). Providers
 * are switchable per room mid-session; sync beacons ride DataChannels in every
 * topology.
 */

import type { RelayMode, RoomId } from '@playin/contracts';
import type { MeshManager } from './mesh';
import type { ChannelLabel } from './channels';
import type {
  ClearTimeoutFn,
  DataChannelLike,
  FetchLike,
  IceServerLike,
  MediaStreamTrackLike,
  NowFn,
  RtcFactory,
  RtcPeerConnectionLike,
  SessionDescriptionLike,
  SetTimeoutFn,
} from './types';

/** Media relay topology, mirroring contracts RelayMode. */
export type RelayKind = RelayMode;

/** Error raised by relay providers; `code` classifies the failure. */
export class RelayError extends Error {
  readonly code: 'NOT_ENABLED' | 'HTTP' | 'STATE';
  readonly status: number | null;

  constructor(code: 'NOT_ENABLED' | 'HTTP' | 'STATE', message: string, status?: number) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status ?? null;
  }
}

/** Per-connect authentication for a relay provider. */
export interface RelayAuth {
  /** Bearer token (Cloudflare app token / LiveKit JWT); null for mesh. */
  token: string | null;
  /** Cloudflare Realtime appId (cf-sfu only). */
  appId?: string;
  /** API base override; default 'https://rtc.live.cloudflare.com'. */
  baseUrl?: string;
}

/** Uniform media-plane interface: mesh (default), Cloudflare Realtime SFU
 *  (premium Theater mode), LiveKit (self-host, ENABLE_SFU). Switchable per room
 *  mid-session; sync beacons ride DataChannels in every topology. */
export interface RelayProvider {
  readonly kind: RelayKind;
  connect(roomId: RoomId, auth: RelayAuth): Promise<void>;
  publishTracks(tracks: MediaStreamTrackLike[]): Promise<void>;
  /** Subscribe to remote tracks; `source` is the publishing peer/session id. */
  subscribe(fn: (source: string, track: MediaStreamTrackLike) => void): () => void;
  /** A raw DataChannel for the label, when the topology exposes one; mesh returns
   *  null (use MeshManager.fabric instead — it is already per-peer). */
  dataChannel(label: ChannelLabel): DataChannelLike | null;
  close(): Promise<void>;
}

/** Mesh topology adapter over an externally managed MeshManager. */
export class MeshProvider implements RelayProvider {
  readonly kind = 'mesh';

  private readonly mesh: MeshManager;

  constructor(mesh: MeshManager) {
    this.mesh = mesh;
  }

  /** Resolves immediately: the mesh lifecycle is presence/signaling-driven. */
  connect(): Promise<void> {
    return Promise.resolve();
  }

  /** Maps kinds → roles: audio→'mic', first video→'cam', further video→'share'. */
  publishTracks(tracks: MediaStreamTrackLike[]): Promise<void> {
    let camTaken = false;
    for (const track of tracks) {
      if (track.kind === 'audio') {
        this.mesh.setLocalTrack('mic', track);
      } else if (!camTaken) {
        camTaken = true;
        this.mesh.setLocalTrack('cam', track);
      } else {
        this.mesh.setLocalTrack('share', track);
      }
    }
    return Promise.resolve();
  }

  /** Adapts mesh.onRemoteTrack; `source` is the publishing peerId. */
  subscribe(fn: (source: string, track: MediaStreamTrackLike) => void): () => void {
    return this.mesh.onRemoteTrack((peerId, track) => {
      fn(peerId, track);
    });
  }

  /** Mesh has no single raw channel — use MeshManager.fabric (per-peer). */
  dataChannel(): DataChannelLike | null {
    return null;
  }

  /** Closes the underlying mesh. */
  close(): Promise<void> {
    this.mesh.close();
    return Promise.resolve();
  }
}

/** Options for {@link CfSfuProvider}. */
export interface CfSfuProviderOptions {
  rtcFactory: RtcFactory;
  fetchImpl: FetchLike;
  now: NowFn;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  getIceServers?: () => IceServerLike[];
}

/** Read a string field from a possibly CF-wrapped response ({ ... } or
 *  { result: { ... } }); undefined when absent on both levels. */
function pickField(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null) return undefined;
  const rec = body as Record<string, unknown>;
  const direct = rec[key];
  if (direct !== undefined) return direct;
  const result = rec['result'];
  if (typeof result === 'object' && result !== null) {
    return (result as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * Cloudflare Realtime SFU provider (premium Theater mode) over the HTTP session
 * API. Flow per Cloudflare docs: POST /v1/apps/{appId}/sessions/new (Bearer auth)
 * → { sessionId }; publishing: createOffer with local tracks, POST
 * /v1/apps/{appId}/sessions/{sessionId}/tracks/new with
 * { sessionDescription: offer, tracks: [{ location: 'local', trackName }] } →
 * apply returned answer sessionDescription; subscribing: POST tracks/new with
 * { tracks: [{ location: 'remote', sessionId, trackName }] } and when the
 * response carries requiresImmediateRenegotiation + an offer, answer it via PUT
 * /v1/apps/{appId}/sessions/{sessionId}/renegotiate.
 *
 * NOTE (binding): live verification of the exact Cloudflare responses happens in
 * WF5 against a real Cloudflare Realtime app; this module is exercised against a
 * mocked fetch in unit tests until then.
 */
export class CfSfuProvider implements RelayProvider {
  readonly kind = 'cf-sfu';

  private readonly rtcFactory: RtcFactory;
  private readonly fetchImpl: FetchLike;
  private readonly getIceServers: () => IceServerLike[];

  private pc: RtcPeerConnectionLike | null = null;
  private session: string | null = null;
  private appId: string | null = null;
  private token: string | null = null;
  private baseUrl = 'https://rtc.live.cloudflare.com';
  /** Track names we published, for bookkeeping/diagnostics. */
  private readonly localTrackNames = new Set<string>();
  private readonly channels = new Map<ChannelLabel, DataChannelLike>();
  private readonly trackSubs = new Set<(source: string, track: MediaStreamTrackLike) => void>();
  /** Last session passed to subscribeRemoteTracks; best-effort `source`
   *  attribution for inbound tracks until CF fan-out mapping lands in WF5. */
  private lastRemoteSessionId: string | null = null;

  constructor(opts: CfSfuProviderOptions) {
    this.rtcFactory = opts.rtcFactory;
    this.fetchImpl = opts.fetchImpl;
    this.getIceServers = opts.getIceServers ?? (() => []);
  }

  /** Create a Cloudflare Realtime session and the peer connection over it. */
  async connect(_roomId: RoomId, auth: RelayAuth): Promise<void> {
    if (auth.appId === undefined || auth.token === null) {
      throw new RelayError('STATE', 'cf-sfu requires RelayAuth.appId and a bearer token');
    }
    this.appId = auth.appId;
    this.token = auth.token;
    this.baseUrl = auth.baseUrl ?? 'https://rtc.live.cloudflare.com';

    const body = await this.api('POST', `/v1/apps/${this.appId}/sessions/new`);
    const sessionId = pickField(body, 'sessionId');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new RelayError('HTTP', 'cf-sfu session/new response carries no sessionId');
    }
    this.session = sessionId;

    const pc = this.rtcFactory({ iceServers: this.getIceServers() });
    pc.ontrack = (ev) => {
      const source = this.lastRemoteSessionId ?? 'cf-sfu';
      for (const fn of [...this.trackSubs]) fn(source, ev.track);
    };
    this.pc = pc;
  }

  /** Publish local tracks: offer with the tracks attached, then bind them to
   *  the session via tracks/new and apply the returned answer. */
  async publishTracks(tracks: MediaStreamTrackLike[]): Promise<void> {
    const { pc, session, appId } = this.requireConnected();
    for (const track of tracks) pc.addTrack(track);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const body = await this.api('POST', `/v1/apps/${appId}/sessions/${session}/tracks/new`, {
      sessionDescription: pc.localDescription ?? offer,
      tracks: tracks.map((track) => ({ location: 'local', trackName: track.id })),
    });
    const answer = pickField(body, 'sessionDescription');
    if (typeof answer === 'object' && answer !== null) {
      await pc.setRemoteDescription(answer as SessionDescriptionLike);
    }
    for (const track of tracks) this.localTrackNames.add(track.id);
  }

  /** Pull specific remote tracks published by another session. */
  async subscribeRemoteTracks(remoteSessionId: string, trackNames: string[]): Promise<void> {
    const { pc, session, appId } = this.requireConnected();
    this.lastRemoteSessionId = remoteSessionId;
    const body = await this.api('POST', `/v1/apps/${appId}/sessions/${session}/tracks/new`, {
      tracks: trackNames.map((trackName) => ({
        location: 'remote',
        sessionId: remoteSessionId,
        trackName,
      })),
    });
    const renegotiate = pickField(body, 'requiresImmediateRenegotiation');
    const offer = pickField(body, 'sessionDescription');
    if (
      renegotiate === true &&
      typeof offer === 'object' &&
      offer !== null &&
      (offer as { type?: unknown }).type === 'offer'
    ) {
      await pc.setRemoteDescription(offer as SessionDescriptionLike);
      // Parameterless form: the stack creates the implicit answer itself.
      await pc.setLocalDescription();
      await this.api('PUT', `/v1/apps/${appId}/sessions/${session}/renegotiate`, {
        sessionDescription: pc.localDescription,
      });
    }
  }

  /** Current Cloudflare session id; null before connect / after close. */
  sessionId(): string | null {
    return this.session;
  }

  /** Subscribe to remote tracks; `source` is the publishing session id (or
   *  'cf-sfu' when unknown). */
  subscribe(fn: (source: string, track: MediaStreamTrackLike) => void): () => void {
    this.trackSubs.add(fn);
    return () => {
      this.trackSubs.delete(fn);
    };
  }

  /** Lazily create (and cache) a plain in-band DataChannel per label.
   *
   *  NOTE: Cloudflare's DataChannel fan-out endpoints are wired up and verified
   *  live in WF5; until then this channel is local-pc-only. */
  dataChannel(label: ChannelLabel): DataChannelLike {
    if (this.pc === null || this.session === null) {
      throw new RelayError('STATE', 'cf-sfu dataChannel() before connect');
    }
    const cached = this.channels.get(label);
    if (cached !== undefined) return cached;
    const dc = this.pc.createDataChannel(label);
    this.channels.set(label, dc);
    return dc;
  }

  /** Close the peer connection and forget the session. No-op when unconnected. */
  close(): Promise<void> {
    if (this.pc !== null) {
      this.pc.ontrack = null;
      this.pc.close();
    }
    this.pc = null;
    this.session = null;
    this.appId = null;
    this.token = null;
    this.channels.clear();
    this.localTrackNames.clear();
    this.lastRemoteSessionId = null;
    return Promise.resolve();
  }

  // ---------- internals ----------

  private requireConnected(): { pc: RtcPeerConnectionLike; session: string; appId: string } {
    if (this.pc === null || this.session === null || this.appId === null) {
      throw new RelayError('STATE', 'cf-sfu provider is not connected');
    }
    return { pc: this.pc, session: this.session, appId: this.appId };
  }

  /** Authenticated JSON call against the Cloudflare Realtime session API. */
  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${this.token ?? ''}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      throw new RelayError('HTTP', `cf-sfu ${method} ${path} failed with status ${res.status}`, res.status);
    }
    return res.json();
  }
}

/** Self-host LiveKit tier — typed but intentionally disabled until ENABLE_SFU
 *  lands (WF5); every method throws RelayError('NOT_ENABLED'). */
export class LivekitProvider implements RelayProvider {
  readonly kind = 'livekit';

  /** Always rejects: LiveKit is not enabled in this build. */
  connect(): Promise<void> {
    return Promise.reject(new RelayError('NOT_ENABLED', 'LiveKit relay is not enabled in this build'));
  }

  /** Always rejects: LiveKit is not enabled in this build. */
  publishTracks(): Promise<void> {
    return Promise.reject(new RelayError('NOT_ENABLED', 'LiveKit relay is not enabled in this build'));
  }

  /** Always throws: LiveKit is not enabled in this build. */
  subscribe(): () => void {
    throw new RelayError('NOT_ENABLED', 'LiveKit relay is not enabled in this build');
  }

  /** Always throws: LiveKit is not enabled in this build. */
  dataChannel(): DataChannelLike | null {
    throw new RelayError('NOT_ENABLED', 'LiveKit relay is not enabled in this build');
  }

  /** Resolves fine — closing a never-opened provider is a no-op. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
