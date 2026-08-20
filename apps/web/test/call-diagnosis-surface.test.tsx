// @vitest-environment jsdom
/**
 * WHY A CALL DID NOT CONNECT — the half of it a person can read.
 *
 * From the owner's own production test, two people on different networks:
 * both joined, both tiles rendered, the room said "2 IN CALL", and the chat
 * said "I cant see or hear u" / "me either". One tile sat on "RECONNECTING…"
 * indefinitely, which is indistinguishable from a slow network and gives
 * nobody a next step — least of all the owner, who spent an hour on a fact the
 * client had held since its first credential fetch.
 *
 * So, in order:
 *
 *   1. a link that never comes up stops claiming it is coming back, once the
 *      mesh's OWN recovery budget has run out (never a second timer racing it);
 *   2. the connectivity case is named — networks that cannot reach each other
 *      and a room with no relay — in words with no ICE, no NAT and no TURN in
 *      them, and with the one move that actually works;
 *   3. the badge names the route the media is TAKING, and refuses to guess
 *      when the stats refuse to say;
 *   4. one unreachable person does not make the rest of the call look broken.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Member,
  PresenceEntry,
  Room,
  RoomId,
  TurnCredentialsResponse,
  UserId,
} from '@gather/contracts';
import type { MeshConnectionState } from '@gather/p2p';
import type { RoomConnection } from '@/lib/room-connection';

// `jsx: "preserve"` in tsconfig means vitest's esbuild emits classic
// React.createElement calls — publish React before the components load.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = 'room_test' as RoomId;
const ME = 'user_me' as UserId;
const ALEX = 'user_alex' as UserId;
const SAM = 'user_sam' as UserId;

/** What the deployment serves with no Cloudflare TURN keys set: STUN, no relay. */
const STUN_ONLY: TurnCredentialsResponse = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  ttlSeconds: 0,
  fairUseRemainingGb: null,
};

const WITH_RELAY: TurnCredentialsResponse = {
  iceServers: [{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }],
  ttlSeconds: 0,
  fairUseRemainingGb: null,
};

/* ── module doubles ──────────────────────────────────────────────────────── */

const turnStub = vi.hoisted(() => ({
  fetch: (): Promise<TurnCredentialsResponse> => Promise.resolve(undefined as never),
}));
const roomStub = vi.hoisted(() => ({
  connection: null as unknown,
  room: null as unknown,
  member: null as unknown,
  members: [] as unknown[],
}));

vi.mock('@/lib/api', () => ({
  api: {
    rtc: { turnCredentials: () => turnStub.fetch() },
    rooms: { listMembers: () => Promise.resolve({ members: roomStub.members }) },
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { members: roomStub.members },
    refetch: () => Promise.resolve(undefined),
  }),
}));
vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => roomStub.connection,
  useRoom: () => ({ room: roomStub.room, member: roomStub.member }),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

const { closeCallMesh, getCallMesh } = await import('@/lib/call-mesh');
const {
  CALL_PATH_LABEL,
  CallDock,
  CallSessionProvider,
  LINK_STATUS_LABEL,
  callPathFrom,
  connectivityNote,
  linkStatusFor,
  useCallSession,
} = await import('@/components/call/CallSurface');

/* ── fakes ───────────────────────────────────────────────────────────────── */

class FakeDataChannel {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  constructor(readonly label: string) {}
  send(): void {}
  close(): void {}
}

class FakePc {
  static instances: FakePc[] = [];
  localDescription: { type: string; sdp: string } | null = { type: 'offer', sdp: 'sdp' };
  remoteDescription: unknown = null;
  signalingState = 'stable';
  connectionState = 'new';
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((ev: { track: unknown; streams: unknown[] }) => void) | null = null;
  ondatachannel: ((ev: { channel: unknown }) => void) | null = null;
  /** What getStats() answers; link classification reads exactly this. */
  statsResult: unknown = undefined;
  constructor(readonly config?: { iceServers?: unknown[] }) {
    FakePc.instances.push(this);
  }
  static reset(): void {
    FakePc.instances = [];
  }
  setConfiguration(): void {}
  restartIce(): void {}
  createOffer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: 'offer', sdp: 'sdp' });
  }
  createAnswer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: 'answer', sdp: 'sdp' });
  }
  setLocalDescription(): Promise<void> {
    return Promise.resolve();
  }
  setRemoteDescription(): Promise<void> {
    return Promise.resolve();
  }
  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }
  addTrack(t: unknown): { track: unknown; getParameters(): { encodings: [] } } {
    return { track: t, getParameters: () => ({ encodings: [] }) };
  }
  removeTrack(): void {}
  getSenders(): unknown[] {
    return [];
  }
  createDataChannel(label: string): FakeDataChannel {
    return new FakeDataChannel(label);
  }
  getStats(): Promise<unknown> {
    return Promise.resolve(this.statsResult);
  }
  close(): void {}
  setConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

