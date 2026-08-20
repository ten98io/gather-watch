import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_FRAME_RATE,
  MAX_HEIGHT,
  MAX_WIDTH,
  SHARE_AUDIO_MAX_BITRATE,
  SHARE_RELAYED_VIDEO_CAP_KBPS,
  browserRuntime,
  captureShare,
  handleShareCommand,
  parseStartShare,
  preferStereoOpus,
  startShare,
  stopShare,
} from '../src/offscreen';
import type {
  CaptureRequest,
  ShareMesh,
  ShareRuntime,
  ShareTurn,
  ShareSocket,
  ShareStream,
  ShareTrack,
} from '../src/offscreen';
import { MeshManager } from '@gather/p2p';
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
import type { RoomId, UserId } from '@gather/contracts';

/* ── fakes ────────────────────────────────────────────────────────────── */

interface FakeTrack extends ShareTrack {
  stopped: boolean;
  /** Registered 'ended' listeners — an empty list means nobody is watching. */
  endedListeners: Array<() => void>;
  /** Fire 'ended', as Chrome does when the share is stopped from its own bar. */
  end(): void;
}

function fakeTrack(kind: 'video' | 'audio'): FakeTrack {
  const track: FakeTrack = {
    kind,
    stopped: false,
    endedListeners: [],
    stop: () => {
      track.stopped = true;
    },
    addEventListener: (type, listener) => {
      if (type === 'ended') track.endedListeners.push(listener);
    },
    end: () => {
      for (const listener of [...track.endedListeners]) listener();
    },
  };
  return track;
}

function fakeStream(kinds: Array<'video' | 'audio'>): ShareStream & { tracks: FakeTrack[] } {
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
  handlers: Map<string, Array<(ev: unknown) => void>>;
  connected: { roomId: string; token: string } | null;
  closed: boolean;
  /** Deliver one server event to whoever subscribed to it. */
  emit(type: string, payload: unknown): void;
  /**
   * The socket reaching 'open'. A real RoomSocket connects asynchronously and
   * fires this on every reconnect too, so nothing a share does before it can
   * be assumed to have reached the room.
   */
  open(): void;
  /** Everything the room was told, in order, of one type. */
  sentOf(type: string): unknown[];
}

/**
 * RoomSocket's `send`/`on` are correlated generics, so the fake is written
 * loosely and cast once here rather than restating those signatures.
 */
