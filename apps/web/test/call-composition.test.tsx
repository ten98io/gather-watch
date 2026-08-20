// @vitest-environment jsdom
/**
 * The call surface as a COMPOSITION — the three rules D1/D2 and §2 make about
 * what the rail's call region may look like, none of which the behavioural
 * suites can see.
 *
 *   • Starting a call is the primary social act of the product, and it shipped
 *     as a 13px text button in a rail header ranked under an invite-code chip.
 *     The idle dock is an invitation now, and the invitation's action is the
 *     region's one aurora gradient.
 *   • D2: mic on, camera off, with a prominent "Turn on camera" affordance on
 *     your OWN tile — and never a silent empty call region. A call of one is
 *     the quietest this surface ever gets, so that is the case pinned here.
 *   • §2 budgets the gradient at one per screen region. Two primaries beside
 *     each other make both mean "a button", which is how it read before.
 *
 * The mesh is a module double for the same reason call-device-loss.test.tsx
 * doubles it: this is a test about what the surface draws, and a real peer
 * connection would only add ways for it to be flaky.
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

const roomStub = vi.hoisted(() => ({
  connection: null as unknown,
  room: null as unknown,
  member: null as unknown,
}));

vi.mock('@/lib/api', () => ({
  api: {
    rtc: { turnCredentials: () => Promise.resolve(undefined) },
    rooms: { listMembers: () => Promise.resolve({ members: [] }) },
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { members: [] }, refetch: () => Promise.resolve(undefined) }),
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
    onRemoteTrack: () => () => undefined,
    onRemoteTrackRemoved: () => () => undefined,
    onConnectionState: () => () => undefined,
    onLinkState: () => () => undefined,
    onUnreachablePeer: () => () => undefined,
    // Nothing has answered a credential fetch in this harness, and 'unknown'
    // is what the mesh reports until one does.
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

const { CallDock, CallSessionProvider, useCallSession } = await import(
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

/** The dock only — the probe is a sibling and must not count as the region. */
const dock = (): HTMLElement => {
  const el = host.querySelector<HTMLElement>('[aria-label="Call"]');
  if (el === null) throw new Error('the call dock did not render');
  return el;
};

const labelled = (label: string): HTMLElement | undefined =>
  [...dock().querySelectorAll<HTMLElement>('button, [aria-label]')].find(
    (el) => (el.getAttribute('aria-label') ?? el.textContent) === label,
  );

describe('the call region', () => {
  beforeEach(() => {
    session = null;
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getUserMedia: (constraints: { video?: unknown }) =>
        Promise.resolve(
          new FakeStream([
            new FakeTrack('t', constraints.video === true ? 'video' : 'audio'),
          ]) as unknown as MediaStream,
        ),
    };
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
  });

  const mount = async (): Promise<void> => {
    await act(async () => {
      root.render(
        <CallSessionProvider>
          <Probe />
          <CallDock roomId={ROOM_ID} />
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

  it('offers starting a call as an invitation, not as a rail setting', async () => {
    await mount();

    // The words, at the step that makes them the subject of the region.
    const heading = [...dock().querySelectorAll('p')].find(
      (p) => p.textContent === 'Start a call',
    );
    expect(heading?.className).toContain('text-title');
    expect(labelled('Start a call')).toBeDefined();
  });

  it('spends the one aurora this region has on that action and nothing else', async () => {
    await mount();

    expect(dock().querySelectorAll('.aurora-gradient')).toHaveLength(1);
  });

  it('draws a tile for the only person in the call and says nobody else came', async () => {
    await mount();
    await join();

    // D2: everyone in the call gets a tile, mine included, camera off.
    expect(session?.participants).toHaveLength(1);
    expect(dock().querySelector('figure[aria-label^="You"]')).not.toBeNull();
    // …and the region is never silent about being a call of one.
    expect(dock().textContent).toContain('Nobody else has joined yet');
  });

  it('puts the camera invitation on my own tile, and keeps it the one aurora', async () => {
    await mount();
    await join();

    expect(labelled('Turn on camera')).toBeDefined();
    expect(dock().querySelectorAll('.aurora-gradient')).toHaveLength(1);
  });

  it('announces a person once — the figure names them, the orb does not', async () => {
    await mount();
    await join();

    const named = [...dock().querySelectorAll('[aria-label]')].filter((el) =>
      (el.getAttribute('aria-label') ?? '').startsWith('You'),
    );
    expect(named).toHaveLength(1);
    expect(named[0]?.tagName.toLowerCase()).toBe('figure');
  });
});
