// @vitest-environment jsdom
/**
 * A LOCAL DEVICE THAT VANISHES MID-CALL.
 *
 * Unplug a USB headset, let another app seize the webcam, walk a bluetooth
 * earpiece out of range: the browser fires exactly one 'ended' event on the
 * MediaStreamTrack and does nothing else. There is no error, no permission
 * change, no mesh signal, and — the trap — the track OBJECT survives with
 * `enabled` still true. Every piece of UI keyed on our own `micOn` flag
 * therefore keeps drawing a live microphone while not one sample leaves the
 * machine, and presence keeps telling the room the same thing.
 *
 * That is the swallowed-play() failure again in a different costume: a user
 * who cannot tell that they are broken. So this file pins, for BOTH devices:
 *
 *   1. the session admits the loss,
 *   2. the room is told (presence goes mic-off / cam-off) and the dead track
 *      is pulled off the mesh rather than left published,
 *   3. the surface says so in words and offers the action that fixes it,
 *   4. re-acquiring actually republishes and clears the state — including the
 *      user's own mute latch, which a device swap must not silently flip.
 *
 * The mesh is a module double on purpose: this is a test about what the
 * session does when a track dies, and a real peer connection would only add
 * ways for it to be flaky.
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

/* ── fake tracks: real listener bookkeeping, because 'ended' is the subject ── */

class FakeTrack {
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  stopped = false;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(
    readonly id: string,
    readonly kind: 'audio' | 'video',
  ) {}
  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  stop(): void {
    this.stopped = true;
    this.readyState = 'ended';
  }
  /** What a vanishing device does — and note that `enabled` stays true. */
  end(): void {
    this.readyState = 'ended';
    for (const fn of [...(this.listeners.get('ended') ?? [])]) fn();
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
// jsdom has no MediaStream, and the local camera tile builds one per track.
(globalThis as unknown as { MediaStream: unknown }).MediaStream = FakeStream;
// jsdom's HTMLMediaElement.play() is "not implemented" and returns undefined,
// which the tile's `play().catch(…)` would trip over before any claim is read.
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  value: () => Promise.resolve(),
});

/** Every track handed out by the stubbed getUserMedia, in order. */
const media = vi.hoisted(() => ({
  mics: [] as unknown[],
  cams: [] as unknown[],
  fail: false as boolean,
}));

/* ── module doubles ──────────────────────────────────────────────────────── */

const meshStub = vi.hoisted(() => ({
  local: [] as Array<[string, unknown]>,
  intents: [] as boolean[],
}));
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
    setLocalTrack: (role: string, track: unknown) => {
      meshStub.local.push([role, track]);
    },
    onLocalTrack: () => () => undefined,
    onRemoteTrack: () => () => undefined,
    onRemoteTrackRemoved: () => () => undefined,
    onConnectionState: () => () => undefined,
    onError: () => () => undefined,
  }),
  closeCallMesh: () => undefined,
  isAudioSinkClaimed: () => false,
  onAudioSinkClaims: () => () => undefined,
  setCallIntent: (_c: unknown, on: boolean) => {
    meshStub.intents.push(on);
  },
}));

const { CallDock, CallSessionProvider, deviceLossNote, useCallSession } = await import(
  '@/components/call/CallSurface'
);

/* ── fixtures ────────────────────────────────────────────────────────────── */

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
});

const member = (): Member => ({
  roomId: ROOM_ID,
  userId: ME,
  role: 'host',
  joinedAt: 1_000,
  banned: false,
});

function fakeConnection(): {
  connection: RoomConnection;
  presenceUpdates: Array<Record<string, unknown>>;
} {
  const useRoomState = create<{
    presence: Record<UserId, PresenceEntry>;
    playback: null;
    membersVersion: number;
  }>()(() => ({ presence: {}, playback: null, membersVersion: 0 }));
  const presenceUpdates: Array<Record<string, unknown>> = [];
  const connection = {
    roomId: ROOM_ID,
    useRoomState,
    rawSocket: { send: () => undefined },
    on: () => () => undefined,
    presenceUpdate: (patch: Record<string, unknown>) => presenceUpdates.push(patch),
  } as unknown as RoomConnection;
  return { connection, presenceUpdates };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/* ── harness ─────────────────────────────────────────────────────────────── */

let host: HTMLDivElement;
let root: Root;
let session: ReturnType<typeof useCallSession> | null = null;

function Probe() {
  session = useCallSession();
  return (
    <div data-testid="probe">
      {session.participants.map((p) => `${p.userId}:${p.micOn ? 'mic' : 'muted'}`).join(',')}
    </div>
  );
}

const probe = (): string => host.querySelector('[data-testid="probe"]')?.textContent ?? '';

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent) === label,
  );
}

function alertText(): string {
  return [...host.querySelectorAll('[role="alert"]')].map((el) => el.textContent).join(' ');
}

