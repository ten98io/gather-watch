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
import { MeshManager, TurnCredentialManager } from '@gather/p2p';
import type {
  IceServerLike,
  InboundSignal,
  MediaStreamTrackLike,
  MeshLane,
  MeshLinkState,
  RtcPeerConnectionLike,
  SignalSend,
  TrackRole,
} from '@gather/p2p';
import { RoomSocket } from '@gather/api-client';
import type { RoomId, TurnCredentialsResponse, UserId } from '@gather/contracts';

import { API_URL, WS_URL } from './config';

/** Where a stream id came from. Chrome's constraint name for it, verbatim. */
export type CaptureSource = 'tab' | 'desktop';

/** Capture ceiling. Shared by both surfaces so mesh bitrate stays predictable. */
export const MAX_WIDTH = 1920;
export const MAX_HEIGHT = 1080;
export const MAX_FRAME_RATE = 30;

/** Ceiling for share video on links the mesh classifies as RELAYED (kbps).
 *  Direct links are never capped — this only bounds what a TURN fallback
 *  bills us per relayed viewer (~$0.186/hr for 5 at full rate, risk 1 in
 *  docs/COST_MODEL.md). Middle of the doc's 300–500 band. The BitrateGovernor
 *  adapts down from this ceiling per link once it is wired into the sender
 *  (docs/FEATURE_PLAN.md §8); until then this static ceiling is the lever. */
export const SHARE_RELAYED_VIDEO_CAP_KBPS = 400;

/** Link classification only advances inside the mesh's pollStats(), and this
 *  document owns the interval. */
const LINK_POLL_MS = 5_000;

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
  /** Classifies each link's path (direct vs relayed) as a side effect. */
  pollStats(): Promise<Map<UserId, unknown>>;
  linkStates(): Map<UserId, MeshLinkState>;
  /** Push newly-arrived ICE servers onto peers built before they landed.
   *  WebRTC does not re-read a live connection's configuration, so without
   *  this a peer linked in the share's first moments never sees TURN. */
  refreshIceServers(): void;
  close(): void;
}

/**
 * The TURN credential lifecycle this document needs; @gather/p2p's
 * TurnCredentialManager satisfies it as-is.
 *
 * TURN is what lets two people on different networks reach each other at all.
 * Without it a share works between two devices on one network and fails behind
 * most home routers — so the share starts it, and never waits for it.
 */
export interface ShareTurn {
  /** Fetch once and begin the refresh cycle. */
  start(): Promise<void>;
  stop(): void;
  /** [] until the first successful fetch, and after every failed one. */
  iceServers(): IceServerLike[];
}

