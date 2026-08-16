/**
 * Offscreen document (MV3): the only extension context with getUserMedia +
 * RTCPeerConnection. Receives a capture stream id from the background —
 * either a tabCapture id or a desktopCapture id for a screen/window — grabs
 * the stream and fans it out to the room as the mesh 'share' track via
 * @gather/p2p's MeshManager. That is the exact Mode B path the web app uses,
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
 * the whole getUserMedia call reject — taking the video with it. Worse, a
 * desktopCapture stream id is single-use, so the video-only retry after such a
 * rejection has nothing left to spend. The picker knows the answer up front and
 * sends it as `canRequestAudioTrack`: when it is false no audio is asked for at
 * all, and the id is spent once, on video. The retry remains for the case where
 * audio was legitimately requested and failed anyway. A share that has picture
 * but no sound is a working share.
 */
import { MeshManager } from '@gather/p2p';
import type {
  InboundSignal,
  MediaStreamTrackLike,
  MeshLinkState,
  RtcPeerConnectionLike,
  SignalSend,
  TrackRole,
} from '@gather/p2p';
import { RoomSocket } from '@gather/api-client';
import type { Plan, RoomId, UserId } from '@gather/contracts';

import { WS_URL } from './config';

/** Where a stream id came from. Chrome's constraint name for it, verbatim. */
export type CaptureSource = 'tab' | 'desktop';

/** Capture ceiling. Shared by both surfaces so mesh bitrate stays predictable. */
export const MAX_WIDTH = 1920;
export const MAX_HEIGHT = 1080;
export const MAX_FRAME_RATE = 30;

/** Free-tier ceiling for the share encode over a relayed link — the same
 *  number the web app passes (docs/COST_MODEL.md: cap, do not refuse). */
export const FREE_SHARE_RELAY_KBPS = 400;

/** Link classification only advances inside the mesh's pollStats(), and this
 *  document owns the interval — without the cadence the cap never applies. */
const LINK_POLL_MS = 5_000;

/** The exact sentence the web app shows its sharing host — keep them in step. */
export const SHARE_RELAY_NOTE =
  'Sharing at reduced quality on this connection — Premium removes the limit.';

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
  /**
   * 'ended' is the only signal that a capture stopped without us: Chrome's own
   * "Stop sharing" bar, or the shared tab closing. It does NOT fire for a track
   * we stopped ourselves, so it always means "somebody else ended this".
   */
  addEventListener(type: 'ended', listener: () => void): void;
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
  /** Classifies link paths and applies/lifts the relay cap as a side effect. */
  pollStats(): Promise<Map<UserId, unknown>>;
  linkStates(): Map<UserId, MeshLinkState>;
  close(): void;
}

/** Everything that touches the browser, so a test can supply all of it. */
export interface ShareRuntime {
  getUserMedia(request: CaptureRequest): Promise<ShareStream>;
  createSocket(): ShareSocket;
  createMesh(opts: {
    roomId: RoomId;
    send: SignalSend;
    capRelayedVideoKbps?: number;
  }): ShareMesh;
  /**
   * The capture ended without us. Nothing outside this document can observe
   * that, so the worker's idea of "sharing" only clears because of this call.
   */
  notifyEnded(): void;
}

/** A validated 'startShare' message off the wire. */
export interface StartShareRequest {
  streamId: string;
  roomId: string;
  accessToken: string;
  source: CaptureSource;
  /** False = this surface has no sound to give; asking would cost the video. */
  canRequestAudioTrack: boolean;
  /** Only 'premium' lifts the relayed-share quality cap; a sender that does
   *  not say (today's background) shares capped — the cost risk is ours. */
  plan: Plan;
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

/** What this document answers a background command with. */
export type ShareCommandReply =
  | { ok: true; audio: boolean; note: string }
  | { ok: true; stopped: true }
  | { ok: false; error: string };

/**
 * Said to a person, never logged as a code. Reached when the audio attempt
 * failed, or when the picker said up front that this surface has none to give —
 * the same fact to whoever is watching, so the same sentence.
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
 * Best-effort audio, in the one order that never loses the video.
 *
 * A surface the picker already refused audio for is asked for video only:
 * a desktop stream id may be consumed by the rejected combined call, so the
 * retry below would have nothing to spend and the share would die outright
 * instead of degrading to silence. Tab capture always grants audio, so the
 * combined request there is byte-for-byte the one this document always made.
 */
export async function captureShare(
  opts: { streamId: string; source: CaptureSource; canRequestAudioTrack: boolean },
  getUserMedia: ShareRuntime['getUserMedia'],
): Promise<CaptureResult> {
  const video = videoConstraint(opts.source, opts.streamId);
  if (!opts.canRequestAudioTrack) {
    const stream = await getUserMedia({ video });
    return { stream, audio: false, note: SILENT_NOTE[opts.source] };
  }
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
 *
 * `canRequestAudioTrack` is read the same way round: only an explicit false
 * suppresses audio, because a sender that predates the field asked for it
 * unconditionally and a tab share always has it.
 *
 * `plan` is the opposite polarity, deliberately: only the exact string
 * 'premium' lifts the relayed-share cap. Absent (a background that predates
 * the field), junk, or anything else shares capped — degraded is defensible,
 * an operator paying relay for a free room is not.
 */
export function parseStartShare(msg: Record<string, unknown>): StartShareRequest | null {
  if (msg['kind'] !== 'startShare') return null;
  return {
    streamId: String(msg['streamId']),
    roomId: String(msg['roomId']),
    accessToken: String(msg['accessToken']),
    source: msg['source'] === 'desktop' ? 'desktop' : 'tab',
    canRequestAudioTrack: msg['canRequestAudioTrack'] !== false,
    plan: msg['plan'] === 'premium' ? 'premium' : 'free',
  };
}

const browserRuntime: ShareRuntime = {
  getUserMedia: (request) =>
    navigator.mediaDevices.getUserMedia(request as unknown as MediaStreamConstraints),
  createSocket: () => new RoomSocket(WS_URL, { replayFetch: async () => [] }),
  createMesh: ({ roomId, send, capRelayedVideoKbps }) =>
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
      ...(capRelayedVideoKbps === undefined ? {} : { capRelayedVideoKbps }),
    }),
  notifyEnded: () => {
    if (typeof chrome === 'undefined') return;
    // Nobody has to be listening: the worker may have been terminated, and it
    // reconciles from `chrome.offscreen.hasDocument()` when it comes back.
    void chrome.runtime.sendMessage({ kind: 'shareEnded' }).catch(() => undefined);
  },
};

