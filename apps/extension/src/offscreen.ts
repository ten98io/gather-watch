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
  OutboundSignal,
  RtcPeerConnectionLike,
  SignalSend,
  TrackRole,
} from '@gather/p2p';
import { RoomSocket } from '@gather/api-client';
import type { ErrorCode, RoomId, TurnCredentialsResponse, UserId } from '@gather/contracts';

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
 * Ceiling for the share's SOUNDTRACK (bits per second), written into the
 * Opus fmtp of the audio m-line. Opus negotiated with no fmtp at all runs at
 * its speech default — one channel, around 32 kbps — which is the difference
 * between "we can hear the film" and "we can hear that a film is playing".
 * 128 kbps stereo is the usual transparent-enough music setting and costs a
 * fraction of the video beside it.
 */
export const SHARE_AUDIO_MAX_BITRATE = 128_000;

/** Written into every Opus fmtp this document negotiates. `stereo` is what we
 *  can RECEIVE, `sprop-stereo` what we SEND; both are stated because one SDP
 *  answers the other. */
const OPUS_PARAMS = `stereo=1;sprop-stereo=1;maxaveragebitrate=${String(SHARE_AUDIO_MAX_BITRATE)}`;

/** Ours replace any the far end already stated; everything else is kept. */
const OPUS_PARAM_NAMES = /^(stereo|sprop-stereo|maxaveragebitrate)=/i;

function withOpusParams(params: string): string {
  const kept = params
    .split(';')
    .map((param) => param.trim())
    .filter((param) => param.length > 0 && !OPUS_PARAM_NAMES.test(param));
  return [...kept, OPUS_PARAMS].join(';');
}

/** One `m=audio` section, with the Opus payload types it declares tuned. */
function tuneAudioSection(lines: readonly string[]): string[] {
  const opus = new Set<string>();
  for (const line of lines) {
    const rtpmap = /^a=rtpmap:(\d+) opus\//i.exec(line);
    if (rtpmap?.[1] !== undefined) opus.add(rtpmap[1]);
  }
  if (opus.size === 0) return [...lines];
  const out: string[] = [];
  const tuned = new Set<string>();
  for (const line of lines) {
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
    const pt = fmtp?.[1];
    if (pt === undefined || fmtp?.[2] === undefined || !opus.has(pt)) {
      out.push(line);
      continue;
    }
    tuned.add(pt);
    out.push(`a=fmtp:${pt} ${withOpusParams(fmtp[2])}`);
  }
  // Opus with no fmtp line at all IS the mono default — the parameters are
  // the whole point, so the line is added rather than skipped.
  for (const pt of opus) {
    if (!tuned.has(pt)) out.push(`a=fmtp:${pt} ${OPUS_PARAMS}`);
  }
  return out;
}

/**
 * Negotiate the share's sound as stereo music instead of speech.
 *
 * AUDIO M-SECTIONS ONLY: video and the data section are returned byte for
 * byte. Every audio section of every description that crosses this document
 * is the SHARE's, and never a microphone — the mic belongs to the person's
 * call mesh, which lives in another context on another peer connection, and
 * the far end of a share link publishes nothing back to us at all
 * (@gather/p2p attaches no local track to an auxiliary endpoint; see
 * MeshManager.setLocalTrack). Applying this to a mic's m-line would be a
 * different decision about a different track, and this document never sees
 * one.
 */
export function preferStereoOpus(sdp: string): string {
  const out: string[] = [];
  let section: string[] = [];
  let audio = false;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      out.push(...(audio ? tuneAudioSection(section) : section));
      section = [];
      audio = line.startsWith('m=audio ');
    }
    section.push(line);
  }
  out.push(...(audio ? tuneAudioSection(section) : section));
  // CRLF is what SDP is delimited by and what both stacks produced before us.
  return out.join('\r\n');
}

/**
 * Both halves of one negotiation carry the parameters.
 *
 * The description we SEND tells the far end what is coming and what we could
 * take back; the description we APPLY is the one Chrome reads to configure
 * its own encoder — an answer that never mentions stereo leaves this
 * document's encoder in mono however the offer read.
 */
function tuneOutbound(event: OutboundSignal): OutboundSignal {
  if (event.type === 'webrtc.ice') return event;
  return { ...event, payload: { ...event.payload, sdp: preferStereoOpus(event.payload.sdp) } };
}