function fakeSocket(): FakeSocket {
  const statusHandlers: Array<(status: string) => void> = [];
  const state: FakeSocket = {
    socket: null as unknown as ShareSocket,
    sent: [],
    handlers: new Map(),
    connected: null,
    closed: false,
    emit: (type, payload) => {
      for (const handler of [...(state.handlers.get(type) ?? [])]) handler({ type, payload });
    },
    open: () => {
      for (const handler of [...statusHandlers]) handler('open');
    },
    sentOf: (type) => state.sent.filter((m) => m.type === type).map((m) => m.payload),
  };
  state.socket = {
    connect: (roomId: string, token: string) => {
      state.connected = { roomId, token };
    },
    send: (type: string, payload: unknown) => {
      state.sent.push({ type, payload });
    },
    on: (type: string, handler: (ev: unknown) => void) => {
      const list = state.handlers.get(type) ?? [];
      list.push(handler);
      state.handlers.set(type, list);
      return () => undefined;
    },
    onStatus: (handler: (status: string) => void) => {
      statusHandlers.push(handler);
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
  /** How many times the document ran a link poll against this mesh. */
  polls: number;
  /** How many times fresh credentials were pushed onto live peers. */
  refreshes: number;
  links: Map<UserId, MeshLinkState>;
  closed: boolean;
}

function fakeMesh(links: Map<UserId, MeshLinkState>): FakeMesh {
  const mesh: FakeMesh = {
    tracks: new Map(),
    peers: [],
    signals: [],
    polls: 0,
    refreshes: 0,
    links,
    closed: false,
    refreshIceServers: () => {
      mesh.refreshes += 1;
    },
    syncPeers: (userIds) => {
      mesh.peers.push([...userIds]);
    },
    handleSignal: (ev) => {
      mesh.signals.push(ev);
    },
    setLocalTrack: (role, track) => {
      mesh.tracks.set(role, track);
    },
    pollStats: () => {
      mesh.polls += 1;
      return Promise.resolve(new Map<UserId, unknown>());
    },
    linkStates: () => mesh.links,
    close: () => {
      mesh.closed = true;
    },
  };
  return mesh;
}

/** A credential manager the test drives by hand: nothing fetches, and the
 *  share must not wait on `start()` either way. */
interface FakeTurn extends ShareTurn {
  /** Access token the document handed it — the one the room was joined with. */
  accessToken: string;
  started: number;
  stopped: number;
  /** Deliver credentials as a successful fetch would, on the caller's cue. */
  deliver(servers: IceServerLike[]): void;
}

interface Harness {
  runtime: ShareRuntime;
  requests: CaptureRequest[];
  sockets: FakeSocket[];
  meshes: FakeMesh[];
  turns: FakeTurn[];
  /** What each createMesh call was configured with. */
  meshOptions: Array<{
    localUserId: UserId;
    /** Which of this identity's meshes the document asked for. */
    lane?: MeshLane | undefined;
    getIceServers?: (() => IceServerLike[]) | undefined;
    capRelayedVideoKbps?: number;
    /** The mesh's own outbound signalling path — everything the share puts on
     *  the wire goes through this, so a test can put one frame in and read
     *  what the room was really told. */
    send: SignalSend;
  }>;
  /** Every time the runtime was told the capture ended without a stop, and
   *  the sentence it was given for the person watching. */
  notices: { ended: number; reasons: string[] };
}

/** `media` is consulted per getUserMedia attempt: throw to reject that attempt.
 *  `links` seeds every created mesh's link-state map (default: none known). */
function harness(
  media: Array<() => ShareStream>,
  links: Array<[string, MeshLinkState]> = [],
): Harness {
  const requests: CaptureRequest[] = [];
  const sockets: FakeSocket[] = [];
  const meshes: FakeMesh[] = [];
  const turns: FakeTurn[] = [];
  const meshOptions: Harness['meshOptions'] = [];
  const notices: Harness['notices'] = { ended: 0, reasons: [] };
  return {
    requests,
    sockets,
    meshes,
    turns,
    meshOptions,
    notices,
    runtime: {
      createTurn: ({ accessToken, onUpdate }) => {
        let servers: IceServerLike[] = [];
        const turn: FakeTurn = {
          accessToken,
          started: 0,
          stopped: 0,
          start: async () => {
            turn.started += 1;
          },
          stop: () => {
            turn.stopped += 1;
          },
          iceServers: () => servers,
          deliver: (next) => {
            servers = next;
            onUpdate();
          },
        };
        turns.push(turn);
        return turn;
      },
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
      createMesh: (opts) => {
        meshOptions.push({
          localUserId: opts.localUserId,
          lane: opts.lane,
          getIceServers: opts.getIceServers,
          send: opts.send,
          ...(opts.capRelayedVideoKbps === undefined
            ? {}
            : { capRelayedVideoKbps: opts.capRelayedVideoKbps }),
        });
        const m = fakeMesh(new Map(links.map(([id, state]) => [id as UserId, state])));
        meshes.push(m);
        return m;
      },
      notifyEnded: (reason) => {
        notices.ended += 1;
        notices.reasons.push(reason);
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
  // The REAL authenticated id, as the server would stamp it. Every peer
  // derives the pair's connectionId from it; see the round-trip test below.
  userId: 'user_9',
  source: 'tab' as const,
  canRequestAudioTrack: true,
  ...over,
});

const startMessage = (over: Partial<Parameters<typeof startShare>[0]> = {}) => ({
  kind: 'startShare',
  ...request(over),
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
    expect(
      parseStartShare({ kind: 'startShare', streamId: 's', roomId: 'r', accessToken: 't', userId: 'u' }),
    ).toEqual({
      streamId: 's',
      roomId: 'r',
      accessToken: 't',
      userId: 'u',
      source: 'tab',
      canRequestAudioTrack: true,
    });
  });

  /**
   * A sender that does not name the user is a sender from a build that
   * predates the fix, and its share would sign every frame with an id nobody
   * in the room recognises. The empty string cannot be mistaken for an id —
   * `String(undefined)` would have produced the literal 'undefined', which
   * can — and startShare refuses it rather than capturing for nobody.
   */
  it('never invents a userId out of an absent or non-string field', () => {
    const base = { kind: 'startShare', streamId: 's', roomId: 'r', accessToken: 't' };
    expect(parseStartShare(base)?.userId).toBe('');
    expect(parseStartShare({ ...base, userId: 42 })?.userId).toBe('');
    expect(parseStartShare({ ...base, userId: null })?.userId).toBe('');
    expect(parseStartShare({ ...base, userId: 'user_9' })?.userId).toBe('user_9');
  });

  it('selects desktop only on that exact string', () => {
    const base = { kind: 'startShare', streamId: 's', roomId: 'r', accessToken: 't', userId: 'u' };
    expect(parseStartShare({ ...base, source: 'desktop' })?.source).toBe('desktop');
    expect(parseStartShare({ ...base, source: 'tab' })?.source).toBe('tab');
    expect(parseStartShare({ ...base, source: 'screen' })?.source).toBe('tab');
    expect(parseStartShare({ ...base, source: 42 })?.source).toBe('tab');
  });

  it('carries the picker’s audio answer, and only an explicit no means no', () => {
    const base = { kind: 'startShare', streamId: 's', roomId: 'r', accessToken: 't', userId: 'u' };
    expect(parseStartShare({ ...base, canRequestAudioTrack: false })?.canRequestAudioTrack).toBe(
      false,
    );
    expect(parseStartShare({ ...base, canRequestAudioTrack: true })?.canRequestAudioTrack).toBe(
      true,
    );
    expect(parseStartShare(base)?.canRequestAudioTrack).toBe(true);
  });
});

/* ── capture constraints + audio degradation ──────────────────────────── */

describe('captureShare', () => {
  it('asks for tab video and tab audio, exactly as it always has', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    const res = await captureShare(
      { streamId: 'stream_1', source: 'tab', canRequestAudioTrack: true },
      h.runtime.getUserMedia,
    );

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
    await captureShare(
      { streamId: 'desk_9', source: 'desktop', canRequestAudioTrack: true },
      h.runtime.getUserMedia,
    );

    const [req] = h.requests;
    expect(req?.video.mandatory.chromeMediaSource).toBe('desktop');
    expect(req?.audio?.mandatory.chromeMediaSource).toBe('desktop');
    expect(req?.video.mandatory.chromeMediaSourceId).toBe('desk_9');
    expect(req?.video.mandatory.maxFrameRate).toBe(MAX_FRAME_RATE);
  });

  it('retries video-only when the audio request kills the whole call', async () => {
    const h = harness([rejects('NotReadableError'), () => fakeStream(['video'])]);
    const res = await captureShare(
      { streamId: 'desk_9', source: 'desktop', canRequestAudioTrack: true },
      h.runtime.getUserMedia,
    );

    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]).toEqual({ video: h.requests[0]?.video });
    expect(h.requests[1]?.audio).toBeUndefined();
    expect(res.stream.getVideoTracks()).toHaveLength(1);
    expect(res.audio).toBe(false);
  });

  it('treats a granted-but-silent stream as silent, without a second call', async () => {
    const h = harness([() => fakeStream(['video'])]);
    const res = await captureShare(
      { streamId: 'desk_9', source: 'desktop', canRequestAudioTrack: true },
      h.runtime.getUserMedia,
    );

    expect(h.requests).toHaveLength(1);
    expect(res.audio).toBe(false);
    expect(res.note.length).toBeGreaterThan(0);
  });

  it('explains a silent share in plain language, never a raw error or constraint', async () => {
    const desktop = await captureShare(
      { streamId: 'd', source: 'desktop', canRequestAudioTrack: true },
      harness([rejects('NotAllowedError'), () => fakeStream(['video'])]).runtime.getUserMedia,
    );
    const tab = await captureShare(
      { streamId: 't', source: 'tab', canRequestAudioTrack: true },
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
      captureShare(
        { streamId: 'gone', source: 'desktop', canRequestAudioTrack: true },
        h.runtime.getUserMedia,
      ),
    ).rejects.toThrow('stream id is stale');
  });
});

/* ── a surface the picker says has no sound (every macOS screen pick) ─── */

describe('captureShare — canRequestAudioTrack: false', () => {
  it('asks for video only, so the single-use stream id is spent on the picture', async () => {
    const h = harness([() => fakeStream(['video'])]);
    const res = await captureShare(
      { streamId: 'desk_9', source: 'desktop', canRequestAudioTrack: false },
      h.runtime.getUserMedia,
    );

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.audio).toBeUndefined();
    expect(h.requests[0]?.video.mandatory.chromeMediaSourceId).toBe('desk_9');
    expect(res.audio).toBe(false);
    expect(res.note).toMatch(/^Sharing video without sound —/);
  });

  it('never spends a second attempt: the id is gone, so there is nothing to retry with', async () => {
    // The harness rejects any second getUserMedia with a different message —
    // reaching it at all means the video-only request was the retry, not the
    // first and only attempt.
    const h = harness([rejects('NotReadableError')]);

    await expect(
      captureShare(
        { streamId: 'desk_9', source: 'desktop', canRequestAudioTrack: false },
        h.runtime.getUserMedia,
      ),
    ).rejects.toThrow('NotReadableError');
    expect(h.requests).toHaveLength(1);
  });
});

/* ── the share lifecycle ──────────────────────────────────────────────── */

