/**
 * Offscreen document (MV3): the only extension context with getUserMedia +
 * RTCPeerConnection. Receives a capture stream id from the background —
 * either a tabCapture id or a desktopCapture id for a screen/window — grabs
 * the stream and fans it out to the room as the mesh 'share' track via
 * @playin/p2p's MeshManager. That is the exact Mode B path the web app uses,
 * so extension and web viewers interoperate.
 *
 * It owns: the capture constraints, the audio degradation policy, and the
 * share-side socket/mesh lifetime. Signaling rides a second RoomSocket using
 * the same guest token.
 *
 * It deliberately does NOT: pick the surface (the background calls
 * chrome.tabCapture / chrome.desktopCapture and hands over an id), decide
 * whether sharing is allowed (background screens DRM tiers first), or render
 * anything — the offscreen document has no UI, so every reason it produces is
 * plain-language text for the caller to show.
 *
 * The non-obvious constraint: on macOS a desktop/screen capture yields no
 * system audio at all, and asking for it with a *mandatory* constraint makes
 * the whole getUserMedia call reject — taking the video with it. Audio is
 * therefore always best-effort: one combined attempt, then a video-only
 * retry. A share that has picture but no sound is a working share.
 */
import { MeshManager } from '@playin/p2p';
import type {
  InboundSignal,
  MediaStreamTrackLike,
  RtcPeerConnectionLike,
  SignalSend,
  TrackRole,
} from '@playin/p2p';
import { RoomSocket } from '@playin/api-client';
import type { RoomId, UserId } from '@playin/contracts';

import { WS_URL } from './config';

/** Where a stream id came from. Chrome's constraint name for it, verbatim. */
export type CaptureSource = 'tab' | 'desktop';

/** Capture ceiling. Shared by both surfaces so mesh bitrate stays predictable. */
export const MAX_WIDTH = 1920;
export const MAX_HEIGHT = 1080;
export const MAX_FRAME_RATE = 30;

/**
 * Chrome's legacy `mandatory` constraint bag. It is not part of the standard
 * MediaTrackConstraints, which is why it is typed here and cast once, at the
 * single point where it reaches navigator.mediaDevices.
 */
export interface GoogCaptureConstraint {
  mandatory: {
    chromeMediaSource: CaptureSource;
    chromeMediaSourceId: string;
    maxWidth?: number;
    maxHeight?: number;
    maxFrameRate?: number;
  };
}

/** What this document asks getUserMedia for. Audio is absent when giving up. */
export interface CaptureRequest {
  video: GoogCaptureConstraint;
  audio?: GoogCaptureConstraint;
}

/** The slice of MediaStream used here; structural so tests can stand one up. */
export interface ShareTrack {
  readonly kind: string;
  stop(): void;
}
export interface ShareStream {
  getTracks(): ShareTrack[];
  getVideoTracks(): ShareTrack[];
  getAudioTracks(): ShareTrack[];
}

/**
 * The RoomSocket surface this document uses. Taken as a `Pick` rather than
 * restated by hand: the event-type generics are correlated unions, and a
 * hand-written copy is not assignable from the real class even when it looks
 * identical.
 */
export type ShareSocket = Pick<RoomSocket, 'connect' | 'send' | 'on' | 'close'>;

/** The MeshManager surface this document uses; MeshManager satisfies it as-is. */
export interface ShareMesh {
  syncPeers(userIds: UserId[]): void;
  handleSignal(ev: InboundSignal): void;
  setLocalTrack(role: TrackRole, track: MediaStreamTrackLike | null): void;
  close(): void;
}

/** Everything that touches the browser, so a test can supply all of it. */
export interface ShareRuntime {
  getUserMedia(request: CaptureRequest): Promise<ShareStream>;
  createSocket(): ShareSocket;
  createMesh(opts: { roomId: RoomId; send: SignalSend }): ShareMesh;
}

/** A validated 'startShare' message off the wire. */
export interface StartShareRequest {
  streamId: string;
  roomId: string;
  accessToken: string;
  source: CaptureSource;
}

export interface ShareStarted {
  /** True when the share carries the captured surface's own sound. */
  audio: boolean;
  /** Plain-language reason the share is silent; '' when it has sound. */
  note: string;
}

export interface CaptureResult extends ShareStarted {
  stream: ShareStream;
}

/**
 * Said to a person, never logged as a code. Reached only after the audio
 * attempt actually failed, so both sentences describe what was observed
 * rather than guessing at the platform.
 */
const SILENT_NOTE: Record<CaptureSource, string> = {
  tab: 'Sharing video without sound — this tab did not hand over its audio. Everyone can still hear you on the call.',
  desktop:
    'Sharing video without sound — your computer did not offer any sound with this screen. Everyone can still hear you on the call.',
};

export function videoConstraint(source: CaptureSource, streamId: string): GoogCaptureConstraint {
  return {
    mandatory: {
      chromeMediaSource: source,
      chromeMediaSourceId: streamId,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      maxFrameRate: MAX_FRAME_RATE,
    },
  };
}

export function audioConstraint(source: CaptureSource, streamId: string): GoogCaptureConstraint {
  return { mandatory: { chromeMediaSource: source, chromeMediaSourceId: streamId } };
}