/** Stats whose selected pair crosses a TURN relay on the local side. */
const RELAYED_STATS = [
  { id: 'transport_1', type: 'transport', selectedCandidatePairId: 'pair_1' },
  { id: 'pair_1', type: 'candidate-pair', localCandidateId: 'cand_l', remoteCandidateId: 'cand_r' },
  { id: 'cand_l', type: 'local-candidate', candidateType: 'relay' },
  { id: 'cand_r', type: 'remote-candidate', candidateType: 'host' },
];

/** The same shape, host to host: nothing in the middle. */
const DIRECT_STATS = [
  { id: 'transport_1', type: 'transport', selectedCandidatePairId: 'pair_1' },
  { id: 'pair_1', type: 'candidate-pair', localCandidateId: 'cand_l', remoteCandidateId: 'cand_r' },
  { id: 'cand_l', type: 'local-candidate', candidateType: 'host' },
  { id: 'cand_r', type: 'remote-candidate', candidateType: 'srflx' },
];

const presenceEntry = (userId: UserId, state: PresenceEntry['state']): PresenceEntry => ({
  userId,
  state,
  micOn: true,
  camOn: false,
  sharing: false,
  lastSeenTs: 0,
});

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
  expiresAt: null,
  hasPassword: false,
  createdAt: 1_000,
});

const member = (): Member => ({
  roomId: ROOM_ID,
  userId: ME,
  role: 'host',
  joinedAt: 1_000,
  banned: false,
});

const memberRow = (userId: UserId, displayName: string) => ({
  user: { id: userId, displayName, avatarUrl: null, accentColor: '#ffffff' },
});