function tuneInbound(event: InboundSignal): InboundSignal {
  if (event.type === 'webrtc.ice') return event;
  return { ...event, payload: { ...event.payload, sdp: preferStereoOpus(event.payload.sdp) } };
}

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
export type ShareSocket = Pick<RoomSocket, 'connect' | 'send' | 'on' | 'onStatus' | 'close'>;

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
   *
   * `reason` is a whole sentence for a person, or '' when the person already
   * knows — they pressed Chrome's own stop bar, or closed the shared tab.
   * A share the ROOM ended is the case that needs words: nothing else on the
   * screen would say why the sharing stopped.
   */
  notifyEnded(reason: string): void;
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
/**
 * Refusals of `restream.start`, by the codes the room's own share service
 * raises (services/api/src/modules/restream/service.ts): not a member or
 * banned, the room's share policy, its `maxPublishers` ceiling, a room that
 * is gone, and somebody else already holding the stage. VALIDATION is here
 * too — a frame this room will not parse is a share that never starts.
 *
 * RATE_LIMITED is deliberately NOT: it is the hub's answer to a burst of ICE
 * frames on a share that is working, and tearing the capture down for it
 * would end a live share over a moment of chatter.
 */
const REFUSAL_CODES = new Set<ErrorCode>([
  'FORBIDDEN',
  'ROOM_POLICY',
  'QUOTA_EXCEEDED',
  'NOT_FOUND',
  'CONFLICT',
  'UNAUTHORIZED',
  'VALIDATION',
]);

/** Said when the room refused the share without words of its own. */
const REFUSED_NOTE = 'The room did not accept that share — nothing is being sent to it.';

/** Said when the room's stage moved off this capture: a moderator stopped it,
 *  or somebody else took it over. */
const STAGE_LOST_NOTE = 'That share stopped — the room is no longer showing it.';

/**
 * The server's refusals are already written for people ("someone is already
 * sharing", "this room allows 4 people to publish at once"), so the sentence
 * the sharer reads is the room's own — given a capital and a full stop,
 * because it arrives as a fragment.
 */
