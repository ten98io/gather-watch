// @vitest-environment jsdom
/**
 * THE ROOM MENU'S TWO DEAD ENDPOINTS.
 *
 * `PATCH /rooms/:id/policies` had no caller anywhere in the product, so every
 * room in production sat on its creation defaults for ever: the 'mods' tier is
 * honoured across kick, ban, pin, rename, theater and waitForAll — an entire
 * authorization layer no room could reach. And `POST /rooms/:id/leave` had no
 * caller either, while the only control named "leave" was an <a href="/home">;
 * combined with rooms that never expire, /home was append-only.
 *
 * What is asserted here is the wire, not the widget: which people are offered
 * the controls, the exact PATCH body each one sends (a PARTIAL patch — the
 * server merges, and posting a whole RoomPolicies would let a stale dialog
 * quietly revert a policy nobody touched), and that a refusal is spoken.
 *
 * jsdom because none of it exists in static markup — the menu is a dialog.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@gather/api-client';
import type { Member, MemberRole, Room, UpdatePoliciesBody } from '@gather/contracts';
import { canAct } from '@/lib/permissions';

// Classic JSX runtime — see test/context-menu.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stub = vi.hoisted(() => ({
  policyPatches: [] as UpdatePoliciesBody[],
  leaveCalls: 0,
  pushed: [] as string[],
  /** Code the next room write rejects with, or null to resolve. */
  failWith: null as string | null,
  room: null as unknown as Room,
  member: null as unknown as Member,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (href: string) => stub.pushed.push(href),
    replace: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
}));

function refuse(): Promise<never> {
  return Promise.reject(new ApiError(stub.failWith as 'FORBIDDEN', 'raw server body', 403));
}

vi.mock('@/lib/api', () => ({
  api: {
    rooms: {
      updatePolicies: (_roomId: string, body: UpdatePoliciesBody) => {
        stub.policyPatches.push(body);
        return stub.failWith !== null ? refuse() : Promise.resolve({ room: stub.room });
      },
      leaveRoom: () => {
        stub.leaveCalls += 1;
        return stub.failWith !== null ? refuse() : Promise.resolve({ ok: true as const });
      },
    },
    reports: { create: () => Promise.resolve({ ok: true as const, reportId: 'rep_1' }) },
  },
  apiFetch: () => Promise.resolve({}),
}));

vi.mock('@/lib/room-context', () => ({
  RoomProvider: ({ children }: { children: React.ReactNode }) => children,
  useRoom: () => ({ room: stub.room, member: stub.member }),
  useRoomConnection: () => ({
    useRoomState: (select: (s: Record<string, unknown>) => unknown) => select({}),
  }),
}));

const { RoomMenu } = await import('@/components/room/RoomMenu');
const { Toaster } = await import('@/components/ui/toast');
const { makeMember, makeRoom } = await import('./helpers/room-render');

const h = React.createElement;
const SKIP_SLIDER = 'input[aria-label="Skip on a vote of"]';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stub.policyPatches = [];
  stub.leaveCalls = 0;
  stub.pushed = [];
  stub.failWith = null;
  stub.room = makeRoom('watch');
  stub.member = makeMember('host');
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

function controls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('button, [role="switch"]')];
}

function labelled(name: string): HTMLElement | undefined {
  return controls().find((c) => (c.getAttribute('aria-label') ?? c.textContent?.trim()) === name);
}

