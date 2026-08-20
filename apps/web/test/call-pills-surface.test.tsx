// @vitest-environment jsdom
/**
 * CallPills — the immersive layout's call surface (DESIGN.md D1.1).
 *
 * The contract with the layout, pinned here because two agents built the two
 * halves against it: CallPills renders CONTENT only — one Meet-style pill per
 * in-call participant, a slim edge stack when collapsed — and the PARENT owns
 * where it sits. So the root must never position itself (no fixed/absolute),
 * and the only thing `edge` may change is which side the stack hugs.
 *
 * The regression this file exists to keep out: DOUBLED AUDIO. The pills reuse
 * the tile plumbing (tracks, speaking rings), and the rail dock and the pills
 * can genuinely mount at the same time — the dock in a floating rail, the
 * pills over the stage. Audio stays single because every call audio sink is
 * owned by <CallSessionProvider>, mounted once; the pills render pictures
 * only. Both halves of that are asserted below against the real provider.
 *
 * The speaking ring is measured, never simulated (file-level honesty rule), so
 * the ring test drives the REAL analyser path with a fake AudioContext that
 * reports a loud signal — the same plumbing the orbs use.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member, PresenceEntry, Room, RoomId, UserId } from '@gather/contracts';
import type { RoomConnection } from '@/lib/room-connection';

// `jsx: "preserve"` in tsconfig means vitest's esbuild emits classic
// React.createElement calls — publish React before the components load.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = 'room_test' as RoomId;
const ME = 'user_me' as UserId;
const PEER = 'user_peer' as UserId;
const PEER2 = 'user_peer2' as UserId;

class FakeTrack {
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  constructor(
    readonly id: string,
    readonly kind: 'audio' | 'video',
  ) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  stop(): void {
    this.readyState = 'ended';
  }
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}
(globalThis as unknown as { MediaStream: unknown }).MediaStream = FakeStream;
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  value: () => Promise.resolve(),
});

/**
 * WebAudio that always hears speech. getByteTimeDomainData fills the buffer
 * with 255 — a peak of 127 against the 128 midline, far over SPEAKING_PEAK —
 * so once the provider's poll fires, everyone with a measured track "speaks".
 * The ring itself stays driven by the production analyser wiring.
 */
class FakeAnalyser {
  fftSize = 512;
  smoothingTimeConstant = 0;
  connect(): void {}
  disconnect(): void {}
  getByteTimeDomainData(data: Uint8Array): void {
    data.fill(255);
  }
}
class FakeAudioContext {
  destination = {};
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  createGain(): { gain: { value: number }; connect(): void; disconnect(): void } {
    return { gain: { value: 0 }, connect: () => undefined, disconnect: () => undefined };
  }
  createMediaStreamSource(): { connect(): void; disconnect(): void } {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser();
  }
}

const roomStub = vi.hoisted(() => ({
  connection: null as unknown,
  room: null as unknown,
  member: null as unknown,
}));

/** Captures the mesh's remote-track subscriber so tests can deliver tracks.
 *  The third argument is the announced role — omitted by older callers, which
 *  is exactly the interop case the provider must read as null. */
const meshStub = vi.hoisted(() => ({
  remoteTrack: null as
    | ((userId: string, track: unknown, role?: string | null) => void)
    | null,
}));

const MEMBERS = [
  { user: { id: ME, displayName: 'Me Myself', avatarUrl: null, accentColor: '#7c5cff' } },
  { user: { id: PEER, displayName: 'Robin Vasquez', avatarUrl: null, accentColor: '#2dd4bf' } },
  { user: { id: PEER2, displayName: 'Ada Okafor', avatarUrl: null, accentColor: '#f97316' } },
];

vi.mock('@/lib/api', () => ({
  api: {
    rtc: { turnCredentials: () => Promise.resolve(undefined) },
    rooms: { listMembers: () => Promise.resolve({ members: MEMBERS }) },
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { members: MEMBERS }, refetch: () => Promise.resolve(undefined) }),
}));
vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => roomStub.connection,
  useRoom: () => ({ room: roomStub.room, member: roomStub.member }),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));
