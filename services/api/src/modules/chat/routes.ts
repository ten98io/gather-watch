/**
 * Chat REST endpoints. Registered WITHOUT a prefix — the paths below are
 * full and must match @gather/api-client exactly. Realtime sends happen over
 * WS (see index.ts); these routes cover history, search, pins, unfurling,
 * GIF search, and attachment upload tickets.
 *
 * Routes and WS handlers share ONE ChatService per Deps (serviceFor) so the
 * typing/emote rate limiters and the notifier are single instances.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  CompleteUploadBody,
  CreateUploadBody,
  ListMessagesQuery,
  PinMessageBody,
  SearchGifsQuery,
  SearchMessagesQuery,
  UnfurlBody,
} from '@gather/contracts';
import type { MemberRole, RoomId, RoomPolicyLevel } from '@gather/contracts';
import { AppError } from '../../lib/errors';
import { requireAuth } from '../../plugins/auth';
import { parseWith } from '../../plugins/error-mapper';
import { memberDocId } from '../../adapters/ports';
import type { MemberDoc, RoomDoc } from '../../adapters/ports';
import type { AuthContext } from '../types';
import { completeAttachment, createAttachmentTicket, presignObjectUrl } from './attachments';
import { searchGifs } from './gifs';
import { createUnfurler } from './unfurl';
import { serviceFor } from './index';

/** Module-level unfurler: strict defaults, private addresses rejected. */
const unfurl = createUnfurler();

function roleSatisfies(level: RoomPolicyLevel, role: MemberRole): boolean {
  if (level === 'everyone') {
    return true;
  }
  if (level === 'mods') {
    return role === 'host' || role === 'moderator';
  }
  return role === 'host';
}

/**
 * Room-scope gate shared by every room route: authenticated, guest tokens
 * confined to their own room, and a live (non-banned) membership.
 */
async function requireRoomMember(
  app: FastifyInstance,
  request: FastifyRequest,
  roomId: RoomId,
): Promise<{ auth: AuthContext; room: RoomDoc; member: MemberDoc }> {
  const auth = requireAuth(request);
  if (auth.guestRoomId !== null && auth.guestRoomId !== roomId) {
    throw new AppError('FORBIDDEN', 'guest token is room-scoped');
  }
  const room = await app.deps.store.rooms.findById(roomId);
  if (room === null) {
    throw new AppError('NOT_FOUND', 'room not found');
  }
  const member = await app.deps.store.members.findById(memberDocId(roomId, auth.userId));
  if (member === null) {
    throw new AppError('FORBIDDEN', 'not a member');
  }
  if (member.banned) {
    throw new AppError('FORBIDDEN', 'banned');
  }
  return { auth, room, member };
}

export const chatRoutes: FastifyPluginAsync = async (app) => {
  const { config, log } = app.deps;

  app.get<{ Params: { roomId: string } }>('/rooms/:roomId/messages', async (request) => {
    const roomId = request.params.roomId as RoomId;
    await requireRoomMember(app, request, roomId);
    const query = parseWith(ListMessagesQuery, request.query);
    return serviceFor(app.deps).listMessages(roomId, query);
  });

  app.get<{ Params: { roomId: string } }>(
    '/rooms/:roomId/messages/search',
    async (request) => {
      const roomId = request.params.roomId as RoomId;
      await requireRoomMember(app, request, roomId);
      const query = parseWith(SearchMessagesQuery, request.query);
      return { items: await serviceFor(app.deps).search(roomId, query.q, query.limit) };
    },
  );

  app.post<{ Params: { roomId: string } }>(
    '/rooms/:roomId/messages/pin',
    async (request) => {
      const roomId = request.params.roomId as RoomId;
      const { auth } = await requireRoomMember(app, request, roomId);
      const body = parseWith(PinMessageBody, request.body);
      const message = await serviceFor(app.deps).pin(roomId, auth, body.messageId, body.pinned);
      return { message };
    },
  );

  app.get<{ Params: { roomId: string } }>('/rooms/:roomId/pins', async (request) => {
    const roomId = request.params.roomId as RoomId;
    await requireRoomMember(app, request, roomId);
    return { items: await serviceFor(app.deps).listPinned(roomId) };
  });

  app.post('/unfurl', async (request) => {
    requireAuth(request);
    const body = parseWith(UnfurlBody, request.body);
    return unfurl(body.url);
  });

  app.get('/gifs/search', async (request) => {
    requireAuth(request);
    const query = parseWith(SearchGifsQuery, request.query);
    const { results, notice } = await searchGifs({ config, log }, query.q, query.limit);
    // `notice` is an extra key over SearchGifsResponse — stripped client-side.
    return { results, ...(notice === null ? {} : { notice }) };
  });

  app.post<{ Params: { roomId: string } }>('/rooms/:roomId/attachments', async (request) => {
    const roomId = request.params.roomId as RoomId;
    const { auth, room, member } = await requireRoomMember(app, request, roomId);
    if (!roleSatisfies(room.policies.chat, member.role)) {
      throw new AppError('ROOM_POLICY', 'room policy does not allow you to chat');
    }
    const body = parseWith(CreateUploadBody, request.body);
    return createAttachmentTicket(app.deps, roomId, auth.userId, body);
  });

  /**
   * The stable URL chat messages store. Deliberately UNAUTHENTICATED: an
   * <img src> carries no bearer token, so the access model is the capability
   * URL itself — the asset id is unguessable, exactly how Discord/Slack
   * attachment links work. The bucket stays private; each view gets a fresh
   * 60-second presigned GET, so nothing that can rot or leak is ever stored.
   */
  app.get<{ Params: { assetId: string } }>('/assets/:assetId/content', async (request, reply) => {
    const doc = await app.deps.store.assets.findById(request.params.assetId);
    if (doc === null || doc.status !== 'ready' || doc.storageKey == null) {
      throw new AppError('NOT_FOUND', 'attachment not found');
    }
    // The asset's mime is the uploader's CLAIM, never verified against the
    // bytes. An 'image/*'-family claim renders inline in chat; anything else —
    // a text/html page above all — must not render in the reader's browser
    // off a gather.watch link, so the presign asks the bucket to answer with
    // Content-Disposition: attachment (signed into the URL; appending it
    // afterwards would break the signature).
    const inline = /^(image|audio|video)\//.test(doc.mime);
    const url = presignObjectUrl(
      app.deps.config.s3,
      doc.storageKey,
      'GET',
      60,
      new Date(),
      inline ? {} : { 'response-content-disposition': 'attachment' },
    );
    // no-store: the redirect target expires in 60s; a cached redirect is a
    // broken image later.
    void reply.header('cache-control', 'no-store');
    return reply.redirect(url, 302);
  });

  app.post<{ Params: { roomId: string } }>(
    '/rooms/:roomId/attachments/complete',
    async (request) => {
      const roomId = request.params.roomId as RoomId;
      const { auth } = await requireRoomMember(app, request, roomId);
      const body = parseWith(CompleteUploadBody, request.body);
      // `url` is an extra convenience key over CompleteUploadResponse.
      return completeAttachment(app.deps, auth.userId, body);
    },
  );
};
