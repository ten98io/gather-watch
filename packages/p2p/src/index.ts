/**
 * Public surface of @playin/p2p — the isomorphic WebRTC mesh engine.
 *
 * The internal base64 codec (b64.ts) is deliberately NOT exported.
 */

export type {
  ClearTimeoutFn,
  ConnectionStateLike,
  DataChannelInitLike,
  DataChannelLike,
  FetchInitLike,
  FetchLike,
  FetchResponseLike,
  IceServerLike,
  InboundSignal,
  MediaStreamTrackLike,
  NowFn,
  OutboundSignal,
  RngFn,
  RtcConfigLike,
  RtcFactory,
  RtcPeerConnectionLike,
  RtpEncodingLike,
  RtpParametersLike,
  RtpSenderLike,
  SessionDescriptionLike,
  SetTimeoutFn,
  SignalingStateLike,
  SignalSend,
  TimeoutHandle,
  TrackRole,
} from './types';

export { PerfectNegotiator } from './negotiation';
export type { PerfectNegotiatorOptions } from './negotiation';

export { CHANNEL_IDS, ChannelFabric } from './channels';
export type {
  ChannelFabricOptions,
  ChannelLabel,
  ChannelMessages,
  EmoteChannelMessage,
  FileChannelMessage,
  SyncBeacon,
  SyncChannelMessage,
} from './channels';

export { MasterElection } from './election';
export type { ElectionPeer, MasterElectionEvents, MasterElectionOptions } from './election';

export { BeaconFollower, BeaconSender } from './beacon';
export type { BeaconFollowerOptions, BeaconSenderOptions, BeaconState } from './beacon';

export { TurnCredentialManager } from './turn';
export type { TurnCredentialManagerOptions } from './turn';

export { MeshManager } from './mesh';
export type { MeshConnectionState, MeshManagerOptions } from './mesh';

export { classifyLinkStats } from './linkstate';
export type { MeshLinkState } from './linkstate';

export { FILE_CHUNK_SIZE, FILE_WINDOW_CHUNKS, FileShareClient, FileShareServer } from './fileshare';
export type {
  FileShareClientOptions,
  FileShareServerOptions,
  FileSource,
  HashFn,
} from './fileshare';

export { applyMaxBitrate, BitrateGovernor, clearMaxBitrate, LinkAdaptor } from './adaptation';
export type { BitrateGovernorOptions, LinkAdaptorOptions, LinkSample } from './adaptation';

export { CfSfuProvider, LivekitProvider, MeshProvider, RelayError } from './relay';
export type { CfSfuProviderOptions, RelayAuth, RelayKind, RelayProvider } from './relay';