describe('startShare', () => {
  it('publishes video as share and captured audio as share-audio, then announces it', async () => {
    const stream = fakeStream(['video', 'audio']);
    const h = harness([() => stream]);
    const started = await startShare(request(), h.runtime);

    expect(h.sockets[0]?.connected).toEqual({ roomId: 'room_1', token: 'token_1' });
    // Identity, not "not null": `Map.get` answers undefined for a key that was
    // never set, and undefined is not null.
    expect(h.meshes[0]?.tracks.get('share')).toBe(stream.getVideoTracks()[0]);
    expect(h.meshes[0]?.tracks.get('share-audio')).toBe(stream.getAudioTracks()[0]);
    // The captured surface's sound is NOT the person's microphone. Publishing
    // it on 'mic' replaced the sharer's live voice for the whole room, and
    // withdrawing it on stop left them silent with the mic button still on.
    expect(h.meshes[0]?.tracks.has('mic')).toBe(false);
    // The room is ASKED, and nothing is claimed: presence's `sharing` flag is
    // what the room's publisher ceiling counts, so it waits for the answer
    // (see 'the room's answer' below).
    expect(h.sockets[0]?.sent).toEqual([{ type: 'restream.start', payload: {} }]);
    expect(started).toEqual({ audio: true, note: '' });
  });

  it('still starts a working desktop share when audio was unavailable', async () => {
    const stream = fakeStream(['video']);
    const h = harness([rejects('NotReadableError'), () => stream]);
    const started = await startShare(request({ source: 'desktop' }), h.runtime);

    expect(h.meshes[0]?.tracks.get('share')).toBe(stream.getVideoTracks()[0]);
    expect(h.meshes[0]?.tracks.has('share-audio')).toBe(false);
    expect(h.meshes[0]?.tracks.has('mic')).toBe(false);
    expect(h.sockets[0]?.sent).toEqual([{ type: 'restream.start', payload: {} }]);
    expect(started.audio).toBe(false);
    expect(started.note.length).toBeGreaterThan(0);
  });

  it('starts a silent screen share in one capture call when the picker said no sound', async () => {
    const stream = fakeStream(['video']);
    const h = harness([() => stream]);
    const started = await startShare(
      request({ source: 'desktop', canRequestAudioTrack: false }),
      h.runtime,
    );

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.audio).toBeUndefined();
    expect(h.meshes[0]?.tracks.get('share')).toBe(stream.getVideoTracks()[0]);
    expect(started.audio).toBe(false);
  });

  it('feeds presence into the mesh so late joiners get linked', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    await startShare(request(), h.runtime);
    // The roster only arrives because the open frame asked for it; see 'the
    // room's answer' below for why an unasked-for one never comes.
    h.sockets[0]?.open();

    h.sockets[0]?.emit('presence.state', { entries: [{ userId: 'u1', state: 'watching' }] });
    h.sockets[0]?.emit('presence.diff', {
      upserts: [{ userId: 'u2', state: 'watching' }],
      removed: ['u1'],
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
    expect(first.sockets[0]?.sent.slice(1)).toEqual([
      { type: 'restream.stop', payload: {} },
      { type: 'presence.update', payload: { sharing: false } },
    ]);
    expect(second.sockets[0]?.closed).toBe(false);
  });
});

/* ── the room's answer ────────────────────────────────────────────────── */

/**
 * The share is a CONVERSATION with the room, and for a long time this document
 * only spoke.
 *
 * It opened its own socket and sent `presence.update { sharing, state }` with
 * no `wantSnapshot`. Server-side the roster is volunteered only to a member
 * whose presence entry was CREATED by that frame (services/api/src/modules/
 * rooms/ws.ts) — and this person's entry always exists already: their web tab
 * made it, or the worker's 15s beat did. So no roster came back, the presence
 * map stayed empty, `syncPeers` ran on an empty set, the mesh offered to
 * nobody, and viewers only ever ANSWER a share offer — they never dial one.
 * Every extension share was therefore a permanent black stage for the whole
 * room, while `restream.start` succeeded and the popup said "Sharing this tab
 * with the room".
 *
 * The other half of the conversation is the room's answer to the share
 * itself: a refusal, or a stage that later moves off this capture.
 */
