/**
 * When the room ends your session, it has to say so.
 *
 * A terminal close already recorded its reason, but the only consumer was a
 * stage watchdog — so someone who had just been kicked saw an "Offline" pill,
 * character for character the same thing a dropped wifi shows. The two are
 * not the same: one reconnects on its own, the other never will.
 *
 * RoomLayout is SSR-rendered with the same harness as room-shell-theater
 * (`useMediaQuery` is false on the server, which takes the mobile branch and
 * still renders the whole header). `next/navigation` is mocked because
 * RoomMenu grabs a router for its rename/delete actions.
 */
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MEMBER_REMOVAL_CLOSE_TEXT } from '@gather/contracts';
import { ROOM_ID, h, makeMember, makeRoom, renderInRoom } from './helpers/room-render';
import type { RoomClosedInfo } from '@/lib/room-connection';

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

const { RoomLayout } = await import('@/app/room/[id]/room-shell');

function renderClosed(closed: RoomClosedInfo | null): string {
  // Fresh per render: CallSessionProvider (inside RoomLayout) runs useQuery,
  // and a shared client would bleed cache between cases.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderInRoom(
    makeRoom('watch'),
    makeMember('member'),
    { closed },
    h(QueryClientProvider, { client }, h(RoomLayout, { roomId: ROOM_ID })),
  );
}

/** The exact prose the API puts on the close frame — never a hand-typed copy,
 *  so that editing the table cannot leave these tests green while the real
 *  screen falls back to the generic sentence. */
const closeText = MEMBER_REMOVAL_CLOSE_TEXT;

describe('a session the room ended', () => {
  it('says a kick was a kick, and offers a way out', () => {
    const html = renderClosed({ code: 4403, reason: closeText.kicked });
    expect(html).toContain('You were removed from this room');
    expect(html).toContain('A host or moderator removed you.');
    expect(html).toContain('Back to your rooms');
    // Blocking, not a pill in the corner: the room itself is gone from view.
    expect(html).not.toContain('Static test room');
    expect(html).not.toContain('Offline');
  });

  it('distinguishes a ban, a deleted room, and a dead session', () => {
    expect(renderClosed({ code: 4403, reason: closeText.banned })).toContain(
      'A host or moderator banned this account.',
    );
    expect(renderClosed({ code: 4403, reason: closeText.roomDeleted })).toContain(
      'A host deleted the room.',
    );
    expect(renderClosed({ code: 4403, reason: closeText.left })).toContain(
      'You are no longer a member here.',
    );
    expect(renderClosed({ code: 4404, reason: '' })).toContain('The room no longer exists.');
    expect(renderClosed({ code: 4401, reason: '' })).toContain('Sign in again to come back.');
  });

  it('has a 4403 sentence for the hub refusals, which carry no removal reason', () => {
    // hub.ts closes 4403 with 'not a member' / 'guest token is room-scoped';
    // neither is in the removal table, and both used to land on the vaguest
    // sentence in the file.
    const html = renderClosed({ code: 4403, reason: 'not a member' });
    expect(html).toContain('This room is not open to you');
    expect(html).toContain('Ask a member for a fresh invite link.');
    expect(html).not.toContain('not a member');
  });

  it('never shows the close code or the raw server text', () => {
    const html = renderClosed({ code: 4403, reason: closeText.kicked });
    expect(html).not.toContain('4403');
    // One plain sentence, not the wire enum.
    expect(html).not.toContain('>kicked<');
  });

  it('leaves the room alone when nothing refused this session', () => {
    const html = renderClosed(null);
    expect(html).toContain('Static test room');
    expect(html).not.toContain('Back to your rooms');
  });
});
