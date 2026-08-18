/**
 * The room queue is embedded on the room document and rewritten in full on
 * every mutation — so an unbounded queue is not "a long playlist", it is a
 * room walking itself into Mongo's 16 MB document limit while every mutation
 * gets more expensive for everyone in it. Both halves of the bound are pinned
 * here, because either alone bounds nothing:
 *
 *   • the item COUNT (QUEUE_MAX_ITEMS), and
 *   • the SIZE of a single item's mediaRef — `z.string().url()` has no length
 *     ceiling, so one add could otherwise carry a megabyte.
 *
 * Both are physics, not policy: the same numbers for every room and every
 * account, derived from the storage engine's limit. There is no tier to lift
 * them and nothing looks up who is asking.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { QueueItemId, QueueItemInput, RoomId, UserId } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import {
  QUEUE_MAX_ITEMS,
  QUEUE_MEDIA_REF_MAX_CHARS,
  QueueService,
} from '../src/modules/queue/service';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';

function pageItem(n: number): QueueItemInput {
  return {
    mediaRef: { kind: 'page', url: `https://example.com/watch/${n}` },
    title: `item ${n}`,
    durationMs: null,
    artworkUrl: null,
  };
}

describe('the room queue is bounded', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;
  let queue: QueueService;
  let roomId: RoomId;
  let ownerId: UserId;

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp());
    queue = new QueueService(deps);
    ({ roomId, ownerId } = await seedRoom(store));
  });

  afterEach(async () => {
    await app.close();
  });

  /** Fill straight through the store — 500 real adds is 500 broadcasts. */
  async function fillTo(count: number): Promise<void> {
    const room = await store.rooms.findById(roomId);
    const items = Array.from({ length: count }, (_, n) => ({
      id: `item-${n}` as QueueItemId,
      mediaRef: { kind: 'page' as const, url: `https://example.com/watch/${n}` },
      title: `item ${n}`,
      durationMs: null,
      artworkUrl: null,
      addedBy: ownerId,
      votesToSkip: [],
    }));
    await store.rooms.updateOne(
      { id: roomId },
      { queue: { items, version: room!.queue.version + 1 } },
    );
  }

  it('accepts the last item under the cap and refuses the one past it', async () => {
    await fillTo(QUEUE_MAX_ITEMS - 1);
    await queue.add(roomId, ownerId, pageItem(9998));
    expect((await store.rooms.findById(roomId))!.queue.items).toHaveLength(QUEUE_MAX_ITEMS);

    await expect(queue.add(roomId, ownerId, pageItem(9999))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    // Refused means refused: nothing stored, no version bump.
    const room = await store.rooms.findById(roomId);
    expect(room!.queue.items).toHaveLength(QUEUE_MAX_ITEMS);
  });

  it('applies the same cap to everyone — the room host included', async () => {
    // There is no tier and no lookup: the host who owns the room hits the
    // identical wall as a member who just joined.
    await fillTo(QUEUE_MAX_ITEMS);
    const member = await signupUser(app, 'member@example.com');
    await addMember(store, roomId, member.user.id, 'member');

    await expect(queue.add(roomId, ownerId, pageItem(1))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    await expect(queue.add(roomId, member.user.id, pageItem(2))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('refuses a mediaRef too long to belong on a room document', async () => {
    const tail = 'a'.repeat(QUEUE_MEDIA_REF_MAX_CHARS);
    await expect(
      queue.add(roomId, ownerId, {
        mediaRef: { kind: 'page', url: `https://example.com/${tail}` },
        title: 'huge',
        durationMs: null,
        artworkUrl: null,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await store.rooms.findById(roomId))!.queue.items).toEqual([]);
  });

  it('bounds every mediaRef kind, not just the url-shaped ones', async () => {
    // `embed` hides an unbounded `title` inside the ref; the size check is on
    // the serialized ref, so it is covered without naming the kind.
    await expect(
      queue.add(roomId, ownerId, {
        mediaRef: {
          kind: 'embed',
          provider: 'spotify',
          embedUrl: 'https://open.spotify.com/embed/track/x',
          title: 'b'.repeat(QUEUE_MEDIA_REF_MAX_CHARS),
        },
        title: 'sneaky',
        durationMs: null,
        artworkUrl: null,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('leaves an ordinary add completely alone', async () => {
    await queue.add(roomId, ownerId, pageItem(1));
    await queue.settleEnrichment();
    const room = await store.rooms.findById(roomId);
    expect(room!.queue.items).toHaveLength(1);
    expect(room!.queue.items[0]?.title).toBe('item 1');
  });
});