let mesh: ShareMesh | null = null;
let socket: ShareSocket | null = null;
let stream: ShareStream | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** Periodic link poll while a capped share is live: classification (and with
 *  it the relay cap) only advances inside pollStats(), and this document is
 *  the only thing that can tick. Stops itself once the share it belongs to is
 *  gone. */
function schedulePoll(forMesh: ShareMesh): void {
  pollTimer = setTimeout(() => {
    if (mesh !== forMesh) return;
    forMesh.pollStats().then(
      () => {
        if (mesh === forMesh) schedulePoll(forMesh);
      },
      () => {
        if (mesh === forMesh) schedulePoll(forMesh);
      },
    );
  }, LINK_POLL_MS);
}

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

  const capped = opts.plan !== 'premium';
  const sharedMesh = runtime.createMesh({
    roomId,
    send: (event) => socket?.send(event.type, event.payload),
    ...(capped ? { capRelayedVideoKbps: FREE_SHARE_RELAY_KBPS } : {}),
  });
  mesh = sharedMesh;

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

  // The user can end this from Chrome's own sharing bar, and closing the
  // shared tab ends it too. Both arrive here as the video track ending, and
  // this is the only place either is observable. A track belonging to a share
  // that has already been stopped or replaced is no longer the live one, and
  // must not tear down whatever took its place.
  video?.addEventListener('ended', () => {
    if (stream !== captured.stream) return;
    teardown();
    runtime.notifyEnded();
  });

  sharedMesh.setLocalTrack('share', video as unknown as MediaStreamTrackLike);
  if (audio !== null) sharedMesh.setLocalTrack('mic', audio as unknown as MediaStreamTrackLike);

  // A silent share is still a share: the room is told it started either way.
  socket.send('restream.start', {});
  socket.send('presence.update', { sharing: true, state: 'watching' });

  if (capped) schedulePoll(sharedMesh);

  // The reply note is this document's only voice: when a link is already
  // known to run relayed on a capped plan, the quality sentence rides along
  // with whatever the capture had to say. A fresh mesh usually has no
  // classified links yet — the cap still applies on its own once a poll
  // classifies one; only the sentence is best-effort.
  const relayed = capped && [...sharedMesh.linkStates().values()].includes('relayed');
  const note = [captured.note, relayed ? SHARE_RELAY_NOTE : '']
    .filter((s) => s !== '')
    .join(' ');

  return { audio: captured.audio, note };
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

/**
 * End the share, in the order a viewer needs it: the room is told first, so
 * nobody is left holding a frozen last frame, and only then are the tracks
 * stopped and the transports closed. Module state is cleared up front so a
 * second call — a stop racing the track's own 'ended' — has nothing to do.
 */
function teardown(): void {
  const endingSocket = socket;
  const endingMesh = mesh;
  const endingStream = stream;
  socket = null;
  mesh = null;
  stream = null;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  // Peers belong to the room that just ended; carrying them into the next
  // share would link it to strangers.
  presenceMap.clear();
  if (endingSocket !== null) {
    endingSocket.send('restream.stop', {});
    endingSocket.send('presence.update', { sharing: false });
  }
  endingStream?.getTracks().forEach((t) => t.stop());
  endingMesh?.close();
  endingSocket?.close();
}

export async function stopShare(): Promise<void> {
  teardown();
}

/**
 * Everything the background can ask of this document. Returns null for a
 * message that is not ours — the popup's own traffic reaches every extension
 * context, and answering it would steal the worker's reply.
 */
export function handleShareCommand(
  msg: Record<string, unknown>,
  runtime: ShareRuntime = browserRuntime,
): Promise<ShareCommandReply> | null {
  if (msg['kind'] === 'stopShare') {
    // Stopping is answered as done even when there was nothing to stop: the
    // caller's whole purpose is to be sure nothing is still being captured.
    return stopShare().then(
      (): ShareCommandReply => ({ ok: true, stopped: true }),
      (err: unknown): ShareCommandReply => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  const request = parseStartShare(msg);
  if (request === null) return null;
  return startShare(request, runtime).then(
    (started): ShareCommandReply => ({ ok: true, audio: started.audio, note: started.note }),
    (err: unknown): ShareCommandReply => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

/**
 * Registered only inside the extension. Under test the module is imported in
 * a plain Node context with no `chrome`, and the exported functions above are
 * what is exercised.
 */
if (typeof chrome !== 'undefined' && typeof chrome.runtime?.onMessage?.addListener === 'function') {
  chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender, sendResponse) => {
    const reply = handleShareCommand(msg);
    if (reply === null) return false;
    void reply.then((value) => sendResponse(value));
    return true;
  });
}