vi.mock('@/lib/call-mesh', () => ({
  getCallMesh: () => ({
    start: () => undefined,
    setLocalTrack: () => undefined,
    onLocalTrack: () => () => undefined,
    onRemoteTrack: (fn: (userId: string, track: unknown, role?: string | null) => void) => {
      meshStub.remoteTrack = fn;
      return () => undefined;
    },
    onRemoteTrackRemoved: () => () => undefined,
    onConnectionState: () => () => undefined,
    onLinkState: () => () => undefined,
    onUnreachablePeer: () => () => undefined,
    onRelayAvailability: (fn: (state: string) => void) => {
      fn('unknown');
      return () => undefined;
    },
    onError: () => () => undefined,
  }),
  closeCallMesh: () => undefined,
  isAudioSinkClaimed: () => false,
  onAudioSinkClaims: () => () => undefined,
  setCallIntent: () => undefined,
}));

const { CallDock, CallPills, CallSessionProvider, useCallSession } = await import(
  '@/components/call/CallSurface'
);

const room = (): Room => ({
  id: ROOM_ID,
  kind: 'watch',
  name: 'Test room',
  inviteCode: 'ABCD2345' as Room['inviteCode'],
  ownerId: ME,
  policies: {
    playbackControl: 'everyone',
    queueControl: 'everyone',
    chat: 'everyone',
    maxPublishers: 8,
    waitForAll: true,
    skipVoteThreshold: 0.5,
  },
  relayMode: 'mesh',
  theater: false,
  createdAt: 1_000,
  expiresAt: null,
  hasPassword: false,
});

const member = (): Member => ({
  roomId: ROOM_ID,
  userId: ME,
  role: 'host',
  joinedAt: 1_000,
  banned: false,
});

function fakeConnection(): RoomConnection {
  const useRoomState = create<{
    presence: Record<UserId, PresenceEntry>;
    playback: null;
    membersVersion: number;
  }>()(() => ({ presence: {}, playback: null, membersVersion: 0 }));
  return {
    roomId: ROOM_ID,
    useRoomState,
    rawSocket: { send: () => undefined },
    on: () => () => undefined,
    presenceUpdate: () => undefined,
  } as unknown as RoomConnection;
}

const conn = (): RoomConnection => roomStub.connection as RoomConnection;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

let host: HTMLDivElement;
let root: Root;
let session: ReturnType<typeof useCallSession> | null = null;

function Probe() {
  session = useCallSession();
  return null;
}

const presenceEntry = (userId: UserId, patch?: Partial<PresenceEntry>): PresenceEntry =>
  ({
    userId,
    state: 'in-call',
    micOn: true,
    camOn: false,
    sharing: false,
    lastSeenTs: 1_000,
    ...patch,
  }) as PresenceEntry;