/**
 * Best-effort audio. The combined request is attempted first — for 'tab' it
 * is byte-for-byte the request this document has always made, so a tab share
 * that works today still takes the identical path. Only when that rejects do
 * we retry video-only; a rejection there is a genuinely failed capture and
 * propagates.
 */
export async function captureShare(
  opts: { streamId: string; source: CaptureSource },
  getUserMedia: ShareRuntime['getUserMedia'],
): Promise<CaptureResult> {
  const video = videoConstraint(opts.source, opts.streamId);
  try {
    const stream = await getUserMedia({
      video,
      audio: audioConstraint(opts.source, opts.streamId),
    });
    // Chrome can also honour the request and hand back a stream with no audio
    // track at all — silent success, same user-visible outcome as a rejection.
    const audio = stream.getAudioTracks().length > 0;
    return { stream, audio, note: audio ? '' : SILENT_NOTE[opts.source] };
  } catch {
    const stream = await getUserMedia({ video });
    return { stream, audio: false, note: SILENT_NOTE[opts.source] };
  }
}

/**
 * 'desktop' is selected only by that exact string. Anything else — absent,
 * misspelt, a stale sender — falls back to 'tab', which is what every caller
 * meant before the field existed.
 */
export function parseStartShare(msg: Record<string, unknown>): StartShareRequest | null {
  if (msg['kind'] !== 'startShare') return null;
  return {
    streamId: String(msg['streamId']),
    roomId: String(msg['roomId']),
    accessToken: String(msg['accessToken']),
    source: msg['source'] === 'desktop' ? 'desktop' : 'tab',
  };
}

const browserRuntime: ShareRuntime = {
  getUserMedia: (request) =>
    navigator.mediaDevices.getUserMedia(request as unknown as MediaStreamConstraints),
  createSocket: () => new RoomSocket(WS_URL, { replayFetch: async () => [] }),
  createMesh: ({ roomId, send }) =>
    new MeshManager({
      roomId,
      localUserId: 'extension-host' as UserId,
      rtcFactory: (config) =>
        new RTCPeerConnection({
          iceServers: config.iceServers as RTCIceServer[],
        }) as unknown as RtcPeerConnectionLike,
      send,
      now: () => Date.now(),
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      clearTimeoutFn: (h) => clearTimeout(h as never),
    }),
};

let mesh: ShareMesh | null = null;
let socket: ShareSocket | null = null;
let stream: ShareStream | null = null;

export async function startShare(
  opts: StartShareRequest,
  runtime: ShareRuntime = browserRuntime,
): Promise<ShareStarted> {
  await stopShare();

  // Called through the object so a runtime may implement it as a method.
  const captured = await captureShare(opts, (req) => runtime.getUserMedia(req));
  stream = captured.stream;

  const roomId = opts.roomId as RoomId;
  socket = runtime.createSocket();
  socket.connect(roomId, opts.accessToken);

  mesh = runtime.createMesh({ roomId, send: (event) => socket?.send(event.type, event.payload) });

  // Follow presence so late joiners get links.
  socket.on('presence.state', (ev) => {
    presenceMap.clear();
    for (const e of ev.payload.entries) presenceMap.set(e.userId, { state: e.state });
    mesh?.syncPeers([...presenceMap.keys()] as UserId[]);
  });
  socket.on('presence.diff', (ev) => {
    presenceMapApply(ev.payload.upserts, ev.payload.removed);
  });
  for (const type of ['webrtc.offer', 'webrtc.answer', 'webrtc.ice'] as const) {
    socket.on(type, (ev) => mesh?.handleSignal(ev));
  }

  const video = captured.stream.getVideoTracks()[0] ?? null;
  const audio = captured.stream.getAudioTracks()[0] ?? null;
  mesh.setLocalTrack('share', video as unknown as MediaStreamTrackLike);
  if (audio !== null) mesh.setLocalTrack('mic', audio as unknown as MediaStreamTrackLike);

  // A silent share is still a share: the room is told it started either way.
  socket.send('restream.start', {});
  socket.send('presence.update', { sharing: true, state: 'watching' });

  return { audio: captured.audio, note: captured.note };
}

// Track presence locally so diffs translate to a full desired-peer set.
const presenceMap = new Map<string, { state: string }>();
function presenceMapApply(
  upserts: Array<{ userId: string; state: string }>,
  removed: string[],
): void {
  for (const u of upserts) presenceMap.set(u.userId, { state: u.state });
  for (const r of removed) presenceMap.delete(r);
  mesh?.syncPeers([...presenceMap.keys()] as UserId[]);
}

export async function stopShare(): Promise<void> {
  if (socket !== null) {
    socket.send('restream.stop', {});
    socket.send('presence.update', { sharing: false });
  }
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  mesh?.close();
  mesh = null;
  socket?.close();
  socket = null;
}

/**
 * Registered only inside the extension. Under test the module is imported in
 * a plain Node context with no `chrome`, and the exported functions above are
 * what is exercised.
 */
if (typeof chrome !== 'undefined' && typeof chrome.runtime?.onMessage?.addListener === 'function') {
  chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender, sendResponse) => {
    const request = parseStartShare(msg);
    if (request === null) return false;
    startShare(request)
      .then((started) => sendResponse({ ok: true, audio: started.audio, note: started.note }))
      .catch((err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return true;
  });
}