export function refusalNote(message: string): string {
  const detail = message.trim();
  if (detail.length === 0) return REFUSED_NOTE;
  return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}${detail.endsWith('.') ? '' : '.'}`;
}

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
  notifyEnded: (reason) => {
    if (typeof chrome === 'undefined') return;
    // Nobody has to be listening: the worker may have been terminated, and it
    // reconciles from `chrome.offscreen.hasDocument()` when it comes back.
    void chrome.runtime.sendMessage({ kind: 'shareEnded', reason }).catch(() => undefined);
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
    send: (event) => {
      const tuned = tuneOutbound(event);
      socket?.send(tuned.type, tuned.payload);
    },
    getIceServers: () => sharedTurn.iceServers(),
    capRelayedVideoKbps: SHARE_RELAYED_VIDEO_CAP_KBPS,
  });
  mesh = sharedMesh;
  liveMesh = sharedMesh;

  /**
   * Has the ROOM said this capture is the share it is showing?
   *
   * It is a latch, and the whole reason the two rules below are not one. A
   * `restream.state` that names somebody else — or nobody — is a snapshot of
   * a room that has not applied our `restream.start` yet, and the snapshot
   * reply to the opening frame is exactly that: any room where anyone has
   * ever shared answers with an INACTIVE restream, which would otherwise
   * tear down the share a second after it started.
   */
  let stageIsOurs = false;

  /**
   * The room ended this share. Same teardown as Chrome's own stop bar, and the
   * same notification — the worker's "sharing" claim clears through nothing
   * else — but with a sentence, because nothing on the sharer's screen would
   * otherwise say why the sharing stopped. A share that has already been
   * replaced must not tear down the one that replaced it.
   *
   * THE TEARDOWN IS SILENT TOWARD THE ROOM, and that is the whole point of
   * this path. `restream.stop` is not scoped to the caller's own share
   * server-side — a host or a moderator may stop anybody's
   * (services/api/src/modules/restream/service.ts) — and both callers here are
   * cases where the stage is somebody else's: a refusal means it was never
   * ours, and a stage-lost means it has just become theirs. Sending the stop
   * would take a LIVE share off the room's stage, and the ordinary case is the
   * worst one: the host pressing Share while a member is already sharing is
   * exactly the person whose role lets it through.
   */
  const roomEnded = (reason: string): void => {
    if (mesh !== sharedMesh) return;
    teardown(false);
    runtime.notifyEnded(reason);
  };

  // Follow presence so late joiners get links.
  socket.on('presence.state', (ev) => {
    presenceMap.clear();
    for (const e of ev.payload.entries) presenceMap.set(e.userId, { state: e.state });
    mesh?.syncPeers([...presenceMap.keys()] as UserId[]);
  });
  socket.on('presence.diff', (ev) => {
    presenceMapApply(ev.payload.upserts, ev.payload.removed);
  });
  /**
   * The room's answer about the stage — the only one this document ever gets.
   *
   * Until it names us, nothing here has been agreed. Once it has, ANY later
   * state that is not ours is the room taking the stage away: a moderator's
   * `restream.stop`, a handoff, or the server releasing a share whose host it
   * decided had gone. The capture goes with it — a screen that keeps
   * streaming after the room stopped showing it is the one outcome this
   * document exists to prevent.
   */
  socket.on('restream.state', (ev) => {
    if (mesh !== sharedMesh) return;
    if (ev.payload.active && ev.payload.hostUserId === opts.userId) {
      if (stageIsOurs) return;
      stageIsOurs = true;
      // Now, and not a moment before: presence's `sharing` flag is what the
      // room's publisher ceiling counts, so claiming it BEFORE the ceiling
      // answered would have made this document its own exemption.
      socket?.send('presence.update', { sharing: true, state: 'watching' });
      return;
    }
    if (!stageIsOurs) return;
    roomEnded(STAGE_LOST_NOTE);
  });
  /**
   * A refusal of our `restream.start` arrives as an ephemeral error on this
   * socket and nowhere else. It is only read while the stage is still
   * unagreed: after the room accepted the share, an error is about some other
   * frame — a rate-limited ICE burst, most likely — and not about the share.
   */
  socket.on('error', (ev) => {
    if (stageIsOurs || !REFUSAL_CODES.has(ev.payload.code)) return;
    roomEnded(refusalNote(ev.payload.message));
  });
  for (const type of ['webrtc.offer', 'webrtc.answer', 'webrtc.ice'] as const) {
    socket.on(type, (ev) => mesh?.handleSignal(tuneInbound(ev)));
  }

  /**
   * The one frame every open of this socket owes the server.
   *
   * WITHOUT `wantSnapshot` the reply is NOTHING: the server only volunteers a
   * roster when it CREATED the presence entry, and this person's entry
   * already exists — their web tab made it, or the worker's 15s beat did. So
   * the roster never arrived, `syncPeers` ran on an empty set, the mesh
   * offered to nobody, and every extension share was a permanent black stage
   * for the whole room while the popup said it was sharing. The web client
   * asks on every open for the same reason (apps/web/lib/room-connection.ts).
   *
   * It carries `sharing` only once the room has agreed the stage is ours (see
   * above), which on a reconnect it already has.
   */
  const askForRoom = (): void => {
    if (mesh !== sharedMesh) return;
    socket?.send('presence.update', {
      state: 'watching',
      ...(stageIsOurs ? { sharing: true } : {}),
      wantSnapshot: true,
    });
  };
  // Every (re)open: a reconnect gets a fresh socket with no roster behind it,
  // and the peers it has to rebuild are the ones in that reply.
  socket.onStatus((status) => {
    if (status === 'open') askForRoom();
  });

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
    // No sentence: the person who ended it is the one who would read it.
    runtime.notifyEnded('');
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
  // The room's ANSWER decides whether it runs — see the restream.state and
  // error handlers above. Sent from here rather than from the open handler so
  // it is asked exactly once: a room that released this share while the
  // socket was away answers the reconnect's snapshot with an inactive stage,
  // and taking the stage back without the sharer asking would be a decision
  // this document has no business making.
  socket.send('restream.start', {});

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
 *
 * `stopRoomShare` defaults to TRUE and must: the room's stage is left showing
 * a share that no longer exists if a teardown stays quiet, which is the silent
 * failure this document exists to prevent. It is passed false in exactly the
 * two cases where the stage is NOT ours to end — see {@link roomEnded}.
 */
function teardown(stopRoomShare = true): void {
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
    if (stopRoomShare) endingSocket.send('restream.stop', {});
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
