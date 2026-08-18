// @vitest-environment jsdom
/**
 * A GUEST WHO OPENS A SECOND INVITE LINK.
 *
 * What actually happens today, traced end to end:
 *
 *   • A guest holds a ROOM-SCOPED identity. The access token carries
 *     `guest: true` and a `guestRoomId`, and every room route runs
 *     `assertGuestScope` (services/api/.../rooms/routes.ts).
 *   • JoinClient only asks "is someone signed in?". A guest IS signed in, so
 *     the second invite link offers them "Join the room", which posts
 *     /rooms/join.
 *   • That route is `requireAccount`, which rejects EVERY guest outright with
 *     FORBIDDEN 'full account required' — before the invite code is even read.
 *   • JoinClient maps any FORBIDDEN to "You are banned from this room."
 *
 * So the app invents a ban that never happened, for an action it should not
 * have offered, and leaves no way forward. Three separate lies in one click.
 *
 * THE DECISION THIS FILE PINS: let them proceed, do not merely soften the
 * error. `POST /auth/guest` takes no authentication at all and mints a fresh
 * room-scoped guest — the path works today, server-side, unchanged. Refusing
 * a guest entry to a second room would be inventing a restriction the server
 * does not have. What the UI owes them is the truth about the cost: a new
 * guest identity replaces this browser's credentials (the refresh cookie and
 * access token are overwritten), so the room they are in now becomes
 * unreachable unless they attach an email first.
 *
 * And the cheaper case first: a guest re-opening the link for the room they
 * are ALREADY in must be let back INTO it, not handed a second throwaway
 * identity in the same room.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@gather/api-client';
import type { InviteCode, Room, RoomId, User, UserId } from '@gather/contracts';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = 'ABCD2345' as InviteCode; // the link being opened
const MY_ROOM = 'ZZZZ9999' as InviteCode; // the room the guest is already in

const authStub = vi.hoisted(() => ({ user: null as unknown, isGuest: false }));
const apiStub = vi.hoisted(() => ({
  myRooms: [] as unknown[],
  joinRoom: vi.fn(),
  guestJoin: vi.fn(),
  replaced: [] as string[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    replace: (href: string) => {
      apiStub.replaced.push(href);
    },
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: authStub.user,
    loading: false,
    isGuest: authStub.isGuest,
    setUser: () => undefined,
    refresh: () => Promise.resolve(null),
    logout: () => Promise.resolve(),
  }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    rooms: {
      listMyRooms: () => Promise.resolve({ rooms: apiStub.myRooms }),
      joinRoom: (body: unknown) => apiStub.joinRoom(body),
    },
  },
  guestJoin: (body: unknown) => apiStub.guestJoin(body),
}));

const { JoinClient, describeJoinFailure } = await import('@/app/join/[code]/join-client');

/* ── fixtures ────────────────────────────────────────────────────────────── */

const guest = (): User => ({
  id: 'user_guest' as UserId,
  email: null,
  displayName: 'Wanderer',
  avatarUrl: null,
  accentColor: '#8b5cf6',
  createdAt: 1_000,
});

const account = (): User => ({ ...guest(), id: 'user_acct' as UserId, email: 'a@b.test' });

const roomWith = (inviteCode: InviteCode, id: string): Room => ({
  id: id as RoomId,
  kind: 'watch',
  name: 'Somewhere',
  inviteCode,
  ownerId: 'user_owner' as UserId,
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

/* ── harness ─────────────────────────────────────────────────────────────── */

let host: HTMLDivElement;
let root: Root;

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
};

const text = (): string => host.textContent ?? '';

function button(match: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) =>
    ((b.getAttribute('aria-label') ?? '') + (b.textContent ?? '')).includes(match),
  );
}

function link(match: string): HTMLAnchorElement | undefined {
  return [...host.querySelectorAll('a')].find((a) => (a.textContent ?? '').includes(match));
}

async function mount(code: InviteCode): Promise<void> {
  await act(async () => {
    root.render(React.createElement(JoinClient, { code }));
  });
  await settle();
}

