/**
 * Background service worker (MV3): owns the room connection for the
 * extension. Guest-joins via the invite code (room-scoped identity — no
 * account needed to follow; driving playback obeys the room's policy like
 * any guest). sync.state → expected position (clock math via the socket's
 * ClockEstimator) → `drive` messages to the driven tab's content script.
 * Mode B requests are forwarded to the offscreen document.
 */
import { RoomSocket } from '@playin/api-client';
import { normalizeInviteCode } from '@playin/contracts';
import type { PlaybackState, RestreamState } from '@playin/contracts';

const API_URL = 'http://localhost:4000';
const WS_URL = 'ws://localhost:4000/ws';

interface Session {
  roomId: string;
  roomName: string;
  accessToken: string;
  socket: RoomSocket;
  drivenTabId: number | null;
  playback: PlaybackState | null;
  restream: RestreamState | null;
}

let session: Session | null = null;
let lastTelemetry: Record<string, unknown> | null = null;
let provider: Record<string, unknown> | null = null;

interface GuestJoinWire {
  user: { id: string };
  room: { id: string; name: string };
  accessToken: string;
}

async function guestJoin(code: string): Promise<GuestJoinWire> {
  const res = await fetch(`${API_URL}/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteCode: normalizeInviteCode(code), displayName: 'Extension' }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(res.status === 404 ? 'Invite code not found' : `Join failed (${res.status}): ${text.slice(0, 120)}`);
  }
  return (await res.json()) as GuestJoinWire;
}

function driveTab(): void {
  if (session === null || session.drivenTabId === null || session.playback === null) return;
  const p = session.playback;
  if (p.mediaRef === null) return;
  const expected = p.playing
    ? p.positionMs + (session.socket.clock.serverNow(Date.now()) - p.serverTs) * p.rate
    : p.positionMs;
  void chrome.tabs
    .sendMessage(session.drivenTabId, {
      kind: 'drive',
      playing: p.playing,
      positionMs: expected,
      rate: p.rate,
    })
    .catch(() => undefined);
}

async function connect(code: string, tabId: number): Promise<void> {
  await disconnect();
  const joined = await guestJoin(code);
  const socket = new RoomSocket(WS_URL, {
    replayFetch: async (roomId, sinceSeq) => {
      const res = await fetch(
        `${API_URL}/rooms/${roomId}/events?since=${sinceSeq}`,
        { headers: { authorization: `Bearer ${joined.accessToken}` } },
      );
      if (!res.ok) throw new Error(`replay failed: ${res.status}`);
      const body = (await res.json()) as { events: never[] };
      return body.events;
    },
  });

  session = {
    roomId: joined.room.id,
    roomName: joined.room.name,
    accessToken: joined.accessToken,
    socket,
    drivenTabId: tabId,
    playback: null,
    restream: null,
  };

  socket.on('sync.state', (ev) => {
    if (session === null) return;
    session.playback = ev.payload;
    driveTab();
  });
  socket.on('restream.state', (ev) => {
    if (session === null) return;
    session.restream = ev.payload;
  });
  socket.connect(joined.room.id as never, joined.accessToken);

  // Follow-drift passes between state mutations.
  setInterval(driveTab, 1000);
}

async function disconnect(): Promise<void> {
  if (session !== null) {
    if (session.drivenTabId !== null) {
      void chrome.tabs.sendMessage(session.drivenTabId, { kind: 'driveOff' }).catch(() => undefined);
    }
    session.socket.close();
    session = null;
  }
}

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'WEB_RTC' as chrome.offscreen.Reason],
    justification: 'Tab capture + WebRTC fan-out for Mode B room share',
  });
}

async function startShare(): Promise<void> {
  if (session === null) throw new Error('connect to a room first');
  if (session.drivenTabId === null) throw new Error('no tab selected');
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: session.drivenTabId,
  });
  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    kind: 'startShare',
    streamId,
    roomId: session.roomId,
    accessToken: session.accessToken,
  });
}

chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, sender, sendResponse) => {
  const respond = (p: Promise<unknown>): true => {
    p.then((v) => sendResponse({ ok: true, value: v ?? null })).catch((err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true; // async response
  };

  switch (msg['kind']) {
    case 'popup:connect': {
      const code = String(msg['code'] ?? '');
      return respond(
        (async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id === undefined) throw new Error('no active tab');
          await connect(code, tab.id);
          return { roomName: session?.roomName ?? '' };
        })(),
      );
    }
    case 'popup:disconnect':
      return respond(disconnect());
    case 'popup:share':
      return respond(startShare());
    case 'popup:status':
      sendResponse({
        ok: true,
        value: {
          connected: session !== null,
          roomName: session?.roomName ?? null,
          playing: session?.playback?.playing ?? false,
          telemetry: lastTelemetry,
          provider,
        },
      });
      return true;
    case 'telemetry':
      lastTelemetry = msg;
      return false;
    case 'provider':
      provider = msg['provider'] as Record<string, unknown>;
      return false;
    default:
      return false;
  }
  void sender;
});
