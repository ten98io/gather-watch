/**
 * The host screen-share session — the click → capture → local feed →
 * restream.start → live chain, and the feedback contract around it: every
 * failure surfaces one plain sentence and returns the controls to a clickable
 * idle. The session lives at module level so the capture survives the
 * dialog-instance → stage-instance handoff (StagePane mounts a
 * ScreenShareStage in both places); the SSR cases prove both instances render
 * it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceEntry, RestreamState, RoomId, UserId } from '@gather/contracts';

vi.mock('@/components/ui/toast', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  }),
  Toaster: () => null,
}));

// room-render publishes the global React that classic-runtime JSX needs —
// it must load before any component module.
const { h, makeMember, makeRoom, renderInRoom, ME } = await import('./helpers/room-render');
const { toast } = await import('@/components/ui/toast');
const { closeCallMesh, getCallMesh } = await import('@/lib/call-mesh');
const {
  ScreenShareStage,
  SHARE_ACK_TIMEOUT_MS,
  SHARE_NO_ACK_NOTE,
  SHARE_NOT_STARTED_NOTE,
  resetShareHost,
  startShare,
  stopShare,
  useShareHost,
} = await import('@/components/stage/ScreenShareStage');
import type { RoomConnection } from '@/lib/room-connection';

/* ── fakes ───────────────────────────────────────────────────────────────── */

class FakeTrack {
  stopped = false;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(
    readonly id: string,
    readonly kind: 'audio' | 'video',
  ) {}
  addEventListener(type: string, fn: () => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  stop(): void {
    this.stopped = true;
  }
}

function fakeCapture(): { stream: MediaStream; video: FakeTrack; audio: FakeTrack } {
  const video = new FakeTrack('share-v', 'video');
  const audio = new FakeTrack('share-a', 'audio');
  const stream = {
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
    getTracks: () => [video, audio],
  } as unknown as MediaStream;
  return { stream, video, audio };
}

interface FakeRoomState {
  presence: Record<string, PresenceEntry>;
  restream: RestreamState | null;
  lastError: string | null;
}

/** Minimal store with zustand's (state, prev) subscribe contract. */
function miniStore(initial: FakeRoomState) {
  let state = initial;
  const subs = new Set<(s: FakeRoomState, prev: FakeRoomState) => void>();
  return {
    getState: () => state,
    setState: (patch: Partial<FakeRoomState>) => {
      const prev = state;
      state = { ...state, ...patch };
      for (const fn of [...subs]) fn(state, prev);
    },
    subscribe: (fn: (s: FakeRoomState, prev: FakeRoomState) => void) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

const HOST = 'user_host' as UserId;

const liveRestream = (hostUserId: UserId): RestreamState => ({
  active: true,
  hostUserId,
  startedAt: 1_000,
  viewerCount: 0,
  uplinkQuality: null,
});

interface FakeConn {
  conn: RoomConnection;
  store: ReturnType<typeof miniStore>;
  restreamStart: ReturnType<typeof vi.fn>;
  restreamStop: ReturnType<typeof vi.fn>;
  presenceUpdate: ReturnType<typeof vi.fn>;
}

/** `onStart` runs when restream.start is sent — the fake server's fan-out. */
function fakeConnection(onStart?: (store: ReturnType<typeof miniStore>) => void): FakeConn {
  const store = miniStore({ presence: {}, restream: null, lastError: null });
  const restreamStart = vi.fn(() => {
    onStart?.(store);
  });
  const restreamStop = vi.fn();
  const presenceUpdate = vi.fn();
  const conn = {
    roomId: 'room_share_test' as RoomId,
    rawSocket: { send: () => undefined },
    useRoomState: store,
    on: () => () => undefined,
    restreamStart,
    restreamStop,
    presenceUpdate,
  } as unknown as RoomConnection;
  return { conn, store, restreamStart, restreamStop, presenceUpdate };
}

/* ── suite ───────────────────────────────────────────────────────────────── */

const openConns: RoomConnection[] = [];

function stubDisplayMedia(impl: () => Promise<MediaStream>): void {
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: impl } });
}

