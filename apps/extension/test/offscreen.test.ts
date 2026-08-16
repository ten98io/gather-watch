import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_FRAME_RATE,
  MAX_HEIGHT,
  MAX_WIDTH,
  captureShare,
  parseStartShare,
  startShare,
  stopShare,
} from '../src/offscreen';
import type {
  CaptureRequest,
  ShareMesh,
  ShareRuntime,
  ShareSocket,
  ShareStream,
  ShareTrack,
} from '../src/offscreen';
import type { InboundSignal, MediaStreamTrackLike, TrackRole } from '@playin/p2p';

/* ── fakes ────────────────────────────────────────────────────────────── */

function fakeTrack(kind: 'video' | 'audio'): ShareTrack & { stopped: boolean } {
  return {
    kind,
    stopped: false,
    stop(): void {
      this.stopped = true;
    },
  };
}

type StoppableTrack = ShareTrack & { stopped: boolean };

function fakeStream(kinds: Array<'video' | 'audio'>): ShareStream & { tracks: StoppableTrack[] } {
  const tracks = kinds.map(fakeTrack);
  return {
    tracks,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  };
}

interface FakeSocket {
  socket: ShareSocket;
  sent: Array<{ type: string; payload: unknown }>;
  handlers: Map<string, (ev: unknown) => void>;
  connected: { roomId: string; token: string } | null;
  closed: boolean;
}

/**
 * RoomSocket's `send`/`on` are correlated generics, so the fake is written
 * loosely and cast once here rather than restating those signatures.
 */
function fakeSocket(): FakeSocket {
  const state: FakeSocket = {
    socket: null as unknown as ShareSocket,
    sent: [],
    handlers: new Map(),
    connected: null,
    closed: false,
  };
  state.socket = {
    connect: (roomId: string, token: string) => {
      state.connected = { roomId, token };
    },
    send: (type: string, payload: unknown) => {
      state.sent.push({ type, payload });
    },
    on: (type: string, handler: (ev: unknown) => void) => {
      state.handlers.set(type, handler);
      return () => undefined;
    },
    close: () => {
      state.closed = true;
    },
  } as unknown as ShareSocket;
  return state;
}

interface FakeMesh extends ShareMesh {
  tracks: Map<TrackRole, MediaStreamTrackLike | null>;
  peers: string[][];
  signals: InboundSignal[];
  closed: boolean;
}

function fakeMesh(): FakeMesh {
  const mesh: FakeMesh = {
    tracks: new Map(),
    peers: [],
    signals: [],
    closed: false,
    syncPeers: (userIds) => {
      mesh.peers.push([...userIds]);
    },
    handleSignal: (ev) => {
      mesh.signals.push(ev);
    },
    setLocalTrack: (role, track) => {
      mesh.tracks.set(role, track);
    },
    close: () => {
      mesh.closed = true;
    },
  };
  return mesh;
}

interface Harness {
  runtime: ShareRuntime;
  requests: CaptureRequest[];
  sockets: FakeSocket[];
  meshes: FakeMesh[];
}

/** `media` is consulted per getUserMedia attempt: throw to reject that attempt. */
function harness(media: Array<() => ShareStream>): Harness {
  const requests: CaptureRequest[] = [];
  const sockets: FakeSocket[] = [];
  const meshes: FakeMesh[] = [];
  return {
    requests,
    sockets,
    meshes,
    runtime: {
      getUserMedia: async (request) => {
        requests.push(request);
        const next = media[requests.length - 1];
        if (next === undefined) throw new Error('unexpected extra getUserMedia call');
        return next();
      },
      createSocket: () => {
        const s = fakeSocket();
        sockets.push(s);
        return s.socket;
      },
      createMesh: () => {
        const m = fakeMesh();
        meshes.push(m);
        return m;
      },
    },
  };
}

const rejects = (message: string) => (): ShareStream => {
  throw new Error(message);
};

