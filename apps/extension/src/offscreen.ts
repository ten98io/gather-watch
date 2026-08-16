/**
 * Offscreen document (MV3): the only extension context with getUserMedia +
 * RTCPeerConnection. Receives a tabCapture stream id from the background,
 * captures the tab (video + audio), and fans it out to the room as the mesh
 * 'share' track via @playin/p2p's MeshManager — the exact same Mode B path
 * the web app uses, so extension and web viewers interoperate.
 *
 * Signaling rides a second RoomSocket using the same guest token.
 */
import { MeshManager } from '@playin/p2p';
import type { RtcPeerConnectionLike } from '@playin/p2p';
import { RoomSocket } from '@playin/api-client';
import type { RoomId, UserId } from '@playin/contracts';

const WS_URL = 'ws://localhost:4000/ws';

let mesh: MeshManager | null = null;
let socket: RoomSocket | null = null;
let stream: MediaStream | null = null;

async function startShare(opts: {
  streamId: string;
  roomId: string;
  accessToken: string;
}): Promise<void> {
  await stopShare();

  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: opts.streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    } as unknown as MediaTrackConstraints,
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: opts.streamId },
    } as unknown as MediaTrackConstraints,
  });

  socket = new RoomSocket(WS_URL, {
    replayFetch: async () => [],
  });
  socket.connect(opts.roomId as RoomId, opts.accessToken);

  mesh = new MeshManager({
    roomId: opts.roomId as RoomId,
    localUserId: 'extension-host' as UserId,
    rtcFactory: (config) =>
      new RTCPeerConnection({
        iceServers: config.iceServers as RTCIceServer[],
      }) as unknown as RtcPeerConnectionLike,
    send: (event) => socket?.send(event.type, event.payload),
    now: () => Date.now(),
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: (h) => clearTimeout(h as never),
  });

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

  const video = stream.getVideoTracks()[0] ?? null;
  const audio = stream.getAudioTracks()[0] ?? null;
  mesh.setLocalTrack('share', video as never);
  if (audio !== null) mesh.setLocalTrack('mic', audio as never);

  socket.send('restream.start', {});
  socket.send('presence.update', { sharing: true, state: 'watching' });
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

async function stopShare(): Promise<void> {
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

chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender, sendResponse) => {
  if (msg['kind'] === 'startShare') {
    startShare({
      streamId: String(msg['streamId']),
      roomId: String(msg['roomId']),
      accessToken: String(msg['accessToken']),
    })
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return true;
  }
  return false;
});
