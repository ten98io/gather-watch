/**
 * Gather is free: everyone gets everything. Nothing a user can see may offer a
 * plan, a tier, an upgrade or a billing relationship, and nothing may be left
 * half-gated — a deleted check with live copy still promising a paid tier is
 * worse than either state alone.
 *
 * Same SSR harness as room-shell-theater.test.ts: `next/navigation` is mocked
 * because RoomMenu grabs a router, and the legal pages are plain server
 * components rendered straight to static markup.
 */
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MediaRef, Room } from '@gather/contracts';
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
const { default: TermsPage } = await import('@/app/legal/terms/page');
const { default: PrivacyPage } = await import('@/app/legal/privacy/page');

const YT_REF: MediaRef = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' };

/** Every word a paywall speaks with. */
const PAYWALL = /premium|upgrade|subscription|stripe|billing|billed|checkout|free plan|paid|plan\b/i;

function renderRoom(room: Room): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderInRoom(
    room,
    makeMember('host'),
    {
      playback: playbackFor(YT_REF, 0),
      queue: { items: [queueItem(YT_REF, 'Current item')], version: 1 },
    },
    h(QueryClientProvider, { client }, h(RoomLayout, { roomId: room.id })),
  );
}

describe('the room says nothing about plans', () => {
  it('renders no paywall vocabulary in the room shell', () => {
    expect(renderRoom(makeRoom('watch'))).not.toMatch(PAYWALL);
  });

  it('shows no expiry countdown, even for a room with a stored expiresAt', () => {
    // expiresAt is deprecated: nothing sets it, and the chip that counted it
    // down existed to say free rooms die and paid ones do not.
    const html = renderRoom(makeRoom('watch', { expiresAt: 2_000_000_000_000 }));
    expect(html).not.toMatch(/⏳/);
    expect(html).not.toMatch(PAYWALL);
  });
});

describe('the stage badge claims only what is measured', () => {
  // The static "Private · device-to-device" architectural claim is gone: the
  // stage now renders the call rail's LIVE path truth (CALL_PATH_LABEL over
  // the mesh's link stats — see StageLivePathBadge), and with nothing flowing
  // it says nothing at all. The live wording itself is pinned in
  // immersive-mode.test.tsx; what this SSR pass can and does pin is that no
  // stored room field puts an unmeasured claim on the stage.
  it('renders no static relay copy for a mesh room', () => {
    expect(renderRoom(makeRoom('watch'))).not.toContain('Private · device-to-device');
  });

  it('claims nothing for a legacy cf-sfu room either — nothing routes through a relay', () => {
    const html = renderRoom(makeRoom('watch', { relayMode: 'cf-sfu' }));
    expect(html).not.toContain('Private · device-to-device');
    expect(html).not.toContain('Relayed');
  });
});

describe('legal copy', () => {
  const terms = renderToStaticMarkup(h(TermsPage, {}));
  const privacy = renderToStaticMarkup(h(PrivacyPage, {}));

  it('the terms describe a free product with no billing relationship', () => {
    expect(terms).not.toMatch(PAYWALL);
    expect(terms).toContain('Gather is free');
  });

  it('the privacy policy keeps its promise that the room badge states the mode', () => {
    expect(privacy).not.toMatch(PAYWALL);
    expect(privacy).toContain('The room badge always says which mode you are in.');
  });

  it('the privacy policy no longer claims a relay terminates encryption', () => {
    expect(privacy).not.toMatch(/SFU|terminates encryption/i);
  });
});