/** A `window` with just the two listener methods the share session uses. This
 *  file runs in the node environment, so there is no real one. */
function stubPageLifecycle(): { emit(type: string): void; count(type: string): number } {
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
  });
  return {
    emit: (type) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    count: (type) => listeners.get(type)?.size ?? 0,
  };
}

describe('the host screen-share session', () => {
  beforeEach(() => {
    (globalThis as { fetch?: unknown }).fetch = () => Promise.reject(new Error('offline'));
  });

  afterEach(() => {
    for (const conn of openConns.splice(0)) closeCallMesh(conn);
    resetShareHost();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('reaches live and sends restream.start on the happy path, publishing the capture on the mesh', async () => {
    const { stream, video } = fakeCapture();
    stubDisplayMedia(() => Promise.resolve(stream));
    const { conn, restreamStart, presenceUpdate } = fakeConnection((store) => {
      store.setState({ restream: liveRestream(HOST) });
    });
    openConns.push(conn);

    await startShare(conn, HOST);

    expect(restreamStart).toHaveBeenCalledTimes(1);
    expect(presenceUpdate).toHaveBeenCalledWith({ sharing: true });
    expect(useShareHost.getState().phase).toBe('live');
    // The local feed is the capture itself — visible before any server echo.
    expect(useShareHost.getState().stream).toBe(stream);
    expect(getCallMesh(conn, HOST).localTrack('share')).toBe(
      video as unknown as MediaStreamTrack,
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('tears the capture down when the room ends the share out from under us', async () => {
    const { stream, video } = fakeCapture();
    stubDisplayMedia(() => Promise.resolve(stream));
    const { conn, store, restreamStop } = fakeConnection((s) => {
      s.setState({ restream: liveRestream(HOST) });
    });
    openConns.push(conn);
    await startShare(conn, HOST);
    expect(useShareHost.getState().phase).toBe('live');

    // A moderator stops the share (or hands it over): the room's word ends
    // the capture NOW — a recording indicator outliving the room's state is
    // the silent-share failure class. And no restream.stop echo: the server
    // already moved, and re-sending would stomp a takeover.
    store.setState({ restream: { ...liveRestream(HOST), active: false, hostUserId: null } });

    expect(useShareHost.getState().phase).toBe('idle');
    expect(video.stopped).toBe(true);
    expect(restreamStop).not.toHaveBeenCalled();
  });

  it('surfaces one sentence and returns to a clickable idle when the capture is refused', async () => {
    stubDisplayMedia(() =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
    );
    const { conn, restreamStart } = fakeConnection();
    openConns.push(conn);

    await startShare(conn, HOST);

    expect(toast.error).toHaveBeenCalledWith(SHARE_NOT_STARTED_NOTE);
    expect(useShareHost.getState()).toEqual({ phase: 'idle', stream: null });
    expect(restreamStart).not.toHaveBeenCalled();
  });

  it('fails with the sentence and releases the capture when the room never acknowledges', async () => {
    vi.useFakeTimers();
    const { stream, video, audio } = fakeCapture();
    stubDisplayMedia(() => Promise.resolve(stream));
    const { conn, restreamStop } = fakeConnection(); // server never answers
    openConns.push(conn);

    await startShare(conn, HOST);
    expect(useShareHost.getState().phase).toBe('starting');

    vi.advanceTimersByTime(SHARE_ACK_TIMEOUT_MS);

    expect(toast.error).toHaveBeenCalledWith(SHARE_NO_ACK_NOTE);
    expect(useShareHost.getState()).toEqual({ phase: 'idle', stream: null });
    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(true);
    expect(restreamStop).toHaveBeenCalledTimes(1);
    expect(getCallMesh(conn, HOST).localTrack('share')).toBeNull();
  });

  it('fails fast on the server error frame instead of waiting out the clock', async () => {
    const { stream, video } = fakeCapture();
    stubDisplayMedia(() => Promise.resolve(stream));
    const { conn, store, restreamStop } = fakeConnection();
    openConns.push(conn);

    await startShare(conn, HOST);
    store.setState({ lastError: 'unsupported event type: restream.start' });

    expect(toast.error).toHaveBeenCalledWith(SHARE_NO_ACK_NOTE);
    expect(useShareHost.getState()).toEqual({ phase: 'idle', stream: null });
    expect(video.stopped).toBe(true);
    expect(restreamStop).toHaveBeenCalledTimes(1);
  });

  it("tears down and tells the room when the browser's own stop bar ends the track", async () => {
    const { stream, video } = fakeCapture();
    stubDisplayMedia(() => Promise.resolve(stream));
    const { conn, restreamStop, presenceUpdate } = fakeConnection((store) => {
      store.setState({ restream: liveRestream(HOST) });
    });
    openConns.push(conn);

    await startShare(conn, HOST);
    expect(useShareHost.getState().phase).toBe('live');

    video.emit('ended');

    expect(useShareHost.getState()).toEqual({ phase: 'idle', stream: null });
    expect(restreamStop).toHaveBeenCalledTimes(1);
    expect(presenceUpdate).toHaveBeenLastCalledWith({ sharing: false });
  });

  it("publishes the capture's audio on its own role and never touches the microphone", async () => {
    const { stream, audio } = fakeCapture();
    stubDisplayMedia(() => Promise.resolve(stream));
    const { conn } = fakeConnection((store) => {
      store.setState({ restream: liveRestream(HOST) });
    });
    openConns.push(conn);

    // The host is already in the call, microphone live — the state every
    // sharing host is actually in.
    const mic = new FakeTrack('mic-live', 'audio') as unknown as MediaStreamTrack;
    const mesh = getCallMesh(conn, HOST);
    mesh.setLocalTrack('mic', mic);

    await startShare(conn, HOST);

    // Tab audio is not a microphone. Publishing it on 'mic' replaced the
    // host's voice with the tab's soundtrack for the whole room.
    expect(mesh.localTrack('share-audio')).toBe(audio as unknown as MediaStreamTrack);
    expect(mesh.localTrack('mic')).toBe(mic);
  });

  it('leaves the host publishing their microphone across a share start AND stop', async () => {
    const { stream } = fakeCapture();
    stubDisplayMedia(() => Promise.resolve(stream));
    const { conn } = fakeConnection((store) => {
      store.setState({ restream: liveRestream(HOST) });
    });
    openConns.push(conn);

    const mic = new FakeTrack('mic-live', 'audio') as unknown as MediaStreamTrack;
    const mesh = getCallMesh(conn, HOST);
    mesh.setLocalTrack('mic', mic);

    await startShare(conn, HOST);
    expect(mesh.localTrack('mic')).toBe(mic);

    stopShare();

    // Stopping the share used to null the sender the microphone was on, and
    // nothing re-published it: the host stayed muted for the rest of the room
    // while their own mic button still read "on".
    expect(mesh.localTrack('mic')).toBe(mic);
    expect(mesh.localTrack('share')).toBeNull();
    expect(mesh.localTrack('share-audio')).toBeNull();
  });

  it('releases the capture when the room mesh closes (room unmount), and TELLS THE ROOM', async () => {
    const { stream, video } = fakeCapture();
    stubDisplayMedia(() => Promise.resolve(stream));
    const { conn, restreamStop, presenceUpdate } = fakeConnection((store) => {
      store.setState({ restream: liveRestream(HOST) });
    });

    await startShare(conn, HOST);
    closeCallMesh(conn);

    expect(useShareHost.getState()).toEqual({ phase: 'idle', stream: null });
    expect(video.stopped).toBe(true);
    // The half that was missing. Leaving on the back arrow released the capture
    // and said NOTHING, so the room kept restream.active true with no share
    // behind it — the stage hijacked for everyone still in there, permanently.
    expect(restreamStop).toHaveBeenCalledTimes(1);
    expect(presenceUpdate).toHaveBeenLastCalledWith({ sharing: false });
  });

  it('still releases the capture when the goodbye cannot be sent', async () => {
    const { stream, video } = fakeCapture();
    stubDisplayMedia(() => Promise.resolve(stream));
    const { conn, restreamStop } = fakeConnection((store) => {
      store.setState({ restream: liveRestream(HOST) });
    });
    // The socket is already going away — which is the ordinary case on a room
    // unmount, because React runs RoomProvider's cleanup before this one.
    restreamStop.mockImplementation(() => {
      throw new Error('not connected');
    });

    await startShare(conn, HOST);
    closeCallMesh(conn);

    expect(video.stopped).toBe(true);
    expect(useShareHost.getState()).toEqual({ phase: 'idle', stream: null });
  });

  it('frees the share when the tab goes away (pagehide)', async () => {
    const page = stubPageLifecycle();
    const { stream, video } = fakeCapture();
    stubDisplayMedia(() => Promise.resolve(stream));
    const { conn, restreamStop } = fakeConnection((store) => {
      store.setState({ restream: liveRestream(HOST) });
    });
    openConns.push(conn);

    await startShare(conn, HOST);
    expect(page.count('pagehide')).toBe(1);

    page.emit('pagehide');

    // Closing the tab runs no React cleanup at all, so this is the ONLY signal
    // that can free the room's stage before the server's own liveness does.
    expect(restreamStop).toHaveBeenCalledTimes(1);
    expect(video.stopped).toBe(true);
    expect(useShareHost.getState()).toEqual({ phase: 'idle', stream: null });
  });

  it('leaves no pagehide listener behind once the share is over', async () => {
    const page = stubPageLifecycle();
    const { stream } = fakeCapture();
    stubDisplayMedia(() => Promise.resolve(stream));
    const { conn } = fakeConnection((store) => {
      store.setState({ restream: liveRestream(HOST) });
    });
    openConns.push(conn);

    await startShare(conn, HOST);
    stopShare();

    expect(page.count('pagehide')).toBe(0);
  });
});

describe('ScreenShareStage rendering of the session', () => {
  afterEach(() => {
    resetShareHost();
  });

  const inactive: RestreamState = {
    active: false,
    hostUserId: null,
    startedAt: null,
    viewerCount: 0,
    uplinkQuality: null,
  };

  it('shows the local feed and a stop control from the capture alone — before any server echo', () => {
    const { stream } = fakeCapture();
    Object.assign(useShareHost.getInitialState(), { phase: 'live', stream });
    useShareHost.setState({ phase: 'live', stream });

    const html = renderInRoom(
      makeRoom('watch'),
      makeMember('host'),
      {},
      h(ScreenShareStage, { restream: inactive }),
    );

    expect(html).toContain('Your shared screen preview');
    expect(html).toContain('Stop sharing');
    expect(html).not.toContain('Share a tab, window, or screen');
  });

  it('keeps the host feed on the stage-mounted instance once the room switches', () => {
    const { stream } = fakeCapture();
    Object.assign(useShareHost.getInitialState(), { phase: 'live', stream });
    useShareHost.setState({ phase: 'live', stream });

    const html = renderInRoom(
      makeRoom('watch'),
      makeMember('host'),
      {},
      h(ScreenShareStage, { restream: liveRestream(ME) }),
    );

    expect(html).toContain('Your shared screen preview');
    expect(html).toContain('Stop sharing');
  });

  it('offers a clickable Share screen button when idle', () => {
    const html = renderInRoom(
      makeRoom('watch'),
      makeMember('host'),
      {},
      h(ScreenShareStage, { restream: inactive }),
    );

    expect(html).toContain('Share screen');
  });

  it("renders the viewer surface for everyone else while a host's share is live", () => {
    const html = renderInRoom(
      makeRoom('watch'),
      makeMember('member'),
      {},
      h(ScreenShareStage, { restream: liveRestream(HOST) }),
    );

    expect(html).toContain('Connecting to the host’s screen');
  });
});