/** Everything that touches the browser, so a test can supply all of it. */
export interface ShareRuntime {
  getUserMedia(request: CaptureRequest): Promise<ShareStream>;
  createSocket(): ShareSocket;
  /** `onUpdate` fires after every successful (re)fetch — the share uses it to
   *  repair peers that were built while the list was still empty. */
  createTurn(opts: { accessToken: string; onUpdate: () => void }): ShareTurn;
  createMesh(opts: {
    roomId: RoomId;
    /**
     * WHO THIS DOCUMENT IS IN THE ROOM. Every mesh derives a pair's
     * connectionId from both user ids, and the server stamps the sender's id
     * from the authenticated socket — so a name the room never issued makes
     * every frame, in both directions, fail the receiver's guard. It comes
     * from the room's own record via the worker, never from a page.
     */
    localUserId: UserId;
    /**
     * WHICH of that identity's meshes this one is.
     *
     * This document is never the person's only mesh: their web tab holds the
     * call at the same time, and both sockets authenticate as the same user.
     * A pair's connectionId is derived from both endpoint names with no round
     * trip, so two unlaned meshes for one identity compute the SAME id — and
     * a viewer answers whichever spoke first and drops the other as a glare
     * loser. Half the time that leaves them on the call with no picture; the
     * other half, on the share with no voice.
     *
     * Naming this mesh's lane is the whole of the fix (@gather/p2p folds it
     * into the id). Omitting it here makes every lane-aware line in that
     * package dead weight, silently and with a green suite.
     */
    lane?: MeshLane;
    send: SignalSend;
    /** Current TURN servers, re-read for every NEW peer connection. */
    getIceServers: () => IceServerLike[];
    /** Operator-only bitrate lever on relayed links (@gather/p2p). Nothing
     *  sets it: every share goes out at full quality for everyone. */
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
  /** The sharer's real, server-issued id. '' when the sender did not name
   *  them, which {@link startShare} refuses rather than guesses about. */
  userId: string;
  source: CaptureSource;
  /** False = this surface has no sound to give; asking would cost the video. */
  canRequestAudioTrack: boolean;
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
 * `userId` is the one field that is NOT coerced with String(): a missing one
 * would become the literal 'undefined', which is a perfectly good-looking id
 * that no room ever issued — and a share signed with it reaches nobody while
 * reporting success. Anything that is not a string reads as absent, and
 * {@link startShare} refuses an absent one.
 */
export function parseStartShare(msg: Record<string, unknown>): StartShareRequest | null {
  if (msg['kind'] !== 'startShare') return null;
  return {
    streamId: String(msg['streamId']),
    roomId: String(msg['roomId']),
    accessToken: String(msg['accessToken']),
    userId: typeof msg['userId'] === 'string' ? msg['userId'] : '',
    source: msg['source'] === 'desktop' ? 'desktop' : 'tab',
    canRequestAudioTrack: msg['canRequestAudioTrack'] !== false,
  };
}

/**
 * The one runtime that ships. Exported so the tests can drive the REAL
 * `createMesh` — the mesh's identity is derived from what this object passes
 * to MeshManager, so a test against a stand-in proves nothing about it.
 */
export const browserRuntime: ShareRuntime = {
  getUserMedia: (request) =>
    navigator.mediaDevices.getUserMedia(request as unknown as MediaStreamConstraints),
  createSocket: () => new RoomSocket(WS_URL, { replayFetch: async () => [] }),
  /**
   * The same endpoint and the same room token the web app's call uses. A
   * failure is survivable and deliberately not reported anywhere: the manager
   * retries on its own backoff, `iceServers()` stays empty meanwhile, and an
   * empty list makes MeshManager build peers on its public-STUN fallback — a
   * share that works for most people instead of no share at all.
   */
  createTurn: ({ accessToken, onUpdate }) =>
    new TurnCredentialManager({
      getTurnCredentials: async () => {
        const res = await fetch(`${API_URL}/rtc/turn-credentials`, {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error(`turn credentials: ${String(res.status)}`);
        return (await res.json()) as TurnCredentialsResponse;
      },
      now: () => Date.now(),
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      clearTimeoutFn: (h) => clearTimeout(h as never),
      onUpdate: () => onUpdate(),
    }),
  createMesh: ({ roomId, localUserId, lane, send, getIceServers, capRelayedVideoKbps }) =>
    new MeshManager({
      roomId,
      localUserId,
      // Conditional spread, not `lane`: `exactOptionalPropertyTypes` is on, so
      // an explicit `undefined` is not the same as an absent key.
      ...(lane === undefined ? {} : { lane }),
      rtcFactory: (config) =>
        new RTCPeerConnection({
          iceServers: config.iceServers as RTCIceServer[],
        }) as unknown as RtcPeerConnectionLike,
      send,
      getIceServers,
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
let turn: ShareTurn | null = null;
let stream: ShareStream | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** Periodic link poll while a share is live: link classification only advances
 *  inside pollStats(), and this document is the only thing that can tick it.
 *  Stops itself once the share it belongs to is gone. */
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

  // BEFORE anything is captured. A share signed with an id the room never
  // issued fails every viewer's connectionId guard in both directions, so it
  // reaches nobody — and capturing first would put a person's screen on a
  // stream with no receivers while telling them it worked.
  if (opts.userId.length === 0) {
    throw new Error('Gather does not know who you are in this room yet.');
  }

  // Called through the object so a runtime may implement it as a method.
  const captured = await captureShare(opts, (req) => runtime.getUserMedia(req));
  stream = captured.stream;

  const roomId = opts.roomId as RoomId;
  socket = runtime.createSocket();
  socket.connect(roomId, opts.accessToken);

  // The mesh does not exist yet, and the credentials may land before or after
  // it does — whichever way round, the peers built in between are the ones
  // that need repairing. Held in a local the update closes over rather than
  // read off module state, so a stale share cannot repair the live one.
  let liveMesh: ShareMesh | null = null;
  const sharedTurn = runtime.createTurn({
    accessToken: opts.accessToken,
    onUpdate: () => liveMesh?.refreshIceServers(),
  });
  turn = sharedTurn;
  // Deliberately NOT awaited: the room is already open and people are waiting.
  // Peers built before the answer arrives run on the mesh's public-STUN
  // fallback and are repaired by the onUpdate above.
  void sharedTurn.start();

  const sharedMesh = runtime.createMesh({
    roomId,
    localUserId: opts.userId as UserId,
    // The sharer is in this room TWICE — their call is in the web tab, this
    // is the capture — and both authenticate as the same user. The lane is
    // what keeps the two pairs' connectionIds apart; without it a viewer can
    // only ever hold one of them. See ShareRuntime.createMesh.
    lane: 'share',
    send: (event) => socket?.send(event.type, event.payload),
    getIceServers: () => sharedTurn.iceServers(),
    capRelayedVideoKbps: SHARE_RELAYED_VIDEO_CAP_KBPS,
  });
  mesh = sharedMesh;
  liveMesh = sharedMesh;

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
  // 'share-audio', never 'mic'. A role is a sender: publishing the captured
  // surface's soundtrack on the microphone role REPLACED this person's live
  // voice for the whole room the moment they shared, and withdrawing it on
  // stop left them silent with their mic button still reading "on".
  if (audio !== null) {
    sharedMesh.setLocalTrack('share-audio', audio as unknown as MediaStreamTrackLike);
  }

  // A silent share is still a share: the room is told it started either way.
  socket.send('restream.start', {});
  socket.send('presence.update', { sharing: true, state: 'watching' });

  schedulePoll(sharedMesh);

  // The capture's own sentence is the only one left: nothing about this share
  // is limited, so there is nothing else to say about its quality.
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
  const endingTurn = turn;
  socket = null;
  mesh = null;
  turn = null;
  stream = null;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  // The credential cycle re-fetches on a timer for as long as it is running.
  // A share that ended has nothing to keep credentials fresh for.
  endingTurn?.stop();
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
