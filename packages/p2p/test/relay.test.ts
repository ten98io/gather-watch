import { describe, expect, it } from 'vitest';
import type { UserId } from '@gather/contracts';
import type { MeshManager } from '../src/mesh';
import { CfSfuProvider, LivekitProvider, MeshProvider, RelayError } from '../src/relay';
import type { RelayProvider } from '../src/relay';
import type {
  FetchInitLike,
  FetchLike,
  FetchResponseLike,
  MediaStreamTrackLike,
  TrackRole,
} from '../src/types';
import { MockNetwork, VirtualClock, rid, uid } from './harness';

function track(id: string, kind: 'audio' | 'video'): MediaStreamTrackLike {
  return { id, kind, enabled: true };
}

interface FetchCall {
  url: string;
  init: FetchInitLike | undefined;
}

function jsonResponse(body: unknown): Promise<FetchResponseLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(''),
  });
}

function makeCf(fetchImpl: FetchLike): CfSfuProvider {
  const clock = new VirtualClock();
  const net = new MockNetwork(clock);
  return new CfSfuProvider({
    rtcFactory: net.rtcFactory,
    fetchImpl,
    now: () => clock.now(),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
}

describe('MeshProvider', () => {
  it('maps kinds to roles and adapts the mesh surface', async () => {
    const calls: Array<[TrackRole, MediaStreamTrackLike | null]> = [];
    let closed = false;
    const remoteHandlers: Array<
      (peerId: UserId, track: MediaStreamTrackLike, streams: unknown[]) => void
    > = [];
    const mesh = {
      setLocalTrack: (role: TrackRole, t: MediaStreamTrackLike | null) => {
        calls.push([role, t]);
      },
      onRemoteTrack: (
        fn: (peerId: UserId, track: MediaStreamTrackLike, streams: unknown[]) => void,
      ) => {
        remoteHandlers.push(fn);
        return () => {};
      },
      close: () => {
        closed = true;
      },
    } as unknown as MeshManager;

    const provider: RelayProvider = new MeshProvider(mesh);
    expect(provider.kind).toBe('mesh');

    const audio = track('a1', 'audio');
    const videoA = track('v1', 'video');
    const videoB = track('v2', 'video');
    await provider.publishTracks([audio, videoA, videoB]);
    expect(calls).toEqual([
      ['mic', audio],
      ['cam', videoA],
      ['share', videoB],
    ]);

    const seen: Array<[string, MediaStreamTrackLike]> = [];
    provider.subscribe((source, t) => {
      seen.push([source, t]);
    });
    expect(remoteHandlers).toHaveLength(1);
    remoteHandlers[0]!(uid('peer'), videoA, []);
    expect(seen).toEqual([['peer', videoA]]);

    expect(provider.dataChannel('sync')).toBeNull();

    await provider.close();
    expect(closed).toBe(true);
  });
});

describe('CfSfuProvider', () => {
  it('connect + publish', async () => {
    const calls: FetchCall[] = [];
    const provider = makeCf((url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/sessions/new')) return jsonResponse({ sessionId: 'sess-1' });
      if (url.endsWith('/tracks/new')) {
        return jsonResponse({
          sessionDescription: { type: 'answer', sdp: 'answer:900:1' },
          tracks: [],
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      });
    });

    await provider.connect(rid('r1'), { token: 'tok', appId: 'app1' });
    expect(provider.sessionId()).toBe('sess-1');

    const video = track('vt1', 'video');
    await provider.publishTracks([video]);

    expect(calls).toHaveLength(2);
    const sessionCall = calls[0]!;
    expect(sessionCall.url).toBe('https://rtc.live.cloudflare.com/v1/apps/app1/sessions/new');
    expect(sessionCall.init?.method).toBe('POST');
    expect(sessionCall.init?.headers?.['Authorization']).toBe('Bearer tok');

    const tracksCall = calls[1]!;
    expect(tracksCall.url).toBe(
      'https://rtc.live.cloudflare.com/v1/apps/app1/sessions/sess-1/tracks/new',
    );
    expect(tracksCall.init?.method).toBe('POST');
    expect(tracksCall.init?.headers?.['Authorization']).toBe('Bearer tok');
    const body = JSON.parse(tracksCall.init?.body as string) as {
      sessionDescription?: { type?: string };
      tracks?: unknown;
    };
    expect(body.sessionDescription?.type).toBe('offer');
    expect(body.tracks).toEqual([{ location: 'local', trackName: 'vt1' }]);
  });

  it('renegotiates on remote subscribe', async () => {
    const calls: FetchCall[] = [];
    const provider = makeCf((url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/sessions/new')) return jsonResponse({ sessionId: 'sess-1' });
      if (url.endsWith('/tracks/new')) {
        return jsonResponse({
          requiresImmediateRenegotiation: true,
          sessionDescription: { type: 'offer', sdp: 'offer:901:1' },
        });
      }
      if (url.endsWith('/renegotiate')) return jsonResponse({});
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      });
    });

    await provider.connect(rid('r1'), { token: 'tok', appId: 'app1' });
    await provider.subscribeRemoteTracks('sess-2', ['t1']);

    const post = calls.find((c) => c.url.endsWith('/tracks/new'));
    expect(post).toBeDefined();
    const postBody = JSON.parse(post?.init?.body as string) as { tracks?: unknown };
    expect(postBody.tracks).toEqual([{ location: 'remote', sessionId: 'sess-2', trackName: 't1' }]);

    const put = calls.find((c) => c.init?.method === 'PUT');
    expect(put).toBeDefined();
    expect(put?.url).toBe(
      'https://rtc.live.cloudflare.com/v1/apps/app1/sessions/sess-1/renegotiate',
    );
    const putBody = JSON.parse(put?.init?.body as string) as {
      sessionDescription?: { type?: string };
    };
    expect(putBody.sessionDescription?.type).toBe('answer');
  });

  it('error paths: STATE and HTTP', async () => {
    // connect without appId → STATE
    const noAppId = makeCf(() => jsonResponse({ sessionId: 'sess-1' }));
    let err: unknown = null;
    await noAppId.connect(rid('r1'), { token: 'tok' }).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('STATE');

    // publishTracks before connect → STATE
    err = null;
    await noAppId.publishTracks([track('v1', 'video')]).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('STATE');

    // fetch returning ok:false status 403 → HTTP with status
    const forbidden = makeCf(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      }),
    );
    err = null;
    await forbidden.connect(rid('r1'), { token: 'tok', appId: 'app1' }).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('HTTP');
    expect((err as RelayError).status).toBe(403);
  });
});

describe('LivekitProvider', () => {
  it('disabled: every method reports NOT_ENABLED except close', async () => {
    const provider: RelayProvider = new LivekitProvider();
    expect(provider.kind).toBe('livekit');

    let err: unknown = null;
    await provider.connect(rid('r1'), { token: null }).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('NOT_ENABLED');

    err = null;
    await provider.publishTracks([]).catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('NOT_ENABLED');

    err = null;
    try {
      provider.subscribe(() => {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('NOT_ENABLED');

    err = null;
    try {
      provider.dataChannel('sync');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('NOT_ENABLED');

    await provider.close();
  });
});