const request = (over: Partial<Parameters<typeof startShare>[0]> = {}) => ({
  streamId: 'stream_1',
  roomId: 'room_1',
  accessToken: 'token_1',
  source: 'tab' as const,
  ...over,
});

// The module keeps the live share in module scope; leave nothing behind.
afterEach(async () => {
  await stopShare();
});

/* ── the wire message ─────────────────────────────────────────────────── */

describe('parseStartShare', () => {
  it('ignores anything that is not a startShare', () => {
    expect(parseStartShare({ kind: 'stopShare' })).toBeNull();
    expect(parseStartShare({})).toBeNull();
  });

  it('defaults a missing source to tab — every caller predates the field', () => {
    expect(parseStartShare({ kind: 'startShare', streamId: 's', roomId: 'r', accessToken: 't' })).toEqual({
      streamId: 's',
      roomId: 'r',
      accessToken: 't',
      source: 'tab',
    });
  });

  it('selects desktop only on that exact string', () => {
    const base = { kind: 'startShare', streamId: 's', roomId: 'r', accessToken: 't' };
    expect(parseStartShare({ ...base, source: 'desktop' })?.source).toBe('desktop');
    expect(parseStartShare({ ...base, source: 'tab' })?.source).toBe('tab');
    expect(parseStartShare({ ...base, source: 'screen' })?.source).toBe('tab');
    expect(parseStartShare({ ...base, source: 42 })?.source).toBe('tab');
  });
});

/* ── capture constraints + audio degradation ──────────────────────────── */

describe('captureShare', () => {
  it('asks for tab video and tab audio, exactly as it always has', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    const res = await captureShare({ streamId: 'stream_1', source: 'tab' }, h.runtime.getUserMedia);

    expect(h.requests).toEqual([
      {
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: 'stream_1',
            maxWidth: MAX_WIDTH,
            maxHeight: MAX_HEIGHT,
            maxFrameRate: MAX_FRAME_RATE,
          },
        },
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'stream_1' } },
      },
    ]);
    expect(res.audio).toBe(true);
    expect(res.note).toBe('');
  });

  it('switches both constraints to desktop for a screen or window', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    await captureShare({ streamId: 'desk_9', source: 'desktop' }, h.runtime.getUserMedia);

    const [req] = h.requests;
    expect(req?.video.mandatory.chromeMediaSource).toBe('desktop');
    expect(req?.audio?.mandatory.chromeMediaSource).toBe('desktop');
    expect(req?.video.mandatory.chromeMediaSourceId).toBe('desk_9');
    expect(req?.video.mandatory.maxFrameRate).toBe(MAX_FRAME_RATE);
  });

  it('retries video-only when the audio request kills the whole call', async () => {
    const h = harness([rejects('NotReadableError'), () => fakeStream(['video'])]);
    const res = await captureShare({ streamId: 'desk_9', source: 'desktop' }, h.runtime.getUserMedia);

    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]).toEqual({ video: h.requests[0]?.video });
    expect(h.requests[1]?.audio).toBeUndefined();
    expect(res.stream.getVideoTracks()).toHaveLength(1);
    expect(res.audio).toBe(false);
  });

  it('treats a granted-but-silent stream as silent, without a second call', async () => {
    const h = harness([() => fakeStream(['video'])]);
    const res = await captureShare({ streamId: 'desk_9', source: 'desktop' }, h.runtime.getUserMedia);

    expect(h.requests).toHaveLength(1);
    expect(res.audio).toBe(false);
    expect(res.note.length).toBeGreaterThan(0);
  });

  it('explains a silent share in plain language, never a raw error or constraint', async () => {
    const desktop = await captureShare(
      { streamId: 'd', source: 'desktop' },
      harness([rejects('NotAllowedError'), () => fakeStream(['video'])]).runtime.getUserMedia,
    );
    const tab = await captureShare(
      { streamId: 't', source: 'tab' },
      harness([rejects('NotAllowedError'), () => fakeStream(['video'])]).runtime.getUserMedia,
    );

    for (const note of [desktop.note, tab.note]) {
      expect(note).toMatch(/^Sharing video without sound —/);
      expect(note).not.toContain('chromeMediaSource');
      expect(note).not.toContain('NotAllowedError');
    }
    expect(desktop.note).not.toBe(tab.note);
  });

  it('still fails when the video itself is unavailable', async () => {
    const h = harness([rejects('first'), rejects('stream id is stale')]);
    await expect(
      captureShare({ streamId: 'gone', source: 'desktop' }, h.runtime.getUserMedia),
    ).rejects.toThrow('stream id is stale');
  });
});

