/**
 * INSERT-TIME RESOLUTION, END TO END: a queue add resolves its metadata
 * server-side, and the resolved `durationMs` is not just decoration — it is
 * the FILL the fill-once duration doctrine speaks of, and it changes what the
 * advance guard can do about a skip.
 *
 * What these pin, over the real store (MemoryStore via makeApp) with a
 * registered fake resolver — the same seam the metadata module's own tests
 * use, so no socket is ever opened:
 *
 *   • an added row comes out of enrichment carrying the resolver's title and
 *     duration (the wiring FEATURE_PLAN 0.6 asked for);
 *   • a later `sync.duration` report writes NOTHING over a resolved duration
 *     — the fill happened at insert, and `reportDuration` refuses to edit a
 *     row whose duration is known (any member could otherwise re-price the
 *     advance guard on a whim);
 *   • the guard VERIFIES rather than PRICES: twenty-one seconds into a
 *     ten-minute film is past ADVANCE_UNKNOWN_DURATION_FLOOR_MS, so on an
 *     unresolved row it would buy the skip — on the resolved row it is
 *     refused, and the same call at the film's true end is taken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  PlaybackState,
  QueueItem,
  ResolvedMedia,
  RoomId,
  UserId,
} from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import { registerMetadataResolver } from '../src/modules/metadata/resolver';
import { QueueService } from '../src/modules/queue/service';
import { ADVANCE_UNKNOWN_DURATION_FLOOR_MS, SyncService } from '../src/modules/sync/service';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';

/** A ten-minute film — long enough that "twenty seconds in" and "at the end"
 *  cannot be confused under any tolerance. */
const FILM_MS = 10 * 60 * 1000;

/** Past the unknown-duration floor: enough to advance an UNRESOLVED row. */
const PAST_THE_FLOOR_MS = ADVANCE_UNKNOWN_DURATION_FLOOR_MS + 1000;

const YT_REF = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } as const;

function resolvedMedia(): ResolvedMedia {
  return {
    title: 'Rick Astley - Never Gonna Give You Up',
    artworkUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    durationMs: FILM_MS,
    providerId: 'youtube',
    providerName: 'YouTube',
    authorName: 'Rick Astley',
    canonicalId: 'dQw4w9WgXcQ',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    source: 'provider',
  };
}