function press(name: string): void {
  const el = labelled(name);
  if (el === undefined) throw new Error(`no control named "${name}"`);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function toastSaying(text: string): boolean {
  return [...document.querySelectorAll('[role="alert"], [role="status"]')].some((card) =>
    card.textContent?.includes(text),
  );
}

/** Mount the menu as `role` sees it — canManage comes from canAct, exactly as
 *  room-shell derives it, so this covers the wiring and not just the prop. */
async function openMenuAs(role: MemberRole, room: Room = stub.room): Promise<void> {
  stub.member = { ...makeMember(role) };
  stub.room = room;
  await act(async () => {
    root.render(
      h(
        React.Fragment,
        null,
        h(RoomMenu, { room, canManage: canAct('mods', role) }),
        h(Toaster, null),
      ),
    );
  });
  press('Room settings');
}

describe('who is offered the policy controls', () => {
  it('a host is', async () => {
    await openMenuAs('host');
    expect(labelled('Who can queue: Everyone')).toBeDefined();
    expect(labelled('Wait for everyone before playing')).toBeDefined();
  });

  it('a moderator is — the mods tier is what the server enforces here', async () => {
    await openMenuAs('moderator');
    expect(labelled('Who can play: Mods')).toBeDefined();
  });

  it('a member is not, and neither is a guest', async () => {
    await openMenuAs('member');
    expect(labelled('Who can play: Mods')).toBeUndefined();
    expect(labelled('Skip on a vote of')).toBeUndefined();

    await openMenuAs('guest');
    expect(labelled('Who can play: Mods')).toBeUndefined();
  });

  it('the password row stays host-only inside a menu everyone can open', async () => {
    await openMenuAs('moderator');
    expect(document.querySelector('input[aria-label="Room password"]')).toBeNull();
    await openMenuAs('host');
    expect(document.querySelector('input[aria-label="Room password"]')).not.toBeNull();
  });
});

describe('each control PATCHes only its own field', () => {
  it('a tier button sends that one policy', async () => {
    await openMenuAs('host');
    press('Who can queue: Mods');
    await settle();
    expect(stub.policyPatches).toEqual([{ queueControl: 'mods' }]);
  });

  it('the three tiered policies are independent', async () => {
    await openMenuAs('host');
    // One at a time: the section disables itself while a save is in flight, so
    // two patches cannot race and land in the wrong order.
    press('Who can play: Host');
    await settle();
    press('Who can chat: Everyone');
    await settle();
    expect(stub.policyPatches).toEqual([{ playbackControl: 'host' }, { chat: 'everyone' }]);
  });

  it('wait-for-all sends a boolean, flipped from the room', async () => {
    // The fixture room waits, so the switch's job here is to stop it.
    expect(stub.room.policies.waitForAll).toBe(true);
    await openMenuAs('host');
    press('Wait for everyone before playing');
    await settle();
    expect(stub.policyPatches).toEqual([{ waitForAll: false }]);
  });

  it('the vote-skip slider commits a fraction, not a percentage', async () => {
    await openMenuAs('host');
    const slider = document.querySelector<HTMLInputElement>(SKIP_SLIDER);
    if (slider === null) throw new Error('no vote-skip slider');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(slider, '80');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      // The native `change` event is the end of the interaction — Slider
      // commits there, not on every drag frame.
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    // 0..1 on the wire (RoomPolicies.skipVoteThreshold), 0..100 in the UI.
    expect(stub.policyPatches).toEqual([{ skipVoteThreshold: 0.8 }]);
  });

  it('a refused change is spoken, and the thumb goes back where the room has it', async () => {
    stub.failWith = 'ROOM_POLICY';
    await openMenuAs('host');
    const slider = document.querySelector<HTMLInputElement>(SKIP_SLIDER);
    if (slider === null) throw new Error('no vote-skip slider');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(slider, '100');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();

    expect(toastSaying('You don’t have permission to do that here.')).toBe(true);
    expect(toastSaying('raw server body')).toBe(false);
    // 50% is the fixture room's stored threshold: the control tells the truth
    // about the room again rather than showing a value that never landed.
    expect(slider.value).toBe('50');
  });
});

describe('leaving a room actually leaves it', () => {
  it('is offered to everyone, whatever their role', async () => {
    await openMenuAs('member');
    expect(labelled('Leave room…')).toBeDefined();
    await openMenuAs('guest');
    expect(labelled('Leave room…')).toBeDefined();
    await openMenuAs('host');
    expect(labelled('Leave room…')).toBeDefined();
  });

  it('calls the endpoint and only then goes home', async () => {
    await openMenuAs('member');
    press('Leave room…');
    // Confirmation is a sanctioned exception to the ≤3-step budget
    // (DESIGN.md §12), and leaving costs an invite to undo.
    press('Leave');
    await settle();

    expect(stub.leaveCalls).toBe(1);
    expect(stub.pushed).toEqual(['/home']);
  });

  it('does not navigate when the server refuses — that would look like success', async () => {
    stub.failWith = 'NOT_FOUND';
    await openMenuAs('member');
    press('Leave room…');
    press('Leave');
    await settle();

    expect(stub.leaveCalls).toBe(1);
    expect(stub.pushed).toEqual([]);
    expect(toastSaying('That no longer exists.')).toBe(true);
  });

  it('can be backed out of before it happens', async () => {
    await openMenuAs('member');
    press('Leave room…');
    press('Stay');
    await settle();
    expect(stub.leaveCalls).toBe(0);
    expect(labelled('Leave room…')).toBeDefined();
  });
});
