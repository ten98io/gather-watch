/**
 * The stage adapts to what is PLAYING, not to the room's stored (deprecated)
 * `kind` field: one room shows the listen composition for a music item and
 * the video stage for a video item. Every case runs under BOTH stored kinds
 * to prove the field drives nothing.
 *
 * Markers, chosen from markup only one composition emits:
 *   listen composition → the "Up next" track list (ListenStage)
 *   video stage        → the aria-label "Shared video" element
 */
import { describe, expect, it } from 'vitest';
import type { MediaRef, QueueItem, Room } from '@gather/contracts';
import {
  h,
  makeMember,
  makeRoom,
  playbackFor,
  queueItem,
  renderInRoom,
} from './helpers/room-render';

const { StagePane } = await import('@/components/stage/StagePane');

const SC_REF: MediaRef = { kind: 'soundcloud', url: 'https://soundcloud.com/artist/neon-rain' };
const YT_REF: MediaRef = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' };

const MEMBER = makeMember('host');

function renderStage(
  room: Room,
  mediaRef: MediaRef | null,
  items: QueueItem[],
  queueIndex: number | null,
): string {
  return renderInRoom(
    room,
    MEMBER,
    {
      playback: mediaRef === null ? null : playbackFor(mediaRef, queueIndex),
      queue: { items, version: 1 },
    },
    h(StagePane, { roomId: room.id }),
  );
}

const KINDS: ReadonlyArray<Room['kind']> = ['watch', 'listen'];

describe('StagePane adapts to the playing item', () => {
  it.each(KINDS)('routes a music item to the listen composition (stored kind %s)', (kind) => {
    const items = [queueItem(SC_REF, 'Neon Rain'), queueItem(YT_REF, 'Orbit Documentary')];
    const html = renderStage(makeRoom(kind), SC_REF, items, 0);
    expect(html).toContain('Neon Rain');
    expect(html).toContain('Up next');
    expect(html).not.toContain('Shared video');
  });

  it.each(KINDS)('routes a video item to the video stage (stored kind %s)', (kind) => {
    const items = [queueItem(YT_REF, 'Orbit Documentary'), queueItem(SC_REF, 'Neon Rain')];
    const html = renderStage(makeRoom(kind), YT_REF, items, 0);
    expect(html).toContain('Shared video');
    expect(html).not.toContain('Up next');
  });

  it('flows between compositions inside the SAME room as the item changes', () => {
    const room = makeRoom('watch');
    const items = [queueItem(SC_REF, 'Neon Rain'), queueItem(YT_REF, 'Orbit Documentary')];
    const music = renderStage(room, SC_REF, items, 0);
    const video = renderStage(room, YT_REF, items, 1);
    expect(music).toContain('Up next');
    expect(music).not.toContain('Shared video');
    expect(video).toContain('Shared video');
    expect(video).not.toContain('Up next');
  });

  it.each(KINDS)('shows one neutral empty stage when nothing plays (stored kind %s)', (kind) => {
    const html = renderStage(makeRoom(kind), null, [], null);
    // Copy updated 2026-08-19 from "Nothing playing yet": at the display step
    // that line was a 44px apology on the first screen of every room. The
    // assertion is unchanged in kind — one empty stage, neutral about mode.
    expect(html).toContain('The room is ready');
    // The old listen-room copy promised a mode before anything played.
    expect(html).not.toContain('Queue something to listen to');
    expect(html).not.toContain('listen');
  });
});
