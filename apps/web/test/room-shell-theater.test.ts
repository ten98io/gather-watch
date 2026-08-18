/**
 * Theater is OFFERED by the stage and HELD by the user: the header control
 * exists while the current item is video — absent for music and for an empty
 * stage — and the room header carries no Watch/Listen badge any more (a room is
 * not a mode).
 *
 * What changed, and why the last case here reads the other way now: the layout
 * used to be re-derived per item (`room.theater && stageKind === 'video'`), so
 * a mixed queue hid and re-showed the whole rail as it flowed music → video →
 * music. That is not a mode, it is a twitch, and it cost a full remount of the
 * call dock every time (see room-shell-rail.test.tsx). The flag now decides the
 * layout on its own, and the item decides only whether the control is worth
 * offering — plus one rule the old shape never needed: while theater is ON the
 * control stays, whatever is playing, because a switch you can flip one way and
 * not back is a trap.
 *
 * RoomLayout is SSR-rendered with the same harness as stage-content.test.ts.
 * The server pass takes the mobile branch (`useMediaQuery` is false there),
 * which still renders the full header the control lives in. `next/navigation`
 * is mocked because RoomMenu grabs a router for its rename/delete actions.
 */
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MediaRef, Member, Room } from '@gather/contracts';
import {
  h,
  makeMember,
  makeRoom,
  playbackFor,
  queueItem,
  renderInRoom,
} from './helpers/room-render';

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

const SC_REF: MediaRef = { kind: 'soundcloud', url: 'https://soundcloud.com/artist/neon-rain' };
const YT_REF: MediaRef = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' };

function renderLayout(room: Room, member: Member, mediaRef: MediaRef | null): string {
  // Fresh per render: CallSessionProvider (inside RoomLayout) runs useQuery,
  // and a shared client would bleed cache between cases.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const items = mediaRef === null ? [] : [queueItem(mediaRef, 'Current item')];
  return renderInRoom(
    room,
    member,
    {
      playback: mediaRef === null ? null : playbackFor(mediaRef, 0),
      queue: { items, version: 1 },
    },
    h(QueryClientProvider, { client }, h(RoomLayout, { roomId: room.id })),
  );
}

describe('theater follows the playing item', () => {
  const host = makeMember('host');

  it('offers the theater control while video plays', () => {
    const html = renderLayout(makeRoom('watch'), host, YT_REF);
    expect(html).toContain('Turn theater mode on');
  });

  it('hides the theater control while music plays — even in a stored watch room', () => {
    // Theater OFF: there is no picture to fill, so there is nothing to offer.
    const html = renderLayout(makeRoom('watch'), host, SC_REF);
    expect(html).not.toContain('Turn theater mode');
  });

  it('hides the theater control while nothing plays', () => {
    const html = renderLayout(makeRoom('watch'), host, null);
    expect(html).not.toContain('Turn theater mode');
  });

  it('never offers the control to plain members', () => {
    const html = renderLayout(makeRoom('watch'), makeMember('member'), YT_REF);
    expect(html).not.toContain('Turn theater mode');
  });

  it('keeps the way OUT while theater is on and the queue moves to music', () => {
    // The queue moves on its own. Someone who turned theater on for a film and
    // then heard a song come on must still be able to turn it back off, so the
    // control survives the kind change even though nothing would offer it here.
    const html = renderLayout(makeRoom('watch', { theater: true }), host, SC_REF);
    expect(html).toContain('Turn theater mode off');
  });

  it('is still the user’s latch, not the item’s, when nothing plays at all', () => {
    const html = renderLayout(makeRoom('watch', { theater: true }), host, null);
    expect(html).toContain('Turn theater mode off');
  });
});

describe('the room header carries no mode badge', () => {
  it.each(['watch', 'listen'] as const)('stored kind %s renders no Watch/Listen badge', (kind) => {
    const html = renderLayout(makeRoom(kind), makeMember('host'), YT_REF);
    expect(html).not.toContain('>Watch<');
    expect(html).not.toContain('>Listen<');
  });
});