describe('the room’s answer', () => {
  const stage = (over: Record<string, unknown> = {}) => ({
    active: true,
    hostUserId: 'user_9',
    startedAt: 1_000,
    viewerCount: 0,
    uplinkQuality: null,
    ...over,
  });

  it('asks for the roster on every open — an unasked-for one never comes', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await startShare(request(), h.runtime);
    const socket = h.sockets[0];

    // Nothing is asked before the socket is open; a real one queues sends and
    // opens later, so the ask belongs to the open and not to startShare.
    expect(socket?.sentOf('presence.update')).toEqual([]);

    socket?.open();
    expect(socket?.sentOf('presence.update')).toEqual([
      { wantSnapshot: true },
    ]);

    // A reconnect is a fresh socket with no roster behind it: the peers it has
    // to rebuild are the ones in that reply, so it asks again.
    socket?.open();
    expect(socket?.sentOf('presence.update')).toEqual([
      { wantSnapshot: true },
      { wantSnapshot: true },
    ]);
  });

  it('claims `sharing` only once the room says the stage is ours', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await startShare(request({ userId: 'user_9' }), h.runtime);
    const socket = h.sockets[0];
    socket?.open();

    // The room's publisher ceiling counts presence's `sharing` flag, and a
    // member already flagged takes their own slot — so claiming it before
    // restream.start was answered made this document its own exemption.
    expect(socket?.sentOf('presence.update')).toEqual([
      { wantSnapshot: true },
    ]);

    socket?.emit('restream.state', stage());

    expect(socket?.sentOf('presence.update')).toEqual([
      { wantSnapshot: true },
      { sharing: true },
    ]);
  });

  it('re-asserts the claim on the reconnect that follows, without re-taking the stage', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await startShare(request({ userId: 'user_9' }), h.runtime);
    const socket = h.sockets[0];
    socket?.open();
    socket?.emit('restream.state', stage());

    socket?.open();

    expect(socket?.sentOf('presence.update')).toEqual([
      { wantSnapshot: true },
      { sharing: true },
      { sharing: true, wantSnapshot: true },
    ]);
    // The stage is asked for ONCE. Re-taking it on every reconnect would put
    // this capture back on a room that had released it, which is a decision
    // for the person, not for a socket that came back.
    expect(socket?.sentOf('restream.start')).toHaveLength(1);
  });

  it('tears the capture down when the room refuses the share', async () => {
    const stream = fakeStream(['video', 'audio']);
    const h = harness([() => stream]);
    await startShare(request(), h.runtime);
    h.sockets[0]?.open();

    // What a second sharer, a banned member, or a room at its publisher
    // ceiling gets back: an ephemeral error on this socket and nothing else.
    h.sockets[0]?.emit('error', { code: 'CONFLICT', message: 'someone is already sharing' });

    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.meshes[0]?.closed).toBe(true);
    expect(h.sockets[0]?.closed).toBe(true);
    expect(h.notices.ended).toBe(1);
    // The room's own words, made into a sentence — the sharer is the only one
    // who can act on the difference between "someone else is sharing" and
    // "this room is full".
    expect(h.notices.reasons).toEqual(['Someone is already sharing.']);
  });

  it('never stops the share it was refused in favour of', async () => {
    // `restream.stop` is NOT scoped to the caller's own share server-side: a
    // host or moderator may stop anybody's. So a refused sharer who sends it
    // on the way out takes the LIVE share off the room's stage — and the
    // ordinary case is the worst one, because the host pressing Share while a
    // member is already sharing is exactly who has the role to do it.
    const stream = fakeStream(['video', 'audio']);
    const h = harness([() => stream]);
    await startShare(request(), h.runtime);
    h.sockets[0]?.open();

    h.sockets[0]?.emit('error', { code: 'CONFLICT', message: 'someone is already sharing' });

    const sent = h.sockets[0]?.sent.map((f) => f.type) ?? [];
    expect(sent).not.toContain('restream.stop');
    // Our own presence still has to be corrected — that statement is about
    // this member and is true either way, and the ceiling counts it.
    expect(sent).toContain('presence.update');
  });

  it('still stops the room share on every teardown that is not a refusal', async () => {
    // The suppression above is narrow ON PURPOSE. A teardown that stays quiet
    // leaves the room's stage showing a share that no longer exists, which is
    // the silent failure this document exists to prevent — so the default has
    // to stay "tell the room", and only the two not-ours paths opt out.
    const stream = fakeStream(['video', 'audio']);
    const h = harness([() => stream]);
    await startShare(request(), h.runtime);
    h.sockets[0]?.open();

    await stopShare();

    expect(h.sockets[0]?.sent.map((f) => f.type)).toContain('restream.stop');
  });

  it('stays quiet when the stage is taken over by somebody else', async () => {
    const stream = fakeStream(['video', 'audio']);
    const h = harness([() => stream]);
    await startShare(request(), h.runtime);
    h.sockets[0]?.open();
    h.sockets[0]?.emit('restream.state', { active: true, hostUserId: 'user_9', viewerCount: 0 });
    const before = h.sockets[0]?.sent.length ?? 0;

    // Our presence lapsed and the room let somebody else take the stage. The
    // share now on it is theirs; stopping it is not ours to do.
    h.sockets[0]?.emit('restream.state', { active: true, hostUserId: 'user_other', viewerCount: 0 });

    const after = (h.sockets[0]?.sent ?? []).slice(before).map((f) => f.type);
    expect(after).not.toContain('restream.stop');
  });

  it('says something a person can act on for every refusal the room can send', async () => {
    for (const [code, message, sentence] of [
      ['QUOTA_EXCEEDED', 'this room allows 4 people to publish at once', 'This room allows 4 people to publish at once.'],
      ['ROOM_POLICY', 'sharing is not allowed for your role in this room', 'Sharing is not allowed for your role in this room.'],
      ['FORBIDDEN', '', 'The room did not accept that share — nothing is being sent to it.'],
    ] as const) {
      const h = harness([() => fakeStream(['video'])]);
      await startShare(request(), h.runtime);
      h.sockets[0]?.open();

      h.sockets[0]?.emit('error', { code, message });

      expect(h.notices.reasons).toEqual([sentence]);
      expect(h.notices.reasons[0]).not.toContain(code);
    }
  });

  it('keeps sharing through an error that is not an answer about the share', async () => {
    const stream = fakeStream(['video']);
    const h = harness([() => stream]);
    await startShare(request(), h.runtime);
    h.sockets[0]?.open();

    // The hub's answer to a burst of ICE on a share that is working. Ending a
    // live share over a moment of chatter is the cure being worse.
    h.sockets[0]?.emit('error', { code: 'RATE_LIMITED', message: 'too many messages' });

    expect(stream.tracks.some((t) => t.stopped)).toBe(false);
    expect(h.notices.ended).toBe(0);
  });

  it('ignores a stage the room has not applied its start to yet', async () => {
    const stream = fakeStream(['video']);
    const h = harness([() => stream]);
    await startShare(request({ userId: 'user_9' }), h.runtime);
    h.sockets[0]?.open();

    // The snapshot reply to the opening ask, in ANY room where somebody has
    // ever shared: an inactive stage, describing the room a moment before
    // restream.start reached it. Tearing down here would kill every share a
    // second after it started.
    h.sockets[0]?.emit('restream.state', stage({ active: false, hostUserId: null }));

    expect(stream.tracks.some((t) => t.stopped)).toBe(false);
    expect(h.notices.ended).toBe(0);

    // …and the share still starts when the room does answer.
    h.sockets[0]?.emit('restream.state', stage());
    expect(h.sockets[0]?.sentOf('presence.update')).toContainEqual({ sharing: true });
  });

  it('stops capturing when a moderator stops the share', async () => {
    const stream = fakeStream(['video', 'audio']);
    const h = harness([() => stream]);
    await startShare(request({ userId: 'user_9' }), h.runtime);
    h.sockets[0]?.open();
    h.sockets[0]?.emit('restream.state', stage());

    // restream.stop by a host or moderator: the room broadcasts an inactive
    // stage, and this document is the only thing that can act on it — nothing
    // else can see the capture, let alone end it.
    h.sockets[0]?.emit('restream.state', stage({ active: false, hostUserId: null }));

    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.meshes[0]?.closed).toBe(true);
    expect(h.sockets[0]?.closed).toBe(true);
    expect(h.notices.reasons).toEqual(['That share stopped — the room is no longer showing it.']);
  });

  it('stops capturing when somebody else takes the stage', async () => {
    const stream = fakeStream(['video']);
    const h = harness([() => stream]);
    await startShare(request({ userId: 'user_9' }), h.runtime);
    h.sockets[0]?.open();
    h.sockets[0]?.emit('restream.state', stage());

    h.sockets[0]?.emit('restream.state', stage({ hostUserId: 'user_web' }));

    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.notices.ended).toBe(1);
  });

  it('claims the stage once, however often the room restates it', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await startShare(request({ userId: 'user_9' }), h.runtime);
    const socket = h.sockets[0];
    socket?.open();

    socket?.emit('restream.state', stage());
    // The room restates the stage on every viewer who joins or leaves it, and
    // a presence frame per viewer is a frame per viewer for nothing.
    socket?.emit('restream.state', stage({ viewerCount: 1 }));
    socket?.emit('restream.state', stage({ viewerCount: 2 }));

    expect(socket?.sentOf('presence.update')).toEqual([
      { wantSnapshot: true },
      { sharing: true },
    ]);
  });

  /** The twin of the case below, on the path that has no guard of its own:
   *  a refusal is read while the stage is still unagreed, which is exactly
   *  the state a share that was replaced before the room ever answered is
   *  left in. */
  it('cannot be refused out of existence by the share it replaced', async () => {
    const first = harness([() => fakeStream(['video'])]);
    await startShare(request({ userId: 'user_9' }), first.runtime);
    first.sockets[0]?.open();

    const second = harness([() => fakeStream(['video'])]);
    await startShare(request({ userId: 'user_9', source: 'desktop' }), second.runtime);
    second.sockets[0]?.open();

    first.sockets[0]?.emit('error', { code: 'CONFLICT', message: 'someone is already sharing' });

    expect(second.sockets[0]?.closed).toBe(false);
    expect(second.meshes[0]?.closed).toBe(false);
    expect(first.notices.ended).toBe(0);
  });

  it('cannot be ended by the room that its replacement is in', async () => {
    const first = harness([() => fakeStream(['video'])]);
    await startShare(request({ userId: 'user_9' }), first.runtime);
    first.sockets[0]?.open();
    first.sockets[0]?.emit('restream.state', stage());

    const second = harness([() => fakeStream(['video'])]);
    await startShare(request({ userId: 'user_9', source: 'desktop' }), second.runtime);

    // The old socket is closed but its handlers are still callable, and a
    // frame already in flight arrives after the swap.
    first.sockets[0]?.emit('restream.state', stage({ active: false, hostUserId: null }));

    expect(second.sockets[0]?.closed).toBe(false);
    expect(second.meshes[0]?.closed).toBe(false);
    expect(first.notices.ended).toBe(0);
  });
});

