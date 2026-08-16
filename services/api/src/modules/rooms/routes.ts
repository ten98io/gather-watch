/**
 * Rooms REST endpoints. Registered WITHOUT a prefix — the paths below are full
 * and must match @gather/api-client exactly. Guests hold room-scoped tokens:
 * every room-scoped route runs assertGuestScope so a guest token can only act
 * on the one room it was issued for.
 */
import type { FastifyPluginAsync } from 'fastify';
import {
  BanMemberBody,
  CreateInviteBody,
  CreateRoomBody,
  JoinRoomBody,
  KickMemberBody,
  SetMemberRoleBody,
  SetRoomMuteBody,
  SetTheaterBody,
  TransferHostBody,
  UpdatePoliciesBody,
  UpdateRoomBody,
} from '@gather/contracts';
import { AppError } from '../../lib/errors';
import { requireAccount, requireAuth } from '../../plugins/auth';
import { parseWith } from '../../plugins/error-mapper';
import type { AuthContext } from '../types';
import { RoomsService, startRoomExpirySweeper } from './service';
import { getRoomsRuntime } from './runtime';
import { serializeMember, serializeRoom } from './serialize';

type RoomParams = { Params: { roomId: string } };

/** Guests are room-scoped: reject when the token's room is not this room. */
function assertGuestScope(auth: AuthContext, roomId: string): void {
  if (auth.guestRoomId !== null && auth.guestRoomId !== roomId) {
    throw new AppError('FORBIDDEN', 'guest access is room-scoped');
  }
}

export const roomsRoutes: FastifyPluginAsync = async (app) => {
  const service = new RoomsService(app.deps);
  const runtime = getRoomsRuntime(app.deps);
  const stopExpirySweeper = startRoomExpirySweeper(app.deps);
  app.addHook('onClose', async () => {
    stopExpirySweeper();
    await runtime.close();
  });

  app.post('/rooms', async (request) => {
    const auth = requireAccount(request);
    const body = parseWith(CreateRoomBody, request.body);
    const { room } = await service.createRoom(auth.userId, body.name, body.kind);
    return { room: serializeRoom(room) };
  });

  app.get('/rooms', async (request) => {
    const auth = requireAuth(request);
    const rooms = await service.listMyRooms(auth.userId);
    return {
      rooms: rooms.map(({ room, unreadCount, memberCount, muted }) => ({
        room: serializeRoom(room),
        unreadCount,
        memberCount,
        muted,
      })),
    };
  });

  app.get<RoomParams>('/rooms/:roomId', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    const { room, member, lastEventSeq } = await service.getRoom(
      request.params.roomId,
      auth.userId,
    );
    return { room: serializeRoom(room), member: serializeMember(member), lastEventSeq };
  });

  app.post('/rooms/join', async (request) => {
    const auth = requireAccount(request);
    const body = parseWith(JoinRoomBody, request.body);
    const { room, member, lastEventSeq } = await service.joinByInvite(
      auth.userId,
      body.inviteCode,
    );
    return { room: serializeRoom(room), member: serializeMember(member), lastEventSeq };
  });

  app.post<RoomParams>('/rooms/:roomId/leave', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    await service.leaveRoom(request.params.roomId, auth.userId);
    return { ok: true as const };
  });

  app.get<RoomParams>('/rooms/:roomId/members', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    const members = await service.listMembers(request.params.roomId, auth.userId);
    return {
      members: members.map(({ member, user }) => ({ member: serializeMember(member), user })),
    };
  });

  app.patch<RoomParams>('/rooms/:roomId/policies', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    const body = parseWith(UpdatePoliciesBody, request.body);
    const room = await service.updatePolicies(request.params.roomId, auth.userId, body);
    return { room: serializeRoom(room) };
  });

  app.post<RoomParams>('/rooms/:roomId/transfer-host', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    const body = parseWith(TransferHostBody, request.body);
    await service.transferHost(request.params.roomId, auth.userId, body.toUserId);
    return { ok: true as const };
  });

  app.post<RoomParams>('/rooms/:roomId/members/role', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    const body = parseWith(SetMemberRoleBody, request.body);
    const member = await service.setMemberRole(
      request.params.roomId,
      auth.userId,
      body.userId,
      body.role,
    );
    return { member: serializeMember(member) };
  });

  app.post<RoomParams>('/rooms/:roomId/kick', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    const body = parseWith(KickMemberBody, request.body);
    await service.kickMember(request.params.roomId, auth.userId, body.userId);
    return { ok: true as const };
  });

  app.post<RoomParams>('/rooms/:roomId/ban', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    const body = parseWith(BanMemberBody, request.body);
    await service.banMember(request.params.roomId, auth.userId, body.userId, body.banned);
    return { ok: true as const };
  });

  app.post<RoomParams>('/rooms/:roomId/invites', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    const body = parseWith(CreateInviteBody, request.body);
    const invite = await service.createInvite(
      request.params.roomId,
      auth.userId,
      body.expiresAt ?? null,
    );
    // Strip the InviteDoc id — the contracts Invite shape is the response.
    return {
      invite: {
        code: invite.code,
        roomId: invite.roomId,
        createdBy: invite.createdBy,
        expiresAt: invite.expiresAt,
      },
    };
  });

  app.post<RoomParams>('/rooms/:roomId/theater', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    const body = parseWith(SetTheaterBody, request.body);
    const room = await service.setTheater(request.params.roomId, auth.userId, body.enabled);
    return { room: serializeRoom(room) };
  });

  app.patch<RoomParams>('/rooms/:roomId', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    const body = parseWith(UpdateRoomBody, request.body);
    const room = await service.renameRoom(request.params.roomId, auth.userId, body.name);
    return { room: serializeRoom(room) };
  });

  app.delete<RoomParams>('/rooms/:roomId', async (request) => {
    const auth = requireAuth(request);
    assertGuestScope(auth, request.params.roomId);
    await service.deleteRoom(request.params.roomId, auth.userId);
    return { ok: true as const };
  });

  app.post('/push/room-mute', async (request) => {
    const auth = requireAuth(request);
    const body = parseWith(SetRoomMuteBody, request.body);
    assertGuestScope(auth, body.roomId);
    await service.setRoomMute(body.roomId, auth.userId, body.muted);
    return { ok: true as const };
  });
};
