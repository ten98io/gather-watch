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
 *
 * It is also COMMON now rather than rare: protected rows (Netflix, Disney+)
 * became queueable, so this is what every viewer without the extension sees for
 * one. The three things it has to settle are asserted below — what the item is,
 * that each person plays their own copy from their own account, and how to get
 * the extension when there is honestly somewhere to send them.
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
    expect(html).toContain('This is a link to a page, not a file the room can hand you');
    expect(html).toContain('The Gather extension plays it');
  });

  /**
   * The sentence that actually settles a Netflix row. Without it the reader's
   * next question is "so whose copy am I watching, and do I need an account" —
   * and the answer is the one thing a viewer has to know before they bother
   * installing anything.
   */
  it('says everyone plays their own copy from their own account', () => {
    const html = renderPage(PAGE);
    expect(html).toContain('everyone plays their own copy');
    expect(html).toContain('from their own account');
    expect(html).toContain('same second');
  });

  it('names the item, so the stage is about this link and not links in general', () => {
    expect(renderPage(PAGE)).toContain('The Quiet Hour');
  });

  it('gives the item the display step — it owns the whole stage', () => {
    // A poster state is reachable only when every other state is impossible,
    // which is what lets it spend the one display setting a screen gets (§3).
    expect(renderPage(PAGE)).toContain('text-display');
  });

  it('offers the way out that always exists: open the link yourself', () => {
    const html = renderPage(PAGE);
    expect(html).toContain('Open the link');
    expect(html).toContain('href="https://films.example/the-quiet-hour"');
    // Somewhere else, and in a new tab — losing the room to follow a link out
    // of it is the mistake this whole surface exists to avoid.
    expect(html).toContain('rel="noopener noreferrer"');
  });

  /**
   * `extensionInstallUrl()` returns null when this build has no store listing,
   * and the detecting phase (which is what a server render is) has none either.
   * An "Add the extension" button that goes nowhere is worse than no button, so
   * the offer is withheld — and the action that DOES exist inherits the
   * region's one gradient rather than leaving the surface with no primary.
   */
  it('does not offer an install it cannot honour, and promotes the action that works', () => {
    const html = renderPage(PAGE);
    expect(html).not.toContain('Add the extension');
    expect(html).toContain('aurora-gradient');
    // One gradient in the region (§2). The install link and this one are the
    // only two candidates, and exactly one of them is ever rendered.
    expect(html.match(/aurora-gradient/g)).toHaveLength(1);
  });

  it('does not claim the room is broken, and does not pretend to be a player', () => {
    const html = renderPage(PAGE);
    // Not the empty room (something IS queued), not the cueing wait (nothing is
    // arriving), and no play affordance over a surface there is no player for.
    expect(html).not.toContain('The room is ready');
    expect(html).not.toContain('Starting…');
    expect(html).not.toContain('Press play — everyone starts together');
    expect(html).not.toContain('Waiting for the host to press play');
  });

  it('leaves every other kind of item exactly as it was', () => {
    const html = renderPage(YT);
    expect(html).not.toContain('This is a link to a page');
    expect(html).toContain('Shared video');
  });
});
