/**
 * A chat attachment used to be stored exactly as the client sent it: no asset
 * lookup, no ownership check, no constraint on `url`. Two concrete abuses fell
 * out of that.
 *
 * 1. The asset id IS the capability (an unguessable id behind an
 *    unauthenticated content route). Attaching somebody else's asset id to a
 *    message re-publishes their private upload to every member of a room they
 *    were never in.
 * 2. `url` was rendered by every reader of the room, so a message could point
 *    the whole room at an arbitrary origin under an innocent filename.
 *
 * The rule pinned here: the stored ASSET is the authority for everything the
 * server can know — owner, mime, filename, size and the single legal url —
 * and only the intrinsics nothing server-side measures (dimensions, duration)
 * come from the client.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AssetId, MessageAttachment, RoomId, UserId } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import type { AuthContext, Deps } from '../src/modules/types';
import { ChatService } from '../src/modules/chat/service';
import { setAttachmentObjectOps } from '../src/modules/chat/attachments';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';

function authOf(userId: UserId): AuthContext {
  return { userId, sessionId: 'sess_test', guest: false, guestRoomId: null };
}

function attachmentOf(overrides: Partial<MessageAttachment>): MessageAttachment {
  return {
    assetId: 'asset-x' as AssetId,
    url: 'https://attacker.example.com/tracker.png',
    mime: 'image/png',
    name: 'holiday.png',
    sizeBytes: 1,
    width: null,
    height: null,
    durationMs: null,
    ...overrides,
  };
}

describe('chat attachments are checked against the stored asset', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;
  let chat: ChatService;

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp());
    chat = new ChatService(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  /** A ready asset owned by `ownerId`, created through the real upload flow. */
  async function uploadedAsset(
    roomId: RoomId,
    token: string,
    filename = 'private.pdf',
  ): Promise<{ assetId: AssetId; url: string }> {
    const created = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/attachments`,
      headers: { authorization: `Bearer ${token}` },
      payload: { filename, mime: 'application/pdf', sizeBytes: 2048 },
    });
    expect(created.statusCode).toBe(200);
    const ticket = created.json() as { assetId: string; uploadId: string };
    setAttachmentObjectOps(deps, {
      stat: async () => ({ sizeBytes: 2048 }),
      remove: async () => undefined,
    });
    const done = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/attachments/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assetId: ticket.assetId, uploadId: ticket.uploadId, parts: [] },
    });
    expect(done.statusCode).toBe(200);
    const body = done.json() as { url: string };
    return { assetId: ticket.assetId as AssetId, url: body.url };
  }

  function send(roomId: RoomId, userId: UserId, attachment: MessageAttachment) {
    return chat.send(roomId, authOf(userId), {
      kind: 'attachment',
      body: '',
      gifUrl: null,
      attachment,
      replyTo: null,
      mentions: [],
    });
  }

  it('refuses an asset the sender does not own', async () => {
    const { roomId } = await seedRoom(store);
    const victim = await signupUser(app, 'victim@example.com');
    const attacker = await signupUser(app, 'attacker@example.com');
    await addMember(store, roomId, victim.user.id, 'member');
    await addMember(store, roomId, attacker.user.id, 'member');
    const asset = await uploadedAsset(roomId, victim.accessToken);

    await expect(
      send(roomId, attacker.user.id, attachmentOf({ assetId: asset.assetId, url: asset.url })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await store.messages.findMany({ roomId })).toEqual([]);
  });

  it('refuses an asset id that names nothing', async () => {
    const { roomId, ownerId } = await seedRoom(store);
    await expect(
      send(roomId, ownerId, attachmentOf({ assetId: 'no-such-asset' as AssetId })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an asset whose upload never completed', async () => {
    const { roomId } = await seedRoom(store);
    const sender = await signupUser(app, 'half@example.com');
    await addMember(store, roomId, sender.user.id, 'member');
    const created = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/attachments`,
      headers: { authorization: `Bearer ${sender.accessToken}` },
      payload: { filename: 'wip.bin', mime: 'application/octet-stream', sizeBytes: 10 },
    });
    const ticket = created.json() as { assetId: string };

    await expect(
      send(roomId, sender.user.id, attachmentOf({ assetId: ticket.assetId as AssetId })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('stores the asset truth, not the claim — url, mime, name and size', async () => {
    const { roomId } = await seedRoom(store);
    const sender = await signupUser(app, 'sender@example.com');
    await addMember(store, roomId, sender.user.id, 'member');
    const asset = await uploadedAsset(roomId, sender.accessToken, 'quarterly.pdf');

    const message = await send(
      roomId,
      sender.user.id,
      attachmentOf({
        assetId: asset.assetId,
        url: 'https://attacker.example.com/tracker.png',
        mime: 'image/png',
        name: 'cat.png',
        sizeBytes: 1,
        width: 640,
        height: 480,
      }),
    );

    expect(message.attachment).toEqual({
      assetId: asset.assetId,
      url: asset.url,
      mime: 'application/pdf',
      name: 'quarterly.pdf',
      sizeBytes: 2048,
      // Dimensions have no server-side truth, so the client's stand.
      width: 640,
      height: 480,
      durationMs: null,
    });
    expect(message.attachment?.url).toBe(`${deps.config.apiUrl}/assets/${asset.assetId}/content`);
    expect(message.attachment?.url.startsWith('https://attacker.example.com')).toBe(false);
  });

  it('does not burn a message seq on a refused attachment', async () => {
    const { roomId, ownerId } = await seedRoom(store);
    await expect(
      send(roomId, ownerId, attachmentOf({ assetId: 'nope' as AssetId })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const ok = await chat.send(roomId, authOf(ownerId), {
      kind: 'text',
      body: 'first real message',
      gifUrl: null,
      attachment: null,
      replyTo: null,
      mentions: [],
    });
    expect(ok.seq).toBe(1);
  });

  it('leaves a plain text message alone', async () => {
    const { roomId, ownerId } = await seedRoom(store);
    const message = await chat.send(roomId, authOf(ownerId), {
      kind: 'text',
      body: 'no attachment here',
      gifUrl: null,
      attachment: null,
      replyTo: null,
      mentions: [],
    });
    expect(message.attachment).toBeNull();
  });
});
