/**
 * Injected-primitive interfaces for the isomorphic WebRTC mesh engine.
 *
 * This package never touches platform globals: every RTC primitive
 * (RTCPeerConnection construction, timers, randomness, fetch) is injected by
 * the host app — browser natives on web, react-native-webrtc on mobile, and a
 * mock harness in tests. No DOM or Node typings are referenced anywhere.
 */

import type {
  ClientWebrtcAnswer,
  ClientWebrtcIce,
  ClientWebrtcOffer,
  IceCandidateInit,
  ServerWebrtcAnswer,
  ServerWebrtcIce,
  ServerWebrtcOffer,
} from '@gather/contracts';

// ---------- timers / clock / rng ----------

/** Opaque timer handle, intentionally untyped to stay platform agnostic. */
export type TimeoutHandle = unknown;

/** Structural setTimeout signature used by this package. */
export type SetTimeoutFn = (fn: () => void, ms: number) => TimeoutHandle;

/** Structural clearTimeout signature used by this package. */
export type ClearTimeoutFn = (handle: TimeoutHandle) => void;

/** Monotonic-enough clock in epoch milliseconds; injected (virtual in tests). */
export type NowFn = () => number;

/** Seedable random source returning floats in [0, 1). */
export type RngFn = () => number;

// ---------- fetch (for HTTP relay providers) ----------

/** Minimal structural subset of the platform Response used by this package. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Minimal structural subset of the platform RequestInit used by this package. */
export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Minimal structural fetch signature used by this package. */
export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

// ---------- media ----------

/** Minimal structural MediaStreamTrack. */
export interface MediaStreamTrackLike {
  id: string;
  kind: 'audio' | 'video';
  enabled: boolean;
  stop?(): void;
}

/** Encoding parameters subset consumed by the bitrate governor. */
export interface RtpEncodingLike {
  maxBitrate?: number;
  active?: boolean;
}

/** Minimal structural RTCRtpSendParameters. */
export interface RtpParametersLike {
  encodings: RtpEncodingLike[];
}

/** Minimal structural RTCRtpSender. */
export interface RtpSenderLike {
  track: MediaStreamTrackLike | null;
  getParameters(): RtpParametersLike;
  setParameters(parameters: RtpParametersLike): Promise<void>;
  replaceTrack?(track: MediaStreamTrackLike | null): Promise<void>;
}

/**
 * Local media roles a mesh participant can publish.
 *
 * 'share-audio' is a role of its own for one reason: it is NOT a microphone.
 * A role is a sender, so publishing a screen capture's soundtrack on 'mic' —
 * which is what the web app did — REPLACED the host's live microphone for the
 * whole room the moment they shared, and withdrawing it when the share stopped
 * left them silent with their mic button still reading "on". Two roles, two
 * senders, and neither can stand on the other.
 */
export type TrackRole = 'share' | 'share-audio' | 'cam' | 'mic';

// ---------- peer connection ----------

export type SignalingStateLike =
  | 'stable'
  | 'have-local-offer'
  | 'have-remote-offer'
  | 'have-local-pranswer'
  | 'have-remote-pranswer'
  | 'closed';

export type ConnectionStateLike =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

/** Minimal structural RTCSessionDescriptionInit. */
export interface SessionDescriptionLike {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

/** Options accepted by createDataChannel. */
export interface DataChannelInitLike {
  /** Pre-negotiated channels open without in-band signaling; both sides must
   *  create the same `id`. The mesh uses this for its fixed channel fabric. */
  negotiated?: boolean;
  id?: number;
  ordered?: boolean;
}

/** Minimal structural RTCDataChannel. */
export interface DataChannelLike {
  readonly label: string;
  readyState: 'connecting' | 'open' | 'closing' | 'closed';
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onbufferedamountlow: (() => void) | null;
  send(data: string): void;
  close(): void;
}

/** ICE server entry, shape-compatible with contracts TurnCredentialsResponse. */
export interface IceServerLike {
  urls: string[];
  username?: string | undefined;
  credential?: string | undefined;
}

/** RTCConfiguration subset used when constructing peer connections. */
export interface RtcConfigLike {
  iceServers: IceServerLike[];
}

/** Minimal structural RTCPeerConnection covering everything the mesh uses. */
export interface RtcPeerConnectionLike {
  localDescription: SessionDescriptionLike | null;
  remoteDescription: SessionDescriptionLike | null;
  signalingState: SignalingStateLike;
  connectionState: ConnectionStateLike;

  onnegotiationneeded: (() => void) | null;
  onicecandidate: ((ev: { candidate: IceCandidateInit | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((ev: { track: MediaStreamTrackLike; streams: unknown[] }) => void) | null;
  ondatachannel: ((ev: { channel: DataChannelLike }) => void) | null;

  createOffer(options?: { iceRestart?: boolean }): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  /** Parameterless form performs the spec's "implicit" offer/answer creation. */
  setLocalDescription(description?: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: IceCandidateInit): Promise<void>;

  addTrack(track: MediaStreamTrackLike, ...streams: unknown[]): RtpSenderLike;
  removeTrack(sender: RtpSenderLike): void;
  getSenders(): RtpSenderLike[];

  createDataChannel(label: string, init?: DataChannelInitLike): DataChannelLike;

  getStats?(): Promise<unknown>;
  restartIce?(): void;
  close(): void;
}

/** Injected factory that constructs a platform peer connection. */
export type RtcFactory = (config: RtcConfigLike) => RtcPeerConnectionLike;

// ---------- signaling ----------

/** Client→server WebRTC signaling events (ride the room WS, seq 0). */
export type OutboundSignal = ClientWebrtcOffer | ClientWebrtcAnswer | ClientWebrtcIce;

/** Server→client relayed WebRTC signaling events (stamped fromUserId). */
export type InboundSignal = ServerWebrtcOffer | ServerWebrtcAnswer | ServerWebrtcIce;

/** Transport for outbound signaling, typically RoomSocket.send from api-client. */
export type SignalSend = (event: OutboundSignal) => void;
