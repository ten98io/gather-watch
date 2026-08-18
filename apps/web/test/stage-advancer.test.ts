// @vitest-environment jsdom
/**
 * THE STAGE'S HALF of "who advances the queue".
 *
 * `nextTrackOnEnd` has always taken an `isAdvancer` flag and StagePane has
 * always hung it on a static `member.role === 'host'`. That leaves two rooms
 * permanently stuck on a finished item — the host watching on their phone
 * (mobile mounts no advancer), and the host who closed their tab — and no
 * amount of correctness in the pure function reaches either of them.
 *
 * These cases drive the real component, because the defect is entirely in what
 * the component reads: the room's master seat instead of a role, plus the claim
 * that fills the seat in the first place (nothing anywhere sent
 * sync.claimMaster, so the server's whole election was dead code).
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef, Member, PresenceEntry, UserId } from '@gather/contracts';

const DURATION_MS = 60_000;

/** One recording stand-in for every adapter kind the stage can build. */
class FakeAdapter {
  static live: FakeAdapter | null = null;
  readonly kind = 'youtube';
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeAdapter.live = this;
  }
  on(evt: string, cb: () => void): () => void {
    const set = this.listeners.get(evt) ?? new Set<() => void>();
    set.add(cb);
    this.listeners.set(evt, set);
    return () => set.delete(cb);
  }
  emit(evt: string): void {
    for (const cb of [...(this.listeners.get(evt) ?? [])]) cb();
  }
  load(): void {}
  play(): void {}
  pause(): void {}
  seekTo(): void {}
  setRate(): void {}
  positionMs(): number {
    return DURATION_MS;
  }
  durationMs(): number {
    return DURATION_MS;
  }
  setMuted(): void {}
  isMuted(): boolean {
    return false;
  }
  setVolume(): void {}
  setDuck(): void {}
  destroy(): void {}
}

