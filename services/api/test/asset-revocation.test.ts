/**
 * A takedown has to actually take something down.
 *
 * `GET /assets/:assetId/content` is unauthenticated on purpose — the id is the
 * capability, the Discord/Slack model, and the bucket stays private. Nothing
 * revoked that capability. Deleting the room, erasing the account under GDPR
 * and tombstoning a reported message all left the AssetDoc exactly where it
 * was, so every link ever pasted kept resolving: a DMCA takedown removed a
 * message and served the file, an erasure said the data was gone and served
 * the file, and illegal content survived being reported.
 *
 * Each path below therefore asserts the same end state — the content route
 * 404s and the object is gone from the bucket — because that is the only
 * evidence that separates a takedown from a UI change.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MessageId, RoomId, UserId } from '@gather/contracts';
import type { AssetDoc, StorePort } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import { setAttachmentObjectOps } from '../src/modules/chat/attachments';
import { newId } from '../src/lib/tokens';
import { addMember, makeApp, seedRoom, signupUser, testConfig } from './helpers';
import type { SignedUpUser, TestApp } from './helpers';

const ADMIN_EMAIL = 'takedown-admin@example.com';

describe('revoking an asset capability URL', () => {
  let harness: TestApp;
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;
  /** Storage keys handed to the bucket's DELETE — proof the bytes went too. */
  let removed: string[];

  beforeEach(async () => {
    harness = await makeApp(testConfig({ adminEmails: [ADMIN_EMAIL] }));
    ({ app, store, deps } = harness);
    removed = [];
    setAttachmentObjectOps(deps, {
      stat: async () => ({ sizeBytes: 1024 }),
      remove: async (key: string) => {
        removed.push(key);
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function bearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  /** Ticket → complete, so the asset reaches 'ready' the way a client gets it. */
  async function uploadAsset(roomId: string, uploader: SignedUpUser): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/attachments`,
      headers: bearer(uploader.accessToken),
      payload: { filename: 'evidence.png', mime: 'image/png', sizeBytes: 1024 },
    });
    expect(created.statusCode).toBe(200);
    const { assetId, uploadId } = created.json() as { assetId: string; uploadId: string };
    const done = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/attachments/complete`,
      headers: bearer(uploader.accessToken),
      payload: { assetId, uploadId, parts: [{ partNumber: 1, etag: '"e"' }] },
    });
    expect(done.statusCode).toBe(200);
    return assetId;
  }

  /** The message that carries the attachment — the row a takedown tombstones. */
  async function seedMessageWith(
    roomId: string,
    authorId: UserId,
    assetId: string,
  ): Promise<MessageId> {
    const asset = await store.assets.findById(assetId);
    const id = newId() as MessageId;
    await store.messages.insertOne({
      id,
      roomId: roomId as RoomId,
      authorId,
      kind: 'text',
      body: 'look at this',
      gifUrl: null,
      attachment: {
        assetId: asset!.id,
        url: `${deps.config.apiUrl}/assets/${asset!.id}/content`,
        mime: asset!.mime,
        name: asset!.filename,
        sizeBytes: asset!.sizeBytes,
        width: null,
        height: null,
        durationMs: null,
      },
      replyTo: null,
      mentions: [],
      reactions: {},
      pinned: false,
      editedAt: null,
      deletedAt: null,
      seq: 1,
      createdAt: Date.now(),
    });
    return id;
  }

  async function contentStatus(assetId: string): Promise<number> {
    const res = await app.inject({ method: 'GET', url: `/assets/${assetId}/content` });
    return res.statusCode;
  }

  interface Scene {
    roomId: string;
    host: SignedUpUser;
    uploader: SignedUpUser;
    assetId: string;
    messageId: MessageId;
    storageKey: string;
  }

  /** A room, a host, an uploader, a ready asset, and the message naming it. */
  async function scene(prefix: string): Promise<Scene> {
    const { roomId, ownerId } = await seedRoom(store);
    const host = await signupUser(app, `${prefix}-host@example.com`);
    await store.rooms.updateOne({ id: roomId }, { ownerId: host.user.id });
    await addMember(store, roomId, host.user.id, 'host');
    await store.members.deleteOne({ id: `${roomId}:${ownerId}` });
    const uploader = await signupUser(app, `${prefix}-uploader@example.com`);
    await addMember(store, roomId, uploader.user.id, 'member');
    const assetId = await uploadAsset(roomId, uploader);
    const messageId = await seedMessageWith(roomId, uploader.user.id, assetId);
    const doc = (await store.assets.findById(assetId)) as AssetDoc;
    // The capability works before anything is taken down — otherwise every
    // assertion below would pass for the wrong reason.
    expect(await contentStatus(assetId)).toBe(302);
    return { roomId, host, uploader, assetId, messageId, storageKey: doc.storageKey! };
  }

  async function fileReport(
    reporter: SignedUpUser,
    target: Record<string, unknown>,
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/report',
      headers: bearer(reporter.accessToken),
      payload: { target, reason: 'this must come down' },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { reportId: string }).reportId;
  }

  async function adminToken(): Promise<string> {
    const admin = await signupUser(app, ADMIN_EMAIL);
    return admin.accessToken;
  }

  // ── 1. moderation ──────────────────────────────────────────────────────────

  it('a message takedown 404s the content route and clears the object', async () => {
    const it0 = await scene('msg');
    const reportId = await fileReport(it0.host, {
      kind: 'message',
      messageId: it0.messageId,
      roomId: it0.roomId,
    });

    const resolved = await app.inject({
      method: 'POST',
      url: '/admin/reports/resolve',
      headers: bearer(await adminToken()),
      payload: { reportId },
    });
    expect(resolved.statusCode).toBe(200);

    // The message is tombstoned AND the file it carried is unreachable. The
    // second half is the one that was missing: the link outlived the message.
    expect((await store.messages.findById(it0.messageId))?.deletedAt).not.toBeNull();
    expect(await contentStatus(it0.assetId)).toBe(404);
    expect(await store.assets.findById(it0.assetId)).toBeNull();
    expect(removed).toContain(it0.storageKey);
  });

  it('an asset takedown revokes the asset it names', async () => {
    const it0 = await scene('asset');
    const reportId = await fileReport(it0.host, { kind: 'asset', assetId: it0.assetId });
    const resolved = await app.inject({
      method: 'POST',
      url: '/admin/reports/resolve',
      headers: bearer(await adminToken()),
      payload: { reportId },
    });
    expect(resolved.statusCode).toBe(200);
    expect(await contentStatus(it0.assetId)).toBe(404);
  });

  it('a DISMISSED report leaves the file alone — dismissal means untouched', async () => {
    const it0 = await scene('dismiss');
    const reportId = await fileReport(it0.host, {
      kind: 'message',
      messageId: it0.messageId,
      roomId: it0.roomId,
    });
    const resolved = await app.inject({
      method: 'POST',
      url: '/admin/reports/resolve',
      headers: bearer(await adminToken()),
      payload: { reportId, dismiss: true },
    });
    expect(resolved.statusCode).toBe(200);
    expect(await contentStatus(it0.assetId)).toBe(302);
    expect(removed).toEqual([]);
  });

  // ── 2. room deletion ───────────────────────────────────────────────────────

  it('deleting a room revokes the attachments its messages carried', async () => {
    const it0 = await scene('room');
    const res = await app.inject({
      method: 'DELETE',
      url: `/rooms/${it0.roomId}`,
      headers: bearer(it0.host.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(await contentStatus(it0.assetId)).toBe(404);
    expect(removed).toContain(it0.storageKey);
  });

  it('a member who cannot delete the room cannot revoke its files either', async () => {
    const it0 = await scene('nonhost');
    const res = await app.inject({
      method: 'DELETE',
      url: `/rooms/${it0.roomId}`,
      headers: bearer(it0.uploader.accessToken),
    });
    expect(res.statusCode).toBe(403);
    // The read that collects the asset ids runs before the authz check, so
    // this is the assertion that keeps it a READ.
    expect(await contentStatus(it0.assetId)).toBe(302);
    expect(removed).toEqual([]);
  });

  // ── 3. GDPR erasure ────────────────────────────────────────────────────────

  it('erasing an account revokes the files it uploaded', async () => {
    const it0 = await scene('gdpr');
    const res = await app.inject({
      method: 'DELETE',
      url: '/me',
      headers: bearer(it0.uploader.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(await contentStatus(it0.assetId)).toBe(404);
    expect(removed).toContain(it0.storageKey);
  });

  // ── 4. no resurrection ─────────────────────────────────────────────────────

  it('a revoked asset cannot be brought back by replaying the upload completion', async () => {
    // A moderation takedown, so the uploader's account and session survive it
    // — the person whose file came down is exactly who would try this.
    const it0 = await scene('resurrect');
    const uploadId = (await store.assets.findById(it0.assetId))!.uploadId;
    const reportId = await fileReport(it0.host, {
      kind: 'message',
      messageId: it0.messageId,
      roomId: it0.roomId,
    });
    await app.inject({
      method: 'POST',
      url: '/admin/reports/resolve',
      headers: bearer(await adminToken()),
      payload: { reportId },
    });
    expect(await contentStatus(it0.assetId)).toBe(404);

    // completeAttachment re-STATs and re-marks ANY non-ready doc as ready, so
    // a merely FLAGGED asset would come back to life right here, at the hands
    // of the uploader, with the original uploadId. A deleted row cannot: this
    // is the reason revocation deletes rather than flags.
    const replay = await app.inject({
      method: 'POST',
      url: `/rooms/${it0.roomId}/attachments/complete`,
      headers: bearer(it0.uploader.accessToken),
      payload: { assetId: it0.assetId, uploadId, parts: [{ partNumber: 1, etag: '"e"' }] },
    });
    expect(replay.statusCode).toBe(404);
    expect(await contentStatus(it0.assetId)).toBe(404);
  });
});