describe('a guest opening an invite link', () => {
  beforeEach(() => {
    authStub.user = guest();
    authStub.isGuest = true;
    apiStub.myRooms = [];
    apiStub.joinRoom = vi.fn(() => Promise.resolve({ room: roomWith(HERE, 'room_here') }));
    apiStub.guestJoin = vi.fn(() =>
      Promise.resolve({ user: guest(), room: roomWith(HERE, 'room_here') }),
    );
    apiStub.replaced = [];
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

  it('never offers the member join a guest is categorically refused', async () => {
    await mount(HERE);

    // POST /rooms/join is requireAccount: it fails for every guest, always,
    // regardless of the invite code. Offering it is offering a dead button.
    expect(button('Join the room')).toBeUndefined();
    expect(apiStub.joinRoom).not.toHaveBeenCalled();
  });

  it('explains the real reason and the real cost', async () => {
    await mount(HERE);

    expect(text()).toContain('one room');
    // The cost has to be said out loud: the new guest replaces this browser's
    // credentials, so the other room is gone unless an email is attached.
    expect(text().toLowerCase()).toContain('email');
  });

  it('offers the action that actually works', async () => {
    await mount(HERE);

    const input = host.querySelector('input');
    expect(input).not.toBeNull();
    await act(async () => {
      if (input !== null) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        setter?.call(input, 'Wanderer');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    const submit = button('Join as guest');
    expect(submit).toBeDefined();
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    expect(apiStub.guestJoin).toHaveBeenCalledWith({
      inviteCode: HERE,
      displayName: 'Wanderer',
    });
    expect(apiStub.replaced).toContain('/room/room_here');
  });

  it('lets a guest back into the room they are already in, without a second identity', async () => {
    apiStub.myRooms = [{ room: roomWith(HERE, 'room_mine'), unreadCount: 0, memberCount: 2, muted: false }];

    await mount(HERE);

    expect(link('Open the room')?.getAttribute('href')).toBe('/room/room_mine');
    expect(button('Join as guest')).toBeUndefined();
  });

  it('leaves a full account alone', async () => {
    authStub.user = account();
    authStub.isGuest = false;

    await mount(HERE);

    expect(button('Join the room')).toBeDefined();
    expect(text()).not.toContain('one room');
  });

  it('still shows the plain guest form to someone signed out', async () => {
    authStub.user = null;
    authStub.isGuest = false;

    await mount(MY_ROOM);

    expect(button('Join as guest')).toBeDefined();
    // Nothing to warn about: there is no identity to lose.
    expect(text()).not.toContain('one room');
  });
});

/**
 * The failure copy. Two of these are load-bearing beyond the guest story:
 * FORBIDDEN is not a synonym for "banned", and a CONFLICT from the store's
 * guest-uniqueness index is not something "try again" ever fixes.
 */
describe('describeJoinFailure', () => {
  const err = (code: string, message: string, status: number): unknown =>
    new ApiError(code as never, message, status);

  it('does not invent a ban out of a guest-scope refusal', () => {
    const note = describeJoinFailure(err('FORBIDDEN', 'full account required', 403));
    expect(note.toLowerCase()).not.toContain('banned');
  });

  it('still says banned when the server actually said banned', () => {
    const note = describeJoinFailure(err('FORBIDDEN', 'banned from this room', 403));
    expect(note.toLowerCase()).toContain('banned');
  });

  it('names what to change on a duplicate-key conflict instead of "try again"', () => {
    const note = describeJoinFailure(
      err('CONFLICT', 'Unique index violation on (roomId, displayName)', 409),
    );
    expect(note.toLowerCase()).toContain('name');
    expect(note.toLowerCase()).not.toContain('try again');
  });

  it('keeps the invite-code and rate-limit copy', () => {
    expect(describeJoinFailure(err('NOT_FOUND', 'invite not found', 404))).toContain('invite');
    expect(describeJoinFailure(err('RATE_LIMITED', 'slow down', 429))).toContain('wait');
  });
});