vi.mock('@/lib/player/native', () => ({ NativeAdapter: FakeAdapter }));
vi.mock('@/lib/player/youtube', () => ({ YouTubeAdapter: FakeAdapter }));
vi.mock('@/lib/player/soundcloud', () => ({ SoundCloudAdapter: FakeAdapter }));
vi.mock('@/lib/player/vimeo', () => ({ VimeoAdapter: FakeAdapter }));
vi.mock('@/lib/player/embed', () => ({ EmbedAdapter: FakeAdapter }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { StagePane } = await import('@/components/stage/StagePane');
const { MASTER_CLAIM_STAGGER_MS } = await import('@/lib/player/advance');
const { ROOM_ID, ME, makeMember, makeRoom, queueItem } = await import('./helpers/room-render');
type RoomConnection = ReturnType<typeof useRoomConnection>;

const ENDING: MediaRef = { kind: 'youtube', videoId: 'ending' };
const NEXT: MediaRef = { kind: 'youtube', videoId: 'next' };

/** Sorts BEFORE `user-me`, so it takes rank 0 in the claim stagger. */
const EARLY = 'user-early' as UserId;
/** Sorts after `user-me`. */
const LATE = 'user-zeta' as UserId;

const h = React.createElement;
let captured: RoomConnection | null = null;

function present(...userIds: UserId[]): Record<UserId, PresenceEntry> {
  const out: Record<UserId, PresenceEntry> = {};
  for (const userId of userIds) {
    out[userId] = {
      userId,
      state: 'watching',
      micOn: false,
      camOn: false,
      sharing: false,
      lastSeenTs: 1_000,
    };
  }
  return out;
}

function Seeded({ patch, children }: { patch: Record<string, unknown>; children?: React.ReactNode }) {
  const connection = useRoomConnection();
  captured = connection;
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

describe('the stage picks the room’s one advancer', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    FakeAdapter.live = null;
    captured = null;
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.useRealTimers();
  });

  interface Mounted {
    player: FakeAdapter;
    setTrack: ReturnType<typeof vi.fn>;
    claims: Array<[string, unknown]>;
    connection: RoomConnection;
  }

  async function mount(over: {
    role: Member['role'];
    master?: { userId: UserId; epoch: number } | null;
    presence?: Record<UserId, PresenceEntry>;
  }): Promise<Mounted> {
    const items = [queueItem(ENDING, 'the one ending'), queueItem(NEXT, 'the one after')];
    const patch = {
      playback: {
        mediaRef: ENDING,
        positionMs: 58_000,
        rate: 1,
        playing: true,
        serverTs: Date.now(),
        seq: 1,
        queueIndex: 0,
      },
      queue: { items, version: 1 },
      master: over.master ?? null,
      presence: over.presence ?? present(ME),
    };

    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room: makeRoom('watch'), member: makeMember(over.role), roomId: ROOM_ID } as never,
          h(Seeded, { patch }, h(StagePane, { roomId: ROOM_ID })),
        ),
      );
    });

    const player = FakeAdapter.live;
    if (player === null) throw new Error('the stage never built a player');
    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');

    const setTrack = vi.fn();
    connection.syncSetTrackByQueue = setTrack as unknown as typeof connection.syncSetTrackByQueue;
    const claims: Array<[string, unknown]> = [];
    vi.spyOn(connection.rawSocket, 'send').mockImplementation(((type: string, payload: unknown) => {
      claims.push([type, payload]);
    }) as unknown as typeof connection.rawSocket.send);

    await act(async () => {
      player.emit('ready');
      player.emit('playing');
    });
    return { player, setTrack, claims, connection };
  }

  async function endIt(player: FakeAdapter): Promise<void> {
    await act(async () => {
      player.emit('ended');
      await vi.advanceTimersByTimeAsync(2_000);
    });
  }

  it('advances when this client holds the seat, even though it is not the host', async () => {
    // The host-on-a-phone room: the host is present and cannot advance, so the
    // seat is held by a web tab that can. Under the old rule this tab waited
    // for the host forever.
    const { player, setTrack } = await mount({
      role: 'member',
      master: { userId: ME, epoch: 1 },
      presence: present(ME, LATE),
    });
    await endIt(player);
    expect(setTrack.mock.calls).toEqual([[1]]);
  });

  it('does not advance when someone else holds the seat, even as host', async () => {
    const { player, setTrack } = await mount({
      role: 'host',
      master: { userId: LATE, epoch: 1 },
      presence: present(ME, LATE),
    });
    await endIt(player);
    expect(setTrack.mock.calls).toEqual([]);
  });

  it('takes the decision back when the seat’s holder leaves the room', async () => {
    const { player, setTrack } = await mount({
      role: 'host',
      master: { userId: LATE, epoch: 1 },
      presence: present(ME), // LATE closed their tab
    });
    await endIt(player);
    expect(setTrack.mock.calls).toEqual([[1]]);
  });

  it('claims the empty seat on mount, one epoch above the stored one', async () => {
    const { claims } = await mount({ role: 'member', master: null, presence: present(ME) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MASTER_CLAIM_STAGGER_MS * 4);
    });
    expect(claims).toEqual([['sync.claimMaster', { epoch: 1 }]]);
  });

  it('claims a seat whose holder has gone, at the next epoch', async () => {
    const { claims } = await mount({
      role: 'member',
      master: { userId: LATE, epoch: 4 },
      presence: present(ME),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MASTER_CLAIM_STAGGER_MS * 4);
    });
    expect(claims).toEqual([['sync.claimMaster', { epoch: 5 }]]);
  });

  it('waits its turn behind a lower-ranked candidate', async () => {
    const { claims } = await mount({
      role: 'member',
      master: null,
      presence: present(EARLY, ME),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MASTER_CLAIM_STAGGER_MS - 1);
    });
    expect(claims).toEqual([]);

    // …and only claims because the candidate ahead of it never did. This is the
    // whole reason the queue exists: the first candidate may be a phone.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(claims).toEqual([['sync.claimMaster', { epoch: 1 }]]);
  });

  it('stands down when the seat fills while it is waiting its turn', async () => {
    const { claims, connection } = await mount({
      role: 'member',
      master: null,
      presence: present(EARLY, ME),
    });
    await act(async () => {
      connection.useRoomState.setState({ master: { userId: EARLY, epoch: 1 } });
      await vi.advanceTimersByTimeAsync(MASTER_CLAIM_STAGGER_MS * 4);
    });
    expect(claims).toEqual([]);
  });

  it('does not re-claim a seat it already holds', async () => {
    const { claims } = await mount({
      role: 'member',
      master: { userId: ME, epoch: 1 },
      presence: present(ME, LATE),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MASTER_CLAIM_STAGGER_MS * 4);
    });
    expect(claims).toEqual([]);
  });
});