/* ── who the share says it is ─────────────────────────────────────────── */

/**
 * The share's own identity is the whole of D2. A mesh derives every pair's
 * connectionId from BOTH user ids, and the server stamps the sender's id from
 * the authenticated socket — so a document signing as anything other than the
 * real member computes an id no viewer can match, and every frame in both
 * directions is dropped while the sharer is told the share started.
 */
describe('the share’s identity', () => {
  it('signs the mesh with the room’s real userId, not a fixed name', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await startShare(request({ userId: 'user_9' }), h.runtime);

    expect(h.meshOptions[0]?.localUserId).toBe('user_9');
  });

  it('refuses to capture at all when nothing named the user', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await expect(startShare(request({ userId: '' }), h.runtime)).rejects.toThrow(/who you are/i);
    // Nothing was captured and nothing joined the room: a share that cannot
    // reach anybody must not look like one that did.
    expect(h.requests).toHaveLength(0);
    expect(h.sockets).toHaveLength(0);
    expect(h.meshes).toHaveLength(0);
  });
});

/* ── the round trip: a real mesh, a real guard ────────────────────────── */

/**
 * Enough RTCPeerConnection for perfect negotiation to run: implicit
 * setLocalDescription, the two signaling-state transitions the negotiator
 * branches on, and a data channel whose creation fires `negotiationneeded` —
 * which is what really happens when the mesh builds its channel fabric.
 */
function fakePeerConnection(): import('@gather/p2p').RtcPeerConnectionLike {
  let sdpSeq = 0;
  const pc: import('@gather/p2p').RtcPeerConnectionLike = {
    localDescription: null,
    remoteDescription: null,
    signalingState: 'stable',
    connectionState: 'new',
    onnegotiationneeded: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    ontrack: null,
    ondatachannel: null,
    createOffer: async () => ({ type: 'offer', sdp: `offer-${String((sdpSeq += 1))}` }),
    createAnswer: async () => ({ type: 'answer', sdp: `answer-${String((sdpSeq += 1))}` }),
    setLocalDescription: async (description) => {
      // Parameterless is the spec's implicit form: answer a remote offer,
      // otherwise offer.
      const answering = pc.signalingState === 'have-remote-offer';
      pc.localDescription = description ?? {
        type: answering ? 'answer' : 'offer',
        sdp: `${answering ? 'answer' : 'offer'}-${String((sdpSeq += 1))}`,
      };
      pc.signalingState = answering ? 'stable' : 'have-local-offer';
    },
    setRemoteDescription: async (description) => {
      pc.remoteDescription = description;
      pc.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    },
    addIceCandidate: async () => undefined,
    addTrack: () => {
      // A real stack renegotiates when a track joins a connection. For the
      // share's mesh this is the ONLY thing that makes it offer at all: an
      // auxiliary endpoint builds no DataChannel fabric, so nothing else
      // fires `negotiationneeded` on its peers.
      queueMicrotask(() => pc.onnegotiationneeded?.());
      return {
        track: null,
        getParameters: () => ({ encodings: [] }),
        setParameters: async () => undefined,
      };
    },
    removeTrack: () => undefined,
    getSenders: () => [],
    createDataChannel: (label) => {
      const channel = {
        label,
        readyState: 'connecting' as const,
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        onbufferedamountlow: null,
        send: () => undefined,
        close: () => undefined,
      };
      // A real stack renegotiates for a new channel; the mesh's fabric is what
      // gets a freshly built peer to offer at all.
      queueMicrotask(() => pc.onnegotiationneeded?.());
      return channel;
    },
    close: () => {
      pc.signalingState = 'closed';
    },
  };
  return pc;
}

/** Timers the tests never need to fire: the offer retry and the ICE repair
 *  poll would otherwise outlive the test. */
const noTimers = {
  now: () => 1_000,
  setTimeoutFn: () => null,
  clearTimeoutFn: () => undefined,
};

/**
 * A viewer in the web app, built exactly as apps/web/lib/call-mesh.ts builds
 * it, offering to whoever the extension says it is. The offer it emits
 * carries the connectionId THAT side computed — nothing here restates the
 * derivation, so the test cannot agree with a wrong implementation.
 */
async function viewerOffer(toUserId: string): Promise<{ connectionId: string; sdp: string }> {
  const outbox: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const viewer = new MeshManager({
    roomId: 'room_1' as RoomId,
    localUserId: 'user_web' as UserId,
    rtcFactory: fakePeerConnection,
    send: (event) => {
      outbox.push({ type: event.type, payload: event.payload as Record<string, unknown> });
    },
    ...noTimers,
  });
  viewer.syncPeers([toUserId as UserId]);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  viewer.close();
  const offer = outbox.find((e) => e.type === 'webrtc.offer');
  if (offer === undefined) throw new Error('the viewer never offered');
  return {
    connectionId: String(offer.payload['connectionId']),
    sdp: String(offer.payload['sdp']),
  };
}