describe('a local device that ends mid-call', () => {
  let conn: ReturnType<typeof fakeConnection>;

  beforeEach(() => {
    media.mics = [];
    media.cams = [];
    media.fail = false;
    meshStub.local = [];
    meshStub.intents = [];
    session = null;
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getUserMedia: (constraints: { video?: unknown }) => {
        if (media.fail) return Promise.reject(new Error('device busy'));
        if (constraints.video === true) {
          const cam = new FakeTrack(`cam-${String(media.cams.length)}`, 'video');
          media.cams.push(cam);
          return Promise.resolve(new FakeStream([cam]) as unknown as MediaStream);
        }
        const mic = new FakeTrack(`mic-${String(media.mics.length)}`, 'audio');
        media.mics.push(mic);
        return Promise.resolve(new FakeStream([mic]) as unknown as MediaStream);
      },
    };
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
    conn = fakeConnection();
    roomStub.connection = conn.connection;
    roomStub.room = room();
    roomStub.member = member();
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

  const mic = (i: number): FakeTrack => media.mics[i] as FakeTrack;
  const cam = (i: number): FakeTrack => media.cams[i] as FakeTrack;

  it('admits the microphone is gone instead of drawing a live mic forever', async () => {
    await mount();
    await join();
    expect(probe()).toBe(`${ME}:mic`);

    await act(async () => {
      mic(0).end();
      await settle();
    });

    // The track object is still here and still `enabled` — which is exactly
    // why nothing downstream noticed before.
    expect(mic(0).enabled).toBe(true);
    expect(session?.micLost).toBe(true);
    expect(probe()).toBe(`${ME}:muted`);
  });

  it('tells the room, and stops publishing a track that carries nothing', async () => {
    await mount();
    await join();
    conn.presenceUpdates.length = 0;
    meshStub.local.length = 0;

    await act(async () => {
      mic(0).end();
      await settle();
    });

    expect(conn.presenceUpdates).toContainEqual({ micOn: false });
    expect(meshStub.local).toContainEqual(['mic', null]);
  });

  it('says so in words and offers the action that fixes it', async () => {
    await mount();
    await join();

    await act(async () => {
      mic(0).end();
      await settle();
    });

    expect(alertText()).toContain('microphone disconnected');
    expect(button('Reconnect microphone')).toBeDefined();
    // The mute toggle must not still be sitting there claiming to be useful.
    expect(button('Mute microphone')).toBeUndefined();
  });

  it('re-acquires on request, republishes, and keeps my own mute latch', async () => {
    await mount();
    await join();
    // I muted myself BEFORE the headset died: swapping the device is not
    // consent to be heard again.
    await act(async () => {
      session?.toggleMic();
      await settle();
    });
    await act(async () => {
      mic(0).end();
      await settle();
    });

    await act(async () => {
      session?.recoverMic();
      await settle();
    });

    expect(session?.micLost).toBe(false);
    expect(media.mics).toHaveLength(2);
    expect(mic(1).enabled).toBe(false);
    expect(meshStub.local).toContainEqual(['mic', mic(1)]);
    expect(probe()).toBe(`${ME}:muted`);
  });

  it('admits the camera is gone and drops it off the mesh', async () => {
    await mount();
    await join();
    await act(async () => {
      session?.toggleCamera();
      await settle();
    });
    expect(session?.camOn).toBe(true);
    conn.presenceUpdates.length = 0;
    meshStub.local.length = 0;

    await act(async () => {
      cam(0).end();
      await settle();
    });

    expect(session?.camOn).toBe(false);
    expect(session?.camLost).toBe(true);
    expect(conn.presenceUpdates).toContainEqual({ camOn: false });
    expect(meshStub.local).toContainEqual(['cam', null]);
    expect(alertText()).toContain('camera disconnected');
  });

  it('clears the camera loss once the camera comes back', async () => {
    await mount();
    await join();
    await act(async () => {
      session?.toggleCamera();
      await settle();
    });
    await act(async () => {
      cam(0).end();
      await settle();
    });
    expect(session?.camLost).toBe(true);

    await act(async () => {
      session?.toggleCamera();
      await settle();
    });

    expect(session?.camLost).toBe(false);
    expect(session?.camOn).toBe(true);
  });

  it('does not cry device-loss when I stop the track myself', async () => {
    await mount();
    await join();
    await act(async () => {
      session?.toggleCamera();
      await settle();
    });
    const dead = cam(0);

    await act(async () => {
      session?.toggleCamera(); // turning it off calls stop()
      await settle();
    });
    // Some browsers do fire 'ended' on a track the page stopped itself.
    await act(async () => {
      dead.end();
      await settle();
    });

    expect(session?.camLost).toBe(false);
    expect(alertText()).not.toContain('camera disconnected');
  });
});

describe('deviceLossNote', () => {
  it('names exactly what is broken, and stays silent when nothing is', () => {
    expect(deviceLossNote({ micLost: false, camLost: false })).toBeNull();
    expect(deviceLossNote({ micLost: true, camLost: false })).toContain('microphone disconnected');
    expect(deviceLossNote({ micLost: false, camLost: true })).toContain('camera disconnected');
    const both = deviceLossNote({ micLost: true, camLost: true }) ?? '';
    expect(both).toContain('microphone');
    expect(both).toContain('camera');
  });
});