describe('queue insert resolution feeds the advance guard', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;
  let roomId: RoomId;
  let queue: QueueService;
  let sync: SyncService;

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp());
    // seedRoom's playbackControl is 'host': the members added below are
    // exactly the people the advance guard applies to. queueControl is
    // 'everyone', so the same members may add.
    ({ roomId } = await seedRoom(store));
    queue = new QueueService(deps);
    sync = new SyncService(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  /** A plain member — no seat, no policy. */
  async function member(email: string): Promise<UserId> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, 'member');
    return account.user.id;
  }

  /** Add through the SERVICE (the wired path) and let enrichment settle. */
  async function addResolved(userId: UserId, title = 'YouTube video'): Promise<QueueItem> {
    registerMetadataResolver(deps, { resolve: async () => resolvedMedia() });
    await queue.add(roomId, userId, {
      mediaRef: YT_REF,
      title,
      durationMs: null,
      artworkUrl: null,
    });
    await queue.settleEnrichment();
    const room = await store.rooms.findById(roomId);
    const row = room!.queue.items[room!.queue.items.length - 1];
    expect(row).toBeDefined();
    return row!;
  }

  /** Put the room on a queue row, playing, `positionMs` into it. */
  async function playAt(index: number, positionMs: number): Promise<void> {
    const room = await store.rooms.findById(roomId);
    const playback: PlaybackState = {
      mediaRef: room!.queue.items[index]!.mediaRef,
      positionMs,
      rate: 1,
      playing: true,
      serverTs: Date.now(),
      seq: await store.nextSeq(`playback:${roomId}`),
      queueIndex: index,
    };
    await store.rooms.updateOne({ id: roomId }, { playback });
  }

  /** Move the room's own clock without touching what the guard reads. */
  async function runOnTo(positionMs: number): Promise<void> {
    const playback = (await store.rooms.findById(roomId))!.playback!;
    await store.rooms.updateOne(
      { id: roomId },
      { playback: { ...playback, positionMs, serverTs: Date.now() } },
    );
  }

  const rowsOf = async (): Promise<QueueItem[]> =>
    (await store.rooms.findById(roomId))!.queue.items;

  const indexOf = async (): Promise<number | null> =>
    (await store.rooms.findById(roomId))!.playback!.queueIndex;

  it('an added row comes out of enrichment with the resolved title and duration', async () => {
    const adder = await member('adder@example.com');
    const row = await addResolved(adder);

    expect(row.title).toBe('Rick Astley - Never Gonna Give You Up');
    expect(row.durationMs).toBe(FILM_MS);
    expect(row.artworkUrl).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  });

  it('discards the adder-sent duration at the door — the guard is not theirs to price', async () => {
    const adder = await member('adder@example.com');
    const reporter = await member('reporter@example.com');
    // A resolver with NO duration (YouTube's oEmbed carries none): if the
    // client hint survived the insert, 30s would stand on a ten-minute film,
    // reportDuration would refuse every honest correction (fill-once), and
    // the adder could advance the room at a price they chose.
    registerMetadataResolver(deps, {
      resolve: async () => ({ ...resolvedMedia(), durationMs: null }),
    });
    await queue.add(roomId, adder, {
      mediaRef: YT_REF,
      title: 'YouTube video',
      durationMs: 30_000,
      artworkUrl: null,
    });
    await queue.settleEnrichment();

    let row = (await rowsOf())[0]!;
    expect(row.durationMs).toBeNull();

    // The honest fill still works — the FIRST player report lands.
    await sync.reportDuration(roomId, reporter, row.id, FILM_MS);
    row = (await rowsOf())[0]!;
    expect(row.durationMs).toBe(FILM_MS);
  });

  it('budgets enrichment per user: over the window cap, inserts land unresolved', async () => {
    const adder = await member('adder@example.com');
    let lookups = 0;
    registerMetadataResolver(deps, {
      resolve: async () => {
        lookups += 1;
        return resolvedMedia();
      },
    });
    // One more than the per-window budget, same user, one burst — the WS door
    // must not out-fetch the REST tier on the identical operation.
    for (let i = 0; i < 21; i += 1) {
      await queue.add(roomId, adder, {
        mediaRef: { kind: 'page', url: `https://example.com/talk/${String(i)}` },
        title: 'example.com',
        durationMs: null,
        artworkUrl: null,
      });
      await queue.settleEnrichment();
      // The queue has its own ceiling; keep it one row deep so every add lands.
      const room = await store.rooms.findById(roomId);
      await queue.remove(roomId, adder, room!.queue.items[room!.queue.items.length - 1]!.id);
    }
    expect(lookups).toBe(20);
  });

  it('a later sync.duration report does not clobber the resolved duration', async () => {
    const adder = await member('adder@example.com');
    const reporter = await member('reporter@example.com');
    const row = await addResolved(adder);
    expect(row.durationMs).toBe(FILM_MS);

    // A different number for the resolved row — a player mis-measuring, or a
    // member reaching for the guard's lever. The fill already happened.
    await sync.reportDuration(roomId, reporter, row.id, 5000);

    expect((await rowsOf())[0]!.durationMs).toBe(FILM_MS);
  });

  it('the guard VERIFIES a resolved row: past the unknown floor is refused, the true end is taken', async () => {
    const adder = await member('adder@example.com');
    const guest = await member('guest@example.com');
    const row = await addResolved(adder);
    // Two rows so a taken advance has somewhere to go.
    await addResolved(adder);
    await playAt(0, PAST_THE_FLOOR_MS);

    // Twenty-one seconds into ten minutes: on a duration-null row this exact
    // call advances (the guard can only PRICE it); on the resolved row the
    // ending is verifiably not here, so the room does not move.
    await sync.advance(roomId, guest, row.id);
    expect(await indexOf()).toBe(0);

    // At the real end of the resolved duration the same call is taken.
    await runOnTo(FILM_MS - 1000);
    await sync.advance(roomId, guest, row.id);
    expect(await indexOf()).toBe(1);
  });
});