describe('a share’s signalling frames, through the real connectionId guard', () => {
  /**
   * The whole round trip, with the extension's real mesh on the receiving
   * end: whatever id the offscreen document decided to sign with is the id
   * this mesh is built on. The frame is stamped the way the hub stamps it
   * (services/api/src/ws/hub.ts: fromUserId comes from the authenticated
   * socket, never from the payload), so a document signing as anything else
   * is exactly what the guard is there to drop.
   */
  it('reaches the sharing document, and is answered', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await startShare(request({ userId: 'user_9' }), h.runtime);
    const signedAs = h.meshOptions[0]?.localUserId;
    if (signedAs === undefined) throw new Error('the document built no mesh');

    const offer = await viewerOffer(signedAs);

    const replies: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sharer = new MeshManager({
      roomId: 'room_1' as RoomId,
      localUserId: signedAs,
      rtcFactory: fakePeerConnection,
      send: (event) => {
        replies.push({ type: event.type, payload: event.payload as Record<string, unknown> });
      },
      ...noTimers,
    });
    sharer.handleSignal({
      type: 'webrtc.offer',
      roomId: 'room_1' as RoomId,
      seq: 1,
      ts: 1_000,
      payload: {
        // Exactly what the hub relays: the sender's id stamped from the
        // authenticated socket, and the pair it belongs to.
        fromUserId: 'user_web' as UserId,
        targetUserId: signedAs,
        connectionId: offer.connectionId,
        sdp: offer.sdp,
      },
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    // Admitted, not dropped — and it answered on the same pair id, which is
    // the only thing that gets media flowing.
    expect(sharer.peers()).toEqual(['user_web']);
    expect(replies.map((r) => r.type)).toContain('webrtc.answer');
    expect(replies.find((r) => r.type === 'webrtc.answer')?.payload['connectionId']).toBe(
      offer.connectionId,
    );
    sharer.close();
  });

  it('is dropped when the document signs with a name the room never issued', async () => {
    // The exact defect: a fixed local name, and the pair ids stop agreeing.
    const offer = await viewerOffer('user_9');

    const replies: string[] = [];
    const sharer = new MeshManager({
      roomId: 'room_1' as RoomId,
      localUserId: 'extension-host' as UserId,
      rtcFactory: fakePeerConnection,
      send: (event) => {
        replies.push(event.type);
      },
      ...noTimers,
    });
    sharer.handleSignal({
      type: 'webrtc.offer',
      roomId: 'room_1' as RoomId,
      seq: 1,
      ts: 1_000,
      payload: {
        fromUserId: 'user_web' as UserId,
        targetUserId: 'user_9' as UserId,
        connectionId: offer.connectionId,
        sdp: offer.sdp,
      },
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(sharer.peers()).toEqual([]);
    expect(replies).toEqual([]);
    sharer.close();
  });
});

/* ── two meshes, one identity: the share's lane ───────────────────────── */

/**
 * The share is the SECOND mesh this person runs. Their web tab holds the call
 * and this document holds the capture, and both authenticate as the same
 * user — correctly, because the server stamps `fromUserId` from the socket.
 * A pair's connectionId is derived from both endpoint names with no round
 * trip, so while this document named itself with the bare user id the two
 * meshes computed the SAME id: a viewer answered whichever spoke first and
 * dropped the other as a glare loser, landing about half the time on the call
 * and never seeing the share, and the other half on the share and never
 * hearing the voice.
 *
 * @gather/p2p carries the fix — an auxiliary mesh names itself `user/lane` —
 * but it only applies to a mesh that is actually BUILT with a lane. These
 * tests run the real MeshManager through the document's own production
 * runtime, so nothing here can agree with a mesh that was never told.
 */

/** One connection the production runtime built, and what it opened on it. */
interface BuiltPeerConnection {
  pc: RtcPeerConnectionLike;
  /** DataChannel labels created on it — the fabric, when there is one. */
  channels: string[];
}

/**
 * `browserRuntime.createMesh` reaches for the platform's own
 * RTCPeerConnection, which is the point: these tests exercise the wiring that
 * ships rather than a copy of it. The test supplies that one primitive.
 */
function installFakeRtc(): { built: BuiltPeerConnection[]; restore: () => void } {
  const built: BuiltPeerConnection[] = [];
  const scope = globalThis as unknown as { RTCPeerConnection?: unknown };
  const previous = scope.RTCPeerConnection;
  scope.RTCPeerConnection = function RTCPeerConnectionStub(): RtcPeerConnectionLike {
    const pc = fakePeerConnection();
    const entry: BuiltPeerConnection = { pc, channels: [] };
    const create = pc.createDataChannel;
    pc.createDataChannel = (label, init) => {
      entry.channels.push(label);
      return create(label, init);
    };
    built.push(entry);
    return pc;
  };
  return {
    built,
    restore: () => {
      scope.RTCPeerConnection = previous;
    },
  };
}

/** Let every queued microtask — offer, setLocalDescription, send — settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/**
 * A live share, built by `startShare` through the REAL createMesh: only the
 * browser edges (capture, socket, TURN) are faked. Returns the offer the
 * document's own mesh put on the wire for `viewerId`.
 */
async function shareOfferTo(
  viewerId: string,
  userId = 'user_9',
): Promise<{ connectionId: string; sdp: string; built: BuiltPeerConnection[] }> {
  const rtc = installFakeRtc();
  try {
    const h = harness([() => fakeStream(['video'])]);
    const runtime: ShareRuntime = { ...h.runtime, createMesh: browserRuntime.createMesh };
    await startShare(request({ userId }), runtime);

    h.sockets[0]?.emit('presence.state', { entries: [{ userId: viewerId, state: 'watching' }] });
    await settle();

    const offer = h.sockets[0]?.sent.find((s) => s.type === 'webrtc.offer');
    if (offer === undefined) throw new Error('the share’s mesh never offered');
    const payload = offer.payload as Record<string, unknown>;
    return {
      connectionId: String(payload['connectionId']),
      sdp: String(payload['sdp']),
      built: rtc.built,
    };
  } finally {
    await stopShare();
    rtc.restore();
  }
}

describe('the share is a second mesh, not a second claim on the same one', () => {
  it('asks for the share lane — the whole fix is inert on a mesh that was never told', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await startShare(request({ userId: 'user_9' }), h.runtime);

    expect(h.meshOptions[0]?.lane).toBe('share');
  });

  it('derives a different connectionId than the call does for the same pair', async () => {
    const call = await viewerOffer('user_9');
    const share = await shareOfferTo('user_web');

    expect(share.connectionId).not.toBe(call.connectionId);
  });

  it('leaves the primary derivation byte-for-byte what it always was', async () => {
    // Two clients derive this with no round trip, so an old build and a new
    // one only meet each other while this exact string is unchanged.
    const call = await viewerOffer('user_9');

    expect(call.connectionId).toBe('mesh:room_1:user_9~user_web');
  });

  it('opens no DataChannel fabric — the call owns this person’s sync channels', async () => {
    const share = await shareOfferTo('user_web');

    // The fabric is keyed by USER. A share that built 'sync'/'file'/'emote'
    // under the same id replaces the call's channels with an offscreen
    // document's, taking sync, file transfer and emotes down with it.
    expect(share.built.flatMap((b) => b.channels)).toEqual([]);
  });

  it('coexists with that person’s call: the viewer holds both, on two ids', async () => {
    const share = await shareOfferTo('user_web');

    const outbox: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const viewer = new MeshManager({
      roomId: 'room_1' as RoomId,
      localUserId: 'user_web' as UserId,
      rtcFactory: fakePeerConnection,
      send: (event) => {
        outbox.push({ type: event.type, payload: event.payload as Record<string, unknown> });
      },
      ...noTimers,
    });
    // The call first: this is the connection the share used to collide with.
    viewer.syncPeers(['user_9' as UserId]);
    await settle();
    const call = outbox.find((e) => e.type === 'webrtc.offer');
    if (call === undefined) throw new Error('the viewer never offered to the call');

    viewer.handleSignal({
      type: 'webrtc.offer',
      roomId: 'room_1' as RoomId,
      seq: 1,
      ts: 1_000,
      payload: {
        // Stamped by the hub from the authenticated socket: the sharer and
        // the caller really are the same person.
        fromUserId: 'user_9' as UserId,
        targetUserId: 'user_web' as UserId,
        connectionId: share.connectionId,
        sdp: share.sdp,
      },
    });
    await settle();

    // One person, two live endpoints — and the share was ANSWERED rather than
    // routed into the call's negotiator and lost to glare.
    expect(viewer.peers()).toEqual(['user_9']);
    const answered = outbox
      .filter((e) => e.type === 'webrtc.answer')
      .map((e) => String(e.payload['connectionId']));
    expect(answered).toEqual([share.connectionId]);
    expect(String(call.payload['connectionId'])).not.toBe(share.connectionId);
    viewer.close();
  });
});

/* ── TURN: the share works from behind a symmetric NAT ────────────────── */

describe('TURN credentials', () => {
  it('fetches with the room’s own token and hands the servers to the mesh', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await startShare(request({ accessToken: 'token_1' }), h.runtime);

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]?.accessToken).toBe('token_1');
    expect(h.turns[0]?.started).toBe(1);

    const relay: IceServerLike[] = [
      { urls: ['turn:turn.example:3478'], username: 'u', credential: 'c' },
    ];
    h.turns[0]?.deliver(relay);
    expect(h.meshOptions[0]?.getIceServers?.()).toEqual(relay);
  });

  /**
   * Credentials that land AFTER a peer was built reach that peer only through
   * refreshIceServers(): WebRTC does not re-read a live connection's config,
   * so a viewer linked in the first moments of a share would otherwise run
   * host-and-STUN-only for the whole share.
   */
  it('repairs peers that were built before the credentials landed', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await startShare(request(), h.runtime);

    expect(h.meshes[0]?.refreshes).toBe(0);
    h.turns[0]?.deliver([{ urls: ['turn:turn.example:3478'] }]);
    expect(h.meshes[0]?.refreshes).toBe(1);
  });

  it('starts the share anyway when the credentials never arrive', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    const started = await startShare(request(), h.runtime);

    // Nothing delivered: the mesh reads an empty list and falls back to its
    // own public STUN, which is a share that works for most people rather
    // than no share at all.
    expect(h.meshOptions[0]?.getIceServers?.()).toEqual([]);
    expect(h.meshes[0]?.tracks.get('share')).toBeDefined();
    expect(started.audio).toBe(true);
  });

  it('stops the refresh cycle when the share ends', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await startShare(request(), h.runtime);
    await stopShare();

    expect(h.turns[0]?.stopped).toBe(1);
  });
});