describe('CallPills', () => {
  beforeEach(() => {
    session = null;
    meshStub.remoteTrack = null;
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getUserMedia: (constraints: { video?: unknown }) =>
        Promise.resolve(
          new FakeStream([
            new FakeTrack(
              constraints.video === true ? `v-${String(Math.random())}` : 'mic',
              constraints.video === true ? 'video' : 'audio',
            ),
          ]) as unknown as MediaStream,
        ),
    };
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    roomStub.connection = fakeConnection();
    roomStub.room = room();
    roomStub.member = member();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  const mount = async (ui: React.ReactNode): Promise<void> => {
    await act(async () => {
      root.render(
        <CallSessionProvider>
          <Probe />
          {ui}
        </CallSessionProvider>,
      );
      await settle();
    });
  };

  const join = async (): Promise<void> => {
    await act(async () => {
      session?.join();
      await settle();
    });
  };

  const addPeers = async (
    entries: PresenceEntry[],
    tracks: Array<{ userId: UserId; track: FakeTrack; role?: string | null }> = [],
  ): Promise<void> => {
    await act(async () => {
      conn().useRoomState.setState({
        presence: Object.fromEntries(entries.map((e) => [e.userId, e])) as Record<
          UserId,
          PresenceEntry
        >,
      });
      for (const { userId, track, role } of tracks) meshStub.remoteTrack?.(userId, track, role);
      await settle();
    });
  };

  const pills = (): HTMLElement => {
    const el = host.querySelector<HTMLElement>('aside[aria-label="Call"]');
    if (el === null) throw new Error('CallPills did not render');
    return el;
  };

  const noop = (): void => undefined;

  it('renders nothing while nobody is in the call', async () => {
    await mount(<CallPills edge="right" collapsed={false} onToggleCollapsed={noop} />);
    expect(host.querySelector('aside[aria-label="Call"]')).toBeNull();
  });

  it('draws one named pill per person, mic state included, local controls on mine', async () => {
    await mount(<CallPills edge="right" collapsed={false} onToggleCollapsed={noop} />);
    await join();
    await addPeers([
      presenceEntry(PEER, { micOn: false }),
      presenceEntry(PEER2),
    ]);

    const figures = [...pills().querySelectorAll('figure')];
    const labels = figures.map((f) => f.getAttribute('aria-label') ?? '');
    // Named per person, state in the same breath — the pill IS the roster row.
    expect(labels.some((l) => l.startsWith('You —'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Robin Vasquez —') && l.includes('muted'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Ada Okafor —'))).toBe(true);
    expect(figures).toHaveLength(3);

    // §12: mic/camera/leave are ONE step, on my own pill, never hover-gated.
    const mine = figures.find((f) => (f.getAttribute('aria-label') ?? '').startsWith('You'));
    const controlLabels = [...(mine?.querySelectorAll('button') ?? [])].map(
      (b) => b.getAttribute('aria-label') ?? '',
    );
    expect(controlLabels).toContain('Mute microphone');
    expect(controlLabels).toContain('Turn camera on');
    expect(controlLabels).toContain('Leave the call');
  });

  it('positions nothing itself — the parent owns WHERE, edge only picks the hug side', async () => {
    await mount(<CallPills edge="right" collapsed={false} onToggleCollapsed={noop} />);
    await join();
    // The contract with the immersive layout: content only. A root that set
    // `fixed`/`absolute` would fight the parent's placement — jsdom cannot
    // measure that, but the class check pins the mechanism: block-flow content
    // aligned by flex, positioned by whoever mounted it.
    expect(pills().className).not.toMatch(/\b(fixed|absolute)\b/);
    expect(pills().className).toContain('items-end');
    expect(pills().className).not.toContain('items-start');

    await mount(<CallPills edge="left" collapsed={false} onToggleCollapsed={noop} />);
    expect(pills().className).toContain('items-start');
    expect(pills().className).not.toContain('items-end');
  });

  it('collapses to the slim stack: faces, count, one keyboard-reachable button', async () => {
    const onToggle = vi.fn();
    await mount(<CallPills edge="right" collapsed={true} onToggleCollapsed={onToggle} />);
    await join();
    await addPeers([presenceEntry(PEER), presenceEntry(PEER2)]);

    // No pills while collapsed — the stack is the whole surface…
    expect(pills().querySelectorAll('figure')).toHaveLength(0);
    expect(pills().className).not.toMatch(/\b(fixed|absolute)\b/);

    // …and it still answers "who": count on the face, names on the label.
    const button = pills().querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(button).not.toBeNull();
    expect(button?.tagName).toBe('BUTTON'); // native focus = keyboard reachable
    expect(button?.getAttribute('aria-label')).toBe(
      'Show call pills — 3 in call: You and 2 others',
    );
    expect(button?.textContent).toContain('3');

    await act(async () => {
      button?.click();
      await settle();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('offers hiding from the expanded stack, and joining when others talk without me', async () => {
    const onToggle = vi.fn();
    await mount(<CallPills edge="right" collapsed={false} onToggleCollapsed={onToggle} />);
    // Others in the call, me idle: the immersive layout shows this surface and
    // no other, so the join affordance has to be here (§12, join budget 1).
    await addPeers([presenceEntry(PEER)], [{ userId: PEER, track: new FakeTrack('a1', 'audio') }]);

    const hide = pills().querySelector<HTMLButtonElement>('button[aria-label="Hide call pills"]');
    expect(hide?.getAttribute('aria-expanded')).toBe('true');
    const join_ = [...pills().querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent) === 'Join call',
    );
    expect(join_).toBeDefined();

    await act(async () => {
      hide?.click();
      await settle();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('keeps exactly ONE audio sink per remote track with dock AND pills mounted', async () => {
    // The doubled-audio regression, held shut: both surfaces at once, one
    // remote voice. The <audio> sink belongs to the provider — neither surface
    // brings its own — so the count is 1 no matter what combination renders.
    await mount(
      <>
        <CallDock roomId={ROOM_ID} />
        <CallPills edge="right" collapsed={false} onToggleCollapsed={noop} />
      </>,
    );
    await join();
    await addPeers(
      [presenceEntry(PEER, { camOn: true })],
      [
        { userId: PEER, track: new FakeTrack('peer-audio', 'audio') },
        { userId: PEER, track: new FakeTrack('peer-video', 'video') },
      ],
    );

    expect(document.querySelectorAll('audio')).toHaveLength(1);

    // And the pictures really are silent: every mounted <video> was given a
    // single-track video-only stream, so it cannot double the voice either.
    const videos = [...document.querySelectorAll('video')];
    expect(videos.length).toBeGreaterThan(0);
    for (const el of videos) {
      const stream = el.srcObject as unknown as FakeStream;
      expect(stream.getAudioTracks()).toHaveLength(0);
    }
  });

  it('rides the camera feed in the 64px circle and rings it from measured audio', async () => {
    await mount(<CallPills edge="right" collapsed={false} onToggleCollapsed={noop} />);
    await join();
    await act(async () => {
      session?.toggleCamera();
      await settle();
    });

    const mine = [...pills().querySelectorAll('figure')].find((f) =>
      (f.getAttribute('aria-label') ?? '').startsWith('You'),
    );
    const video = mine?.querySelector('video');
    expect(video).toBeTruthy();
    const circle = video?.parentElement;
    // D1.1: the feed sits in a 64px circle…
    expect(circle?.className).toContain('rounded-full');
    expect(circle?.getAttribute('style')).toContain('64px');
    // …whose speaking ring has not fired yet: the analyser poll (150ms) has
    // not run, and the ring must be measurement-driven, never decorative.
    expect(circle?.className).not.toContain('ring-2');

    // Let the provider's real poll read the (loud) fake analyser once.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    const ringed = mine?.querySelector('video')?.parentElement;
    expect(ringed?.className).toContain('ring-2');
    expect(ringed?.className).toContain('ring-accent');
  });

  /** Every figure for one participant, across dock tiles AND pills. */
  const figuresFor = (name: string): HTMLElement[] =>
    [...host.querySelectorAll<HTMLElement>('figure')].filter((f) =>
      (f.getAttribute('aria-label') ?? '').startsWith(name),
    );

  const videoTrackIdOf = (figure: HTMLElement): string | undefined => {
    const el = figure.querySelector('video');
    const stream = (el as unknown as { srcObject?: FakeStream } | null)?.srcObject;
    return stream?.getVideoTracks()[0]?.id;
  };

  it('shows a sharing peer’s named camera in the tile AND the pill — never their screen', async () => {
    // Both surfaces at once, like the doubled-audio pin above: the pills reuse
    // the tile plumbing, so the cam-while-sharing rule must reach both.
    await mount(
      <>
        <CallDock roomId={ROOM_ID} />
        <CallPills edge="right" collapsed={false} onToggleCollapsed={noop} />
      </>,
    );
    await join();
    await addPeers(
      [presenceEntry(PEER, { camOn: true, sharing: true })],
      [
        { userId: PEER, track: new FakeTrack('peer-cam', 'video'), role: 'cam' },
        // The screen arrives newer; only the role keeps it off the circles.
        { userId: PEER, track: new FakeTrack('peer-screen', 'video'), role: 'share' },
      ],
    );

    const robins = figuresFor('Robin Vasquez');
    expect(robins.length).toBeGreaterThanOrEqual(2); // dock tile + pill
    for (const figure of robins) {
      expect(videoTrackIdOf(figure)).toBe('peer-cam');
    }
    // The stage's track gains no element on any call surface.
    for (const el of document.querySelectorAll('video')) {
      const stream = (el as unknown as { srcObject?: FakeStream }).srcObject;
      expect(stream?.getVideoTracks()[0]?.id).not.toBe('peer-screen');
    }
  });

  it('keeps the avatar while sharing when the track’s role is unknown (older client)', async () => {
    await mount(
      <>
        <CallDock roomId={ROOM_ID} />
        <CallPills edge="right" collapsed={false} onToggleCollapsed={noop} />
      </>,
    );
    await join();
    // No role at all — the pre-role client. Their unnamed video may BE the
    // screen, so the avatar stands, exactly as before roles existed.
    await addPeers(
      [presenceEntry(PEER, { camOn: true, sharing: true })],
      [{ userId: PEER, track: new FakeTrack('peer-video', 'video') }],
    );

    const robins = figuresFor('Robin Vasquez');
    expect(robins.length).toBeGreaterThanOrEqual(2);
    for (const figure of robins) {
      expect(figure.querySelector('video')).toBeNull();
    }
  });
});
