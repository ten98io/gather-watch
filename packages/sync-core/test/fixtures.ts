import type { PlaybackState, QueueItem, QueueItemId, UserId } from '@gather/contracts';

/** Cast a plain string to the branded UserId (tests only — no runtime validation). */
export const uid = (s: string): UserId => s as UserId;

/** Cast a plain string to the branded QueueItemId (tests only). */
export const qid = (s: string): QueueItemId => s as QueueItemId;

/** Queue item with mediaRef {kind:'url', url:'https://example.com/a.mp3', mime:'audio/mpeg'},
 *  null durationMs/artworkUrl, empty votesToSkip; overridable via a partial. */
export function makeItem(id: string, overrides?: Partial<QueueItem>): QueueItem {
  const base: QueueItem = {
    id: qid(id),
    mediaRef: { kind: 'url', url: 'https://example.com/a.mp3', mime: 'audio/mpeg' },
    title: `Track ${id}`,
    durationMs: null,
    artworkUrl: null,
    addedBy: uid('user-owner'),
    votesToSkip: [],
  };
  return { ...base, ...overrides };
}

/** PlaybackState with mediaRef null, positionMs 0, rate 1, playing true, serverTs 0,
 *  seq 1, queueIndex null; overridable via a partial. */
export function makeState(overrides?: Partial<PlaybackState>): PlaybackState {
  const base: PlaybackState = {
    mediaRef: null,
    positionMs: 0,
    rate: 1,
    playing: true,
    serverTs: 0,
    seq: 1,
    queueIndex: null,
  };
  return { ...base, ...overrides };
}