/* ── the soundtrack: stereo, at a bitrate a film can live in ───────────── */

/**
 * Opus with no fmtp of ours is negotiated at its speech default: one channel,
 * around 32 kbps. That is enough to hear THAT a film is playing and not to
 * hear the film. The parameters below are the entire difference, and they
 * belong to the audio m-line alone — the video beside it, and the mic that
 * lives on the person's call mesh in another context entirely, are not this
 * document's to re-negotiate.
 */
const AUDIO_SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'a=fmtp:96 x-google-max-bitrate=2000',
  '',
].join('\r\n');

/** The fmtp line for one payload type, or '' when the SDP has none. */
function fmtpOf(sdp: string, pt: string): string {
  return sdp.split(/\r?\n/).find((line) => line.startsWith(`a=fmtp:${pt} `)) ?? '';
}

describe('preferStereoOpus', () => {
  it('asks Opus for two channels and a film’s bitrate, keeping what was there', () => {
    const fmtp = fmtpOf(preferStereoOpus(AUDIO_SDP), '111');

    expect(fmtp).toBe(
      `a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=${String(SHARE_AUDIO_MAX_BITRATE)}`,
    );
  });

  it('leaves every other m-line byte for byte — including the video beside it', () => {
    const before = AUDIO_SDP.split('m=video')[1] ?? '';
    const after = preferStereoOpus(AUDIO_SDP).split('m=video')[1] ?? '';

    expect(after).toBe(before);
    expect(before.length).toBeGreaterThan(0);
  });

  it('leaves other codecs in the same section alone', () => {
    // red/48000/2 is not Opus, and 111/111 is its redundancy list — writing
    // Opus parameters onto it would be nonsense the far end has to parse.
    expect(fmtpOf(preferStereoOpus(AUDIO_SDP), '63')).toBe('a=fmtp:63 111/111');
  });

  it('writes the line when Opus was offered without one — that IS the mono default', () => {
    const noFmtp = AUDIO_SDP.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '');

    expect(fmtpOf(preferStereoOpus(noFmtp), '111')).toBe(
      `a=fmtp:111 stereo=1;sprop-stereo=1;maxaveragebitrate=${String(SHARE_AUDIO_MAX_BITRATE)}`,
    );
  });

  it('replaces a narrower answer rather than appending a second value', () => {
    const mono = AUDIO_SDP.replace(
      'a=fmtp:111 minptime=10;useinbandfec=1',
      'a=fmtp:111 stereo=0;maxaveragebitrate=24000;useinbandfec=1',
    );

    const fmtp = fmtpOf(preferStereoOpus(mono), '111');
    expect(fmtp).toBe(
      `a=fmtp:111 useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=${String(SHARE_AUDIO_MAX_BITRATE)}`,
    );
    expect(fmtp).not.toContain('stereo=0');
    expect(fmtp).not.toContain('24000');
  });

  it('does not disturb an SDP with no audio in it at all', () => {
    const videoOnly = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000', ''].join(
      '\r\n',
    );

    expect(preferStereoOpus(videoOnly)).toBe(videoOnly);
  });
});

describe('the share’s own negotiation carries those parameters', () => {
  it('tunes the offer it puts on the wire', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    await startShare(request(), h.runtime);

    // Straight through the mesh's own outbound path, which is the only way a
    // description leaves this document.
    h.meshOptions[0]?.send({
      type: 'webrtc.offer',
      roomId: 'room_1' as RoomId,
      seq: 0,
      ts: 1_000,
      payload: {
        targetUserId: 'user_web' as UserId,
        connectionId: 'mesh:room_1:user_9/share~user_web',
        sdp: AUDIO_SDP,
      },
    });

    const [offer] = h.sockets[0]?.sentOf('webrtc.offer') as Array<{ sdp: string }>;
    expect(fmtpOf(offer?.sdp ?? '', '111')).toContain('stereo=1');
    expect(fmtpOf(offer?.sdp ?? '', '111')).toContain(
      `maxaveragebitrate=${String(SHARE_AUDIO_MAX_BITRATE)}`,
    );
  });

  it('tunes the answer it applies — the one that configures the local encoder', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    await startShare(request(), h.runtime);

    // A viewer's answer says what IT will accept, and that is what Chrome
    // reads to configure this document's encoder: an answer that never
    // mentions stereo leaves the share in mono however the offer read.
    h.sockets[0]?.emit('webrtc.answer', {
      fromUserId: 'user_web',
      targetUserId: 'user_9',
      connectionId: 'mesh:room_1:user_9/share~user_web',
      sdp: AUDIO_SDP,
    });

    const applied = h.meshes[0]?.signals[0];
    const sdp = applied?.type === 'webrtc.answer' ? applied.payload.sdp : '';
    expect(fmtpOf(sdp, '111')).toContain('stereo=1');
    expect(fmtpOf(sdp, '111')).toContain(`maxaveragebitrate=${String(SHARE_AUDIO_MAX_BITRATE)}`);
  });

  it('passes an ICE candidate through untouched — there is no description in one', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    await startShare(request(), h.runtime);
    const candidate = {
      candidate: 'candidate:1 1 udp 2 1.2.3.4 5 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };

    h.meshOptions[0]?.send({
      type: 'webrtc.ice',
      roomId: 'room_1' as RoomId,
      seq: 0,
      ts: 1_000,
      payload: {
        targetUserId: 'user_web' as UserId,
        connectionId: 'mesh:room_1:user_9/share~user_web',
        candidate,
      },
    });

    expect(h.sockets[0]?.sentOf('webrtc.ice')).toEqual([
      {
        targetUserId: 'user_web',
        connectionId: 'mesh:room_1:user_9/share~user_web',
        candidate,
      },
    ]);
  });
});