/* ── the share lifecycle ──────────────────────────────────────────────── */

describe('startShare', () => {
  it('publishes video as share and captured audio as mic, then announces it', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    const started = await startShare(request(), h.runtime);

    expect(h.sockets[0]?.connected).toEqual({ roomId: 'room_1', token: 'token_1' });
    expect(h.meshes[0]?.tracks.get('share')).not.toBeNull();
    expect(h.meshes[0]?.tracks.get('mic')).not.toBeUndefined();
    expect(h.sockets[0]?.sent).toEqual([
      { type: 'restream.start', payload: {} },
      { type: 'presence.update', payload: { sharing: true, state: 'watching' } },
    ]);
    expect(started).toEqual({ audio: true, note: '' });
  });

  it('still starts a working desktop share when audio was unavailable', async () => {
    const h = harness([rejects('NotReadableError'), () => fakeStream(['video'])]);
    const started = await startShare(request({ source: 'desktop' }), h.runtime);

    expect(h.meshes[0]?.tracks.get('share')).not.toBeNull();
    expect(h.meshes[0]?.tracks.has('mic')).toBe(false);
    expect(h.sockets[0]?.sent).toEqual([
      { type: 'restream.start', payload: {} },
      { type: 'presence.update', payload: { sharing: true, state: 'watching' } },
    ]);
    expect(started.audio).toBe(false);
    expect(started.note.length).toBeGreaterThan(0);
  });

  it('feeds presence into the mesh so late joiners get linked', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    await startShare(request(), h.runtime);

    h.sockets[0]?.handlers.get('presence.state')?.({
      payload: { entries: [{ userId: 'u1', state: 'watching' }] },
    });
    h.sockets[0]?.handlers.get('presence.diff')?.({
      payload: { upserts: [{ userId: 'u2', state: 'watching' }], removed: ['u1'] },
    });

    expect(h.meshes[0]?.peers).toEqual([['u1'], ['u2']]);
  });

  it('tears the previous share down before starting the next one', async () => {
    const first = harness([() => fakeStream(['video', 'audio'])]);
    await startShare(request(), first.runtime);

    const second = harness([() => fakeStream(['video'])]);
    await startShare(request({ source: 'desktop' }), second.runtime);

    expect(first.sockets[0]?.closed).toBe(true);
    expect(first.meshes[0]?.closed).toBe(true);
    expect(first.sockets[0]?.sent.slice(2)).toEqual([
      { type: 'restream.stop', payload: {} },
      { type: 'presence.update', payload: { sharing: false } },
    ]);
    expect(second.sockets[0]?.closed).toBe(false);
  });
});

describe('stopShare', () => {
  it('announces the stop, stops every track and closes the socket and mesh', async () => {
    const stream = fakeStream(['video', 'audio']);
    const h = harness([() => stream]);
    await startShare(request(), h.runtime);

    await stopShare();

    expect(h.sockets[0]?.sent.slice(2)).toEqual([
      { type: 'restream.stop', payload: {} },
      { type: 'presence.update', payload: { sharing: false } },
    ]);
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.meshes[0]?.closed).toBe(true);
    expect(h.sockets[0]?.closed).toBe(true);
  });

  it('is a no-op when nothing is sharing', async () => {
    await expect(stopShare()).resolves.toBeUndefined();
  });
});
