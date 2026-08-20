/**
 * Theater is OFFERED by the stage and HELD by the viewer — and since the
 * 2026-08-20 unification the thing it holds is the LOCAL immersive mode
 * (DESIGN.md §11 D1.1): theater and fullscreen are one latch, per viewer,
 * never on the wire. What these cases pin:
 *
 *  · the OFFER conditions: the control exists while the current item is video
 *    or a screen share is live — absent for music and for an empty stage —
 *    because the mode is turned on over a picture, where filling the screen
 *    means something;
 *  · the control is NOT role-gated any more. The old server-backed flag
 *    re-laid-out the whole room, which was a canManage lever; the local mode
 *    fills only your own screen, which is as personal as mute — a plain
 *    member and a guest get it too;
 *  · `room.theater` is a LEGACY HINT, read and never written: a room that
 *    stored the old flag keeps the control offered whatever is playing, so
 *    nothing an old host set up goes dark — but it does not force anyone's
 *    layout (the latch itself starts off). The way OUT while the mode is on
 *    lives with the mode (the overlay's exit control, F, Esc) and is pinned
 *    in immersive-mode.test.tsx, where a click harness exists.
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

function renderLayout(
  room: Room,
  member: Member,
  mediaRef: MediaRef | null,
  over: { shareLive?: boolean } = {},
): string {
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
      ...(over.shareLive === true
        ? {
            restream: {
              active: true,
              hostUserId: member.userId,
              startedAt: 1,
              viewerCount: 0,
              uplinkQuality: null,
            },
          }
        : {}),
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
    // There is no picture to fill, so there is nothing to offer.
    const html = renderLayout(makeRoom('watch'), host, SC_REF);
    expect(html).not.toContain('Turn theater mode');
  });

  it('hides the theater control while nothing plays', () => {
    const html = renderLayout(makeRoom('watch'), host, null);
    expect(html).not.toContain('Turn theater mode');
  });

  it('offers theater while a screen share is live — a share is a moving picture too', () => {
    // The gate used to read the playing ITEM only, and a share is not an item:
    // the one layout a live share most wants was unreachable for its host.
    const html = renderLayout(makeRoom('watch'), host, null, { shareLive: true });
    expect(html).toContain('Turn theater mode on');
  });

  it('offers the control to plain members too — the mode is local now', () => {
    // The old flag re-laid-out the whole room and was rightly canManage-gated.
    // This one fills only the viewer's own screen: gating it by role would be
    // gating mute by role.
    const html = renderLayout(makeRoom('watch'), makeMember('member'), YT_REF);
    expect(html).toContain('Turn theater mode on');
  });

  it('offers it to guests as well', () => {
    const html = renderLayout(makeRoom('watch'), makeMember('guest'), YT_REF);
    expect(html).toContain('Turn theater mode on');
  });
});

describe('the stored room.theater flag is a legacy hint, not anyone’s layout', () => {
  const host = makeMember('host');

  it('keeps the control offered in a room that stored the flag, whatever is playing', () => {
    // The queue moves on its own: an old room that stored theater=true keeps
    // its control through a music item rather than going dark.
    const html = renderLayout(makeRoom('watch', { theater: true }), host, SC_REF);
    expect(html).toContain('Turn theater mode on');
  });

  it('and when nothing plays at all', () => {
    const html = renderLayout(makeRoom('watch', { theater: true }), host, null);
    expect(html).toContain('Turn theater mode on');
  });

  it('but never forces the layout: the room renders windowed until THIS viewer enters', () => {
    // "on", not "off": the stored flag no longer drives anyone's layout, so
    // the latch is off and the header still stands (an immersive render hides
    // it — see immersive-mode.test.tsx).
    const html = renderLayout(makeRoom('watch', { theater: true }), host, YT_REF);
    expect(html).not.toContain('Turn theater mode off');
    expect(html).toContain('aria-label="Your rooms"');
  });
});

describe('the room header carries no mode badge', () => {
  it.each(['watch', 'listen'] as const)('stored kind %s renders no Watch/Listen badge', (kind) => {
    const html = renderLayout(makeRoom(kind), makeMember('host'), YT_REF);
    expect(html).not.toContain('>Watch<');
    expect(html).not.toContain('>Listen<');
  });
});
