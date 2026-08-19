// @vitest-environment jsdom
/**
 * MODERATORS COULD NOT BE CREATED.
 *
 * `POST /rooms/:roomId/members/role` is live and enforced, and there was no
 * api-client method for it and no control anywhere — so the 'moderator' role
 * existed only for the room owner's own demotion on a host transfer. Every
 * `'mods'` policy tier, every `requireRole('host', 'moderator')` on the server,
 * described a population of exactly zero.
 *
 * The gate is the interesting half. The server refuses four cases outright —
 * the caller themselves, the host seat, a guest (upgrading is an account move),
 * and a banned row — so each of those must not be DRAWN. A button that only
 * ever returns 403 is worse than no button: it teaches people the product is
 * broken rather than that the action is not theirs.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@gather/api-client';
import type { Member, MemberRole, Room, User, UserId } from '@gather/contracts';

// Classic JSX runtime — see test/context-menu.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface RoleCall {
  userId: string;
  role: string;
}

const stub = vi.hoisted(() => ({
  roleCalls: [] as RoleCall[],
  failWith: null as string | null,
  roster: [] as Array<{ member: unknown; user: unknown }>,
  room: null as unknown as Room,
  member: null as unknown as Member,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    rooms: {
      listMembers: () => Promise.resolve({ members: stub.roster }),
      setMemberRole: (_roomId: string, body: RoleCall) => {
        stub.roleCalls.push(body);
        return stub.failWith !== null
          ? Promise.reject(new ApiError(stub.failWith as 'ROOM_POLICY', 'raw server body', 403))
          : Promise.resolve({ member: stub.member });
      },
      transferHost: () => Promise.resolve({ ok: true as const }),
      kickMember: () => Promise.resolve({ ok: true as const }),
      banMember: () => Promise.resolve({ ok: true as const }),
    },
    reports: { create: () => Promise.resolve({ ok: true as const, reportId: 'rep_1' }) },
  },
  apiFetch: () => Promise.resolve({}),
}));

vi.mock('@/lib/room-context', () => ({
  RoomProvider: ({ children }: { children: React.ReactNode }) => children,
  useRoom: () => ({ room: stub.room, member: stub.member }),
  useRoomConnection: () => ({
    useRoomState: (select: (s: { presence: object; membersVersion: number }) => unknown) =>
      select({ presence: {}, membersVersion: 0 }),
  }),
}));

const { PeoplePane } = await import('@/components/people/PeoplePane');
const { Toaster } = await import('@/components/ui/toast');
const { ME, ROOM_ID, makeMember, makeRoom } = await import('./helpers/room-render');

const h = React.createElement;

const ROBIN = 'user-robin' as UserId;
const SAM = 'user-sam' as UserId;

function user(id: UserId, displayName: string): User {
  return {
    id,
    email: null,
    displayName,
    avatarUrl: null,
    accentColor: '#7c5cfc',
    createdAt: 1_000,
  } as User;
}

function row(
  userId: UserId,
  displayName: string,
  role: MemberRole,
  banned = false,
): { member: Member; user: User } {
  return {
    member: { roomId: ROOM_ID, userId, role, joinedAt: 1_000, banned },
    user: user(userId, displayName),
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stub.roleCalls = [];
  stub.failWith = null;
  stub.room = makeRoom('watch');
  stub.member = makeMember('host');
  stub.roster = [];
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
});

function labelled(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name,
  );
}

function press(name: string): void {
  const el = labelled(name);
  if (el === undefined) throw new Error(`no control named "${name}"`);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function toastSaying(text: string): boolean {
  return [...document.querySelectorAll('[role="alert"], [role="status"]')].some((card) =>
    card.textContent?.includes(text),
  );
}

/** Mount the roster as `myRole` sees it. */
async function mountAs(
  myRole: MemberRole,
  roster: Array<{ member: Member; user: User }>,
): Promise<void> {
  stub.member = { ...makeMember(myRole) };
  stub.roster = roster;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      h(
        QueryClientProvider,
        { client },
        h(PeoplePane, { roomId: ROOM_ID }),
        h(Toaster, null),
      ),
    );
  });
  // react-query hands the rows over on a macrotask.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('who may promote', () => {
  it('the host, on a plain member', async () => {
    await mountAs('host', [row(ME, 'Me', 'host'), row(ROBIN, 'Robin', 'member')]);
    expect(labelled('Make Robin a moderator')).toBeDefined();
  });

  it('a moderator may NOT — the server takes host only', async () => {
    await mountAs('moderator', [row(ME, 'Me', 'moderator'), row(ROBIN, 'Robin', 'member')]);
    expect(labelled('Make Robin a moderator')).toBeUndefined();
    // The kick they DO have is still there, so this is a gate and not a
    // roster that failed to render.
    expect(labelled('Kick Robin')).toBeDefined();
  });

  it('a member may not, and is offered no moderation at all', async () => {
    await mountAs('member', [row(ME, 'Me', 'member'), row(ROBIN, 'Robin', 'member')]);
    expect(labelled('Make Robin a moderator')).toBeUndefined();
    expect(labelled('Kick Robin')).toBeUndefined();
  });
});

describe('the rows the server would refuse are not drawn', () => {
  it('not your own row', async () => {
    await mountAs('host', [row(ME, 'Me', 'host')]);
    expect(labelled('Make Me a moderator')).toBeUndefined();
    expect(labelled('Remove moderator from Me')).toBeUndefined();
  });

  it('not a guest — that is an account upgrade, not a room write', async () => {
    await mountAs('host', [row(ME, 'Me', 'host'), row(SAM, 'Sam', 'guest')]);
    expect(labelled('Make Sam a moderator')).toBeUndefined();
    // Nor the host seat, which refuses a guest for the same reason.
    expect(labelled('Make Sam host')).toBeUndefined();
    // A guest can still be removed, which is the power that does apply.
    expect(labelled('Kick Sam')).toBeDefined();
  });

  it('not a banned member', async () => {
    await mountAs('host', [row(ME, 'Me', 'host'), row(ROBIN, 'Robin', 'member', true)]);
    expect(labelled('Make Robin a moderator')).toBeUndefined();
    expect(labelled('Make Robin host')).toBeUndefined();
  });
});

describe('promoting and demoting', () => {
  it('promotes with the role the server expects', async () => {
    await mountAs('host', [row(ME, 'Me', 'host'), row(ROBIN, 'Robin', 'member')]);
    press('Make Robin a moderator');
    await act(async () => {
      await Promise.resolve();
    });
    expect(stub.roleCalls).toEqual([{ userId: ROBIN, role: 'moderator' }]);
  });

  it('the same control demotes, and says which way it is pointing', async () => {
    await mountAs('host', [row(ME, 'Me', 'host'), row(ROBIN, 'Robin', 'moderator')]);
    const toggle = labelled('Remove moderator from Robin');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');

    press('Remove moderator from Robin');
    await act(async () => {
      await Promise.resolve();
    });
    expect(stub.roleCalls).toEqual([{ userId: ROBIN, role: 'member' }]);
  });

  it('says so when the server refuses, without the raw body', async () => {
    stub.failWith = 'ROOM_POLICY';
    await mountAs('host', [row(ME, 'Me', 'host'), row(ROBIN, 'Robin', 'member')]);
    press('Make Robin a moderator');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastSaying('You don’t have permission to do that here.')).toBe(true);
    expect(toastSaying('raw server body')).toBe(false);
  });
});