/* ── share quality: capped only where relaying bills us ─────────────────
 * The old 400 kbps free-tier cap went out with billing — a DIRECT link is
 * never capped. What remains is the relayed ceiling: a share that falls back
 * to TURN runs on our bill, so the mesh is built with capRelayedVideoKbps and
 * applies it per-link only after classifying that link relayed (the
 * classification and the cap live in packages/p2p/src/mesh.ts). */

describe('share quality', () => {
  it('builds the share mesh with the relayed-link ceiling', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    await startShare(request(), h.runtime);

    expect(h.meshOptions).toHaveLength(1);
    expect(h.meshOptions[0]?.capRelayedVideoKbps).toBe(SHARE_RELAYED_VIDEO_CAP_KBPS);
  });

  it('passes the ceiling whatever the link — the mesh decides per link', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])], [['viewer_1', 'relayed']]);
    await startShare(request(), h.runtime);

    expect(h.meshOptions).toHaveLength(1);
    expect(h.meshOptions[0]?.capRelayedVideoKbps).toBe(SHARE_RELAYED_VIDEO_CAP_KBPS);
  });

  it('says nothing about quality in its reply, relayed or direct', async () => {
    const relayed = harness([() => fakeStream(['video', 'audio'])], [['viewer_1', 'relayed']]);
    const direct = harness([() => fakeStream(['video', 'audio'])], [['viewer_1', 'direct']]);

    expect((await startShare(request(), relayed.runtime)).note).toBe('');
    await stopShare();
    expect((await startShare(request(), direct.runtime)).note).toBe('');
  });

  it('leaves the silence note alone on a relayed link — it is the only note left', async () => {
    const h = harness([() => fakeStream(['video'])], [['viewer_1', 'relayed']]);
    const started = await startShare(request(), h.runtime);

    expect(started.note).toMatch(/^Sharing video without sound —/);
    expect(started.note).not.toMatch(/quality|Premium/);
  });

  it('keeps polling link stats while the share lives, and stops with it', async () => {
    vi.useFakeTimers();
    try {
      const h = harness([() => fakeStream(['video', 'audio'])]);
      await startShare(request(), h.runtime);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.meshes[0]?.polls).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.meshes[0]?.polls).toBe(2);

      await stopShare();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(h.meshes[0]?.polls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ── the capture ending without us ────────────────────────────────────── */

describe('a capture that ends on its own', () => {
  for (const source of ['tab', 'desktop'] as const) {
    it(`watches the ${source} video track, which is how Chrome reports the end`, async () => {
      const stream = fakeStream(['video']);
      const h = harness([() => stream]);
      await startShare(request({ source }), h.runtime);

      expect(stream.tracks[0]?.endedListeners).toHaveLength(1);
    });
  }

  it('tells the room, stops every track and closes the transports', async () => {
    const stream = fakeStream(['video', 'audio']);
    const h = harness([() => stream]);
    await startShare(request(), h.runtime);

    // Chrome's own "Stop sharing" bar — and a closed shared tab — arrive here.
    stream.tracks[0]?.end();

    expect(h.sockets[0]?.sent.slice(1)).toEqual([
      { type: 'restream.stop', payload: {} },
      { type: 'presence.update', payload: { sharing: false } },
    ]);
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.meshes[0]?.closed).toBe(true);
    expect(h.sockets[0]?.closed).toBe(true);
  });

  it('tells the worker, which is the only way its "sharing" flag can clear', async () => {
    const stream = fakeStream(['video']);
    const h = harness([() => stream]);
    await startShare(request(), h.runtime);

    stream.tracks[0]?.end();

    expect(h.notices.ended).toBe(1);
  });

  it('does not touch the share that replaced it, however late it ends', async () => {
    const old = fakeStream(['video']);
    const first = harness([() => old]);
    await startShare(request(), first.runtime);

    const second = harness([() => fakeStream(['video'])]);
    await startShare(request({ source: 'desktop' }), second.runtime);

    old.tracks[0]?.end();

    expect(second.sockets[0]?.closed).toBe(false);
    expect(second.meshes[0]?.closed).toBe(false);
    expect(first.notices.ended).toBe(0);
  });
});

describe('stopShare', () => {
  it('announces the stop, stops every track and closes the socket and mesh', async () => {
    const stream = fakeStream(['video', 'audio']);
    const h = harness([() => stream]);
    await startShare(request(), h.runtime);

    await stopShare();

    expect(h.sockets[0]?.sent.slice(1)).toEqual([
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

  it('says nothing twice when it is called twice', async () => {
    const h = harness([() => fakeStream(['video'])]);
    await startShare(request(), h.runtime);

    await stopShare();
    await stopShare();

    expect(h.sockets[0]?.sent.filter((m) => m.type === 'restream.stop')).toHaveLength(1);
  });
});

/* ── what the background can ask for ──────────────────────────────────── */

describe('handleShareCommand', () => {
  it('leaves messages that are not its own to the worker', () => {
    expect(handleShareCommand({ kind: 'popup:status' })).toBeNull();
    expect(handleShareCommand({})).toBeNull();
  });

  it('stops a live share on request, and says it stopped', async () => {
    const stream = fakeStream(['video', 'audio']);
    const h = harness([() => stream]);
    await startShare(request(), h.runtime);

    await expect(handleShareCommand({ kind: 'stopShare' })).resolves.toEqual({
      ok: true,
      stopped: true,
    });

    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.sockets[0]?.closed).toBe(true);
    expect(h.meshes[0]?.closed).toBe(true);
    expect(h.sockets[0]?.sent.slice(1)).toEqual([
      { type: 'restream.stop', payload: {} },
      { type: 'presence.update', payload: { sharing: false } },
    ]);
  });

  it('answers a stop with nothing to stop the same way — the caller wants certainty', async () => {
    await expect(handleShareCommand({ kind: 'stopShare' })).resolves.toEqual({
      ok: true,
      stopped: true,
    });
    await expect(handleShareCommand({ kind: 'stopShare' })).resolves.toEqual({
      ok: true,
      stopped: true,
    });
  });

  it('reports a started share with the sound it really got', async () => {
    const h = harness([() => fakeStream(['video', 'audio'])]);
    await expect(handleShareCommand(startMessage(), h.runtime)).resolves.toEqual({
      ok: true,
      audio: true,
      note: '',
    });
  });

  it('reports a refused capture as a failure, never as a share', async () => {
    const h = harness([rejects('NotAllowedError: Permission denied')]);
    const reply = await handleShareCommand(
      startMessage({ source: 'desktop', canRequestAudioTrack: false }),
      h.runtime,
    );

    expect(reply).toEqual({ ok: false, error: 'NotAllowedError: Permission denied' });
  });
});
