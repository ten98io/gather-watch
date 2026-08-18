/**
 * A `page` item on a browser with no extension.
 *
 * The contract already spells out the requirement (contracts entities.ts, the
 * `page` MediaRef: "A viewer without the extension sees the item and the link,
 * and nothing plays for them — which is what the UI must say"). The stage said
 * nothing at all: `adapterKindFor` correctly returns null for a page, the
 * empty-stage message is reserved for `mediaRef === null`, and the shield only
 * mounts over a real provider surface — so the composition fell through every
 * branch and rendered a completely blank rectangle, directly contradicting the
 * queue's own "Paste any link" promise from the moment the link was pasted.
 */
import { describe, expect, it } from 'vitest';
import type { MediaRef } from '@gather/contracts';
import {
  h,
  makeMember,
  makeRoom,
  playbackFor,
  queueItem,
  renderInRoom,
} from './helpers/room-render';

const { StagePane } = await import('@/components/stage/StagePane');

const PAGE: MediaRef = { kind: 'page', url: 'https://films.example/the-quiet-hour' };
const YT: MediaRef = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' };

function renderPage(mediaRef: MediaRef): string {
  const room = makeRoom('watch');
  const items = [queueItem(mediaRef, 'The Quiet Hour')];
  return renderInRoom(
    room,
    makeMember('member'),
    { playback: playbackFor(mediaRef, 0), queue: { items, version: 1 } },
    h(StagePane, { roomId: room.id }),
  );
}

describe('the stage explains a page item it cannot play', () => {
  it('says what it is and why it is not playing here', () => {
    const html = renderPage(PAGE);
    expect(html).toContain('This one is a link to a page');
    expect(html).toContain('the Gather extension is what plays those');
  });

  it('names the item, so the stage is about this link and not links in general', () => {
    expect(renderPage(PAGE)).toContain('The Quiet Hour');
  });

  it('offers the way out that always exists: open the link yourself', () => {
    const html = renderPage(PAGE);
    expect(html).toContain('Open the link');
    expect(html).toContain('href="https://films.example/the-quiet-hour"');
    // Somewhere else, and in a new tab — losing the room to follow a link out
    // of it is the mistake this whole surface exists to avoid.
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('does not claim the room is broken, and does not pretend to be a player', () => {
    const html = renderPage(PAGE);
    // Not the empty room (something IS queued), not the cueing wait (nothing is
    // arriving), and no play affordance over a surface there is no player for.
    expect(html).not.toContain('Nothing playing yet');
    expect(html).not.toContain('Starting…');
    expect(html).not.toContain('Press play — everyone starts together');
    expect(html).not.toContain('Waiting for the host to press play');
  });

  it('leaves every other kind of item exactly as it was', () => {
    const html = renderPage(YT);
    expect(html).not.toContain('This one is a link to a page');
    expect(html).toContain('Shared video');
  });
});