function fakeConnection(initial: Record<UserId, PresenceEntry>): RoomConnection {
  const useRoomState = create<{
    presence: Record<UserId, PresenceEntry>;
    playback: null;
    membersVersion: number;
  }>()(() => ({ presence: initial, playback: null, membersVersion: 0 }));
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

/* ────────────────────────────────────────────────────────────────────────────
   The rules, on their own
   ──────────────────────────────────────────────────────────────────────────── */

describe('what a tile may say about one link', () => {
  it('will not call a first attempt a re-connection', () => {
    expect(
      linkStatusFor({ connection: 'failed', everConnected: false, unreachable: false }),
    ).toBe('connecting');
    expect(
      linkStatusFor({ connection: 'failed', everConnected: true, unreachable: false }),
    ).toBe('reconnecting');
  });

  it('says nothing at all about a link that is fine, or one it holds no state for', () => {
    expect(
      linkStatusFor({ connection: 'connected', everConnected: true, unreachable: false }),
    ).toBe('ok');
    expect(
      linkStatusFor({ connection: undefined, everConnected: false, unreachable: false }),
    ).toBe('ok');
    // 'new' is the instant between constructing a peer connection and offering
    // on it — labelling it would put "Connecting…" under every tile that has
    // only just appeared.
    expect(linkStatusFor({ connection: 'new', everConnected: false, unreachable: false })).toBe(
      'ok',
    );
  });

  it('lets the mesh’s verdict outrank any state the link is passing through', () => {
    expect(
      linkStatusFor({ connection: 'disconnected', everConnected: true, unreachable: true }),
    ).toBe('unreachable');
  });

  it('never offers hope in the copy for a link that has stopped trying', () => {
    expect(LINK_STATUS_LABEL.unreachable).not.toMatch(/connect(ing|…)|reconnect/i);
  });
});

describe('what the badge may claim about where the media goes', () => {
  const link = (
    path: 'direct' | 'relayed' | 'unknown',
    connection: MeshConnectionState = 'connected',
  ) => ({ connection, path, lost: false });

  it('claims private only when every link is classified direct', () => {
    expect(callPathFrom([link('direct'), link('direct')])).toBe('direct');
    expect(CALL_PATH_LABEL.direct).toMatch(/private/i);
  });

  /** One relayed link means a server we rent is carrying part of this
   *  conversation. A badge that still said "Private · device-to-device" was
   *  the one claim a privacy promise cannot afford to guess at. */
  it('admits a relay the moment any link crosses one', () => {
    expect(callPathFrom([link('relayed')])).toBe('relayed');
    expect(callPathFrom([link('relayed'), link('direct')])).toBe('mixed');
    expect(CALL_PATH_LABEL.relayed).toMatch(/relay/i);
    expect(CALL_PATH_LABEL.mixed).toMatch(/relay/i);
    // Relayed is not readable: TURN forwards packets it cannot decrypt, and
    // dropping that half turns an honest disclosure into a scare.
    expect(CALL_PATH_LABEL.relayed).toMatch(/encrypted/i);
  });

  it('refuses to guess when the stats refuse to say', () => {
    // Connected, and this browser will not name the route. 'direct' would be a
    // guess in the one direction that costs something.
    expect(callPathFrom([link('unknown')])).toBe('unknown');
    expect(CALL_PATH_LABEL.unknown).not.toMatch(/private|direct|relay/i);
  });

  it('separates "not yet" from "will not say"', () => {
    expect(callPathFrom([link('unknown', 'connecting')])).toBe('connecting');
    expect(callPathFrom([])).toBe('alone');
  });

  /** A call the mesh has given up on is carrying nothing. Saying "Connecting…"
   *  there is the badge's own version of the endless spinner. */
  it('stops saying "connecting" about links nobody is still trying', () => {
    expect(callPathFrom([{ ...link('unknown'), lost: true }])).toBe('none');
    expect(CALL_PATH_LABEL.none).not.toMatch(/connecting|private|relay/i);
    // One lost link among working ones does not describe the call.
    expect(callPathFrom([{ ...link('unknown'), lost: true }, link('direct')])).toBe('direct');
  });
});

describe('the sentence a person gets when somebody cannot be reached', () => {
  const NO_ONE = { names: [], others: 2, relay: 'absent' as const };

  it('stays silent while everybody is reachable', () => {
    expect(connectivityNote(NO_ONE)).toBeNull();
  });

  it('names the configuration, the consequence, and the move that works', () => {
    const note = connectivityNote({ names: ['Alex'], others: 1, relay: 'absent' }) ?? '';
    expect(note).toContain('Alex');
    expect(note).toMatch(/networks/i);
    expect(note).toMatch(/no relay/i);
    // The one thing that actually gets around it. Not a reload — a reload
    // rebuilds exactly the same impossible link.
    expect(note).toMatch(/different network|hotspot/i);
    expect(note).not.toMatch(/reload/i);
  });

  it('is written for a person, not for an engineer', () => {
    const notes = [
      connectivityNote({ names: ['Alex'], others: 1, relay: 'absent' }) ?? '',
      connectivityNote({ names: ['Alex'], others: 1, relay: 'available' }) ?? '',
      connectivityNote({ names: ['Alex'], others: 1, relay: 'unknown' }) ?? '',
    ];
    for (const note of notes) {
      expect(note).not.toMatch(/\bICE\b|\bNAT\b|\bTURN\b|\bSTUN\b|candidate|symmetric|CGNAT/i);
    }
  });

  /** With a relay configured, "there is no relay" would be a confident wrong
   *  answer. Unknown gets the same treatment: we have not been told. */
  it('does not blame a relay that exists, or one it has not heard about', () => {
    for (const relay of ['available', 'unknown'] as const) {
      const note = connectivityNote({ names: ['Alex'], others: 1, relay }) ?? '';
      expect(note).not.toMatch(/no relay/i);
      expect(note).toMatch(/reload/i);
    }
  });

  it('scales from one name to everybody without ever growing past a line', () => {
    expect(connectivityNote({ names: ['Alex', 'Sam'], others: 3, relay: 'absent' })).toContain(
      'Alex and Sam',
    );
    expect(
      connectivityNote({ names: ['Alex', 'Sam', 'Jo'], others: 4, relay: 'absent' }),
    ).toContain('Alex and 2 others');
    // Everybody is a different sentence from a list of everybody.
    expect(
      connectivityNote({ names: ['Alex', 'Sam'], others: 2, relay: 'absent' }),
    ).toContain('anyone else');
  });

  /** The mesh is per-link. One person on a hostile network must not be
   *  reported as the whole call going down. */
  it('names the person when the rest of the call is fine', () => {
    const note = connectivityNote({ names: ['Alex'], others: 3, relay: 'absent' }) ?? '';
    expect(note).toContain('Alex');
    expect(note).not.toContain('anyone else');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   The whole path, through a real mesh
   ──────────────────────────────────────────────────────────────────────────── */

describe('a call that never connects, end to end', () => {
  let host: HTMLDivElement;
  let root: Root;
  let session: ReturnType<typeof useCallSession> | null = null;
  let connection: RoomConnection;

  function Probe() {
    session = useCallSession();
    return (
      <div data-testid="probe">
        {session.participants.map((p) => `${p.userId}:${p.linkStatus}`).join(',')}
      </div>
    );
  }

  const probe = (): string => host.querySelector('[data-testid="probe"]')?.textContent ?? '';
  const dockText = (): string => host.textContent ?? '';

  /**
   * The visible text of ONE person's row.
   *
   * Scoped deliberately: the dock's own badge and the sentence below the tiles
   * both carry these words too, so an assertion over the whole surface passes
   * whether or not the tile itself says anything — which is exactly the bug
   * being pinned.
   */
  const tileText = (name: string): string => {
    for (const li of host.querySelectorAll('li')) {
      if (li.textContent?.includes(name) === true) return li.textContent;
    }
    return '';
  };

  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.resolve(STUN_ONLY);
    roomStub.members = [memberRow(ME, 'Me'), memberRow(ALEX, 'Alex'), memberRow(SAM, 'Sam')];
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    session = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    closeCallMesh(connection);
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  const mount = async (presence: Record<UserId, PresenceEntry>): Promise<void> => {
    connection = fakeConnection(presence);
    roomStub.connection = connection;
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

  /** Spend the mesh's whole ICE recovery budget. */
  const exhaust = async (): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
  };

  it('stops saying "Reconnecting…" at a link that was never connected', async () => {
    vi.useFakeTimers();
    try {
      await mount({ [ALEX]: presenceEntry(ALEX, 'in-call') });

      await act(async () => {
        FakePc.instances[0]?.setConnectionState('failed');
        await settle();
      });
      // Nothing was ever established between these two, so there is nothing to
      // re-connect. It is still trying, and the tile says so.
      expect(probe()).toBe(`${ALEX}:connecting`);
      expect(tileText('Alex')).toContain(LINK_STATUS_LABEL.connecting);
      expect(tileText('Alex')).not.toContain(LINK_STATUS_LABEL.reconnecting);

      await exhaust();

      expect(probe()).toBe(`${ALEX}:unreachable`);
      expect(tileText('Alex')).toContain(LINK_STATUS_LABEL.unreachable);
      expect(tileText('Alex')).not.toContain(LINK_STATUS_LABEL.connecting);
      // And it reads as one to a screen reader, not just to an eye.
      expect(host.querySelector('figure')?.getAttribute('aria-label')).toContain(
        'cannot connect',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('says out loud that the room has no relay, once it has stopped trying', async () => {
    vi.useFakeTimers();
    try {
      await mount({ [ALEX]: presenceEntry(ALEX, 'in-call') });
      await act(async () => {
        FakePc.instances[0]?.setConnectionState('failed');
        await settle();
      });
      // Not while it is still trying: this sentence ends a call, and saying it
      // over a link that is about to come up would be its own lie.
      expect(session?.connectivityNote).toBeNull();

      await exhaust();

      const note = session?.connectivityNote ?? '';
      expect(note).toContain('Alex');
      expect(note).toMatch(/no relay/i);
      // It has to be on the surface a person is looking at, not only in state.
      expect(dockText()).toContain(note);
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(note);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Same failure, a deployment that HAS a relay: the room must not invent a
   *  cause it has evidence against. */
  it('does not blame a relay the deployment actually has', async () => {
    vi.useFakeTimers();
    try {
      turnStub.fetch = () => Promise.resolve(WITH_RELAY);
      await mount({ [ALEX]: presenceEntry(ALEX, 'in-call') });
      await act(async () => {
        FakePc.instances[0]?.setConnectionState('failed');
        await settle();
      });
      await exhaust();

      expect(session?.connectivityNote).not.toMatch(/no relay/i);
      expect(session?.connectivityNote).toMatch(/reload/i);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The mesh is per-link, and the surface has to be too: one person nobody can
   * reach must not make the other two look broken.
   */
  it('keeps a working call working when one person cannot be reached', async () => {
    vi.useFakeTimers();
    try {
      await mount({
        [ALEX]: presenceEntry(ALEX, 'in-call'),
        [SAM]: presenceEntry(SAM, 'in-call'),
      });
      expect(FakePc.instances).toHaveLength(2);

      await act(async () => {
        FakePc.instances[0]?.setConnectionState('connected');
        FakePc.instances[1]?.setConnectionState('failed');
        await settle();
      });
      await exhaust();

      expect(probe()).toBe(`${ALEX}:ok,${SAM}:unreachable`);
      const note = session?.connectivityNote ?? '';
      expect(note).toContain('Sam');
      expect(note).not.toContain('Alex');
      expect(note).not.toContain('anyone else');
      // The roster is intact — the call did not "fail", one link did.
      expect(session?.participants).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the sentence back down when the link comes back', async () => {
    vi.useFakeTimers();
    try {
      await mount({ [ALEX]: presenceEntry(ALEX, 'in-call') });
      await act(async () => {
        FakePc.instances[0]?.setConnectionState('failed');
        await settle();
      });
      await exhaust();
      expect(session?.connectivityNote).not.toBeNull();

      await act(async () => {
        FakePc.instances[0]?.setConnectionState('connected');
        await settle();
      });

      expect(session?.connectivityNote).toBeNull();
      expect(probe()).toBe(`${ALEX}:ok`);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the badge, against a live mesh', () => {
  let host: HTMLDivElement;
  let root: Root;
  let session: ReturnType<typeof useCallSession> | null = null;
  let connection: RoomConnection;

  function Probe() {
    session = useCallSession();
    return <div data-testid="badge">{session.relayLabel}</div>;
  }

  const badge = (): string => host.querySelector('[data-testid="badge"]')?.textContent ?? '';

  beforeEach(() => {
    FakePc.reset();
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    turnStub.fetch = () => Promise.resolve(WITH_RELAY);
    roomStub.members = [memberRow(ALEX, 'Alex')];
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    session = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    closeCallMesh(connection);
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  const mount = async (): Promise<void> => {
    connection = fakeConnection({ [ALEX]: presenceEntry(ALEX, 'in-call') });
    roomStub.connection = connection;
    roomStub.room = room();
    roomStub.member = member();
    await act(async () => {
      root.render(
        <CallSessionProvider>
          <Probe />
        </CallSessionProvider>,
      );
      await settle();
    });
  };

  const classify = async (stats: unknown): Promise<void> => {
    const pc = FakePc.instances[0];
    if (pc !== undefined) pc.statsResult = stats;
    await act(async () => {
      pc?.setConnectionState('connected');
      await getCallMesh(connection, ME).pollLinkStats();
      await settle();
    });
  };

  it('says relayed when every byte is crossing a relay', async () => {
    await mount();
    await classify(RELAYED_STATS);
    expect(badge()).toBe(CALL_PATH_LABEL.relayed);
    // The exact wording this replaces. It was shown unconditionally.
    expect(badge()).not.toBe('Private · device-to-device');
  });

  it('says private only once the stats have actually said direct', async () => {
    await mount();
    // Connected, unclassified: this is where the old badge already claimed
    // privacy, from a room column that describes nothing about the route.
    await classify(undefined);
    expect(badge()).toBe(CALL_PATH_LABEL.unknown);

    await classify(DIRECT_STATS);
    expect(badge()).toBe(CALL_PATH_LABEL.direct);
  });
});
