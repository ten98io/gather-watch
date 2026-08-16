import {
  ApiError as ApiErrorPayload,
  AddToRoomQueueBody,
  AddToRoomQueueResponse,
  BanMemberBody,
  BanMemberResponse,
  CompleteUploadBody,
  CompleteUploadResponse,
  CreateInviteBody,
  CreateInviteResponse,
  CreatePlaylistBody,
  CreatePlaylistResponse,
  CreateRoomBody,
  CreateRoomResponse,
  CreateUploadBody,
  CreateUploadResponse,
  DeleteAssetResponse,
  DeletePlaylistResponse,
  GetPlaylistResponse,
  GetRoomResponse,
  GuestJoinBody,
  GuestJoinResponse,
  JoinRoomBody,
  JoinRoomResponse,
  KickMemberBody,
  KickMemberResponse,
  LeaveRoomResponse,
  ListLibraryResponse,
  ListMembersResponse,
  ListMessagesResponse,
  ListMyRoomsResponse,
  ListPlaylistsResponse,
  ListSessionsResponse,
  LivekitTokenBody,
  LivekitTokenResponse,
  LogoutResponse,
  MeResponse,
  PinMessageBody,
  PinMessageResponse,
  PushSubscribeBody,
  PushSubscribeResponse,
  PushUnsubscribeBody,
  PushUnsubscribeResponse,
  RefreshResponse,
  RenameAssetBody,
  RenameAssetResponse,
  ReplayEventsResponse,
  RequestMagicLinkBody,
  RequestMagicLinkResponse,
  ResolveMediaBody,
  ResolveMediaResponse,
  RevokeAllSessionsResponse,
  RevokeSessionResponse,
  SearchGifsResponse,
  SearchMessagesResponse,
  TransferHostBody,
  TransferHostResponse,
  TurnCredentialsResponse,
  UnfurlBody,
  UnfurlResponse,
  UpdatePlaylistBody,
  UpdatePlaylistResponse,
  UpdatePoliciesBody,
  UpdatePoliciesResponse,
  UpdateProfileBody,
  UpdateProfileResponse,
  UpgradeGuestBody,
  UpgradeGuestResponse,
  VerifyTokenBody,
  VerifyTokenResponse,
} from '@playin/contracts';
import type { AssetId, PlaylistId, RoomId, SessionId } from '@playin/contracts';
import { ApiError, apiErrorFromStatus } from './errors';
import { defaultFetch } from './types';
import type { FetchInitLike, FetchLike } from './types';

/** Options for {@link RestClient}. */
export interface RestClientOptions {
  /** Fetch implementation; defaults to the platform fetch when available. */
  fetchImpl?: FetchLike;
  /** Access token provider; may be sync or async, null means anonymous. */
  getAccessToken?: () => string | null | Promise<string | null>;
  /** Fired when the token refresh fails after a 401. */
  onAuthExpired?: () => void;
  /** Credentials mode passed on every call. Defaults to 'include'. */
  credentials?: 'include' | 'omit' | 'same-origin';
}

interface RequestArgs<T> {
  label: string;
  method: string;
  path: string;
  schema: { parse(v: unknown): T };
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  authExempt?: boolean;
  retried?: boolean;
}

/**
 * Isomorphic REST client for the Playin API. Responses are validated against
 * the contracts zod schemas; errors are thrown as {@link ApiError}. A 401 on
 * a non-auth-exempt endpoint triggers a single-flight refresh followed by one
 * replay of the original request.
 */
export class RestClient {
  /** Auth endpoints. */
  readonly auth: {
    requestMagicLink(body: RequestMagicLinkBody): Promise<RequestMagicLinkResponse>;
    verifyToken(body: VerifyTokenBody): Promise<VerifyTokenResponse>;
    refresh(): Promise<RefreshResponse>;
    me(): Promise<MeResponse>;
    updateProfile(body: UpdateProfileBody): Promise<UpdateProfileResponse>;
    guestJoin(body: GuestJoinBody): Promise<GuestJoinResponse>;
    logout(): Promise<LogoutResponse>;
    listSessions(): Promise<ListSessionsResponse>;
    revokeSession(sessionId: SessionId): Promise<RevokeSessionResponse>;
    revokeAllSessions(): Promise<RevokeAllSessionsResponse>;
    upgradeGuest(body: UpgradeGuestBody): Promise<UpgradeGuestResponse>;
  };
  /** Room management endpoints. */
  readonly rooms: {
    createRoom(body: CreateRoomBody): Promise<CreateRoomResponse>;
    listMyRooms(): Promise<ListMyRoomsResponse>;
    getRoom(roomId: RoomId): Promise<GetRoomResponse>;
    joinRoom(body: JoinRoomBody): Promise<JoinRoomResponse>;
    leaveRoom(roomId: RoomId): Promise<LeaveRoomResponse>;
    listMembers(roomId: RoomId): Promise<ListMembersResponse>;
    updatePolicies(roomId: RoomId, body: UpdatePoliciesBody): Promise<UpdatePoliciesResponse>;
    transferHost(roomId: RoomId, body: TransferHostBody): Promise<TransferHostResponse>;
    kickMember(roomId: RoomId, body: KickMemberBody): Promise<KickMemberResponse>;
    banMember(roomId: RoomId, body: BanMemberBody): Promise<BanMemberResponse>;
    createInvite(roomId: RoomId, body: CreateInviteBody): Promise<CreateInviteResponse>;
  };
  /** Message history and message-adjacent endpoints. */
  readonly messages: {
    listMessages(
      roomId: RoomId,
      query?: { beforeSeq?: number; limit?: number },
    ): Promise<ListMessagesResponse>;
    searchMessages(
      roomId: RoomId,
      query: { q: string; limit?: number },
    ): Promise<SearchMessagesResponse>;
    pinMessage(roomId: RoomId, body: PinMessageBody): Promise<PinMessageResponse>;
    unfurl(body: UnfurlBody): Promise<UnfurlResponse>;
  };
  /** Media upload session and library endpoints. */
  readonly media: {
    createUpload(body: CreateUploadBody): Promise<CreateUploadResponse>;
    completeUpload(body: CompleteUploadBody): Promise<CompleteUploadResponse>;
    listLibrary(query?: { cursor?: string; limit?: number }): Promise<ListLibraryResponse>;
    deleteAsset(assetId: AssetId): Promise<DeleteAssetResponse>;
    renameAsset(assetId: AssetId, body: RenameAssetBody): Promise<RenameAssetResponse>;
    /** Server-side title/artwork/duration lookup for a pasted link or a
     *  MediaRef — the paste-a-link preview and any surface that needs real
     *  metadata before an item exists in a queue. */
    resolveMedia(body: ResolveMediaBody): Promise<ResolveMediaResponse>;
  };
  /** Playlist endpoints. */
  readonly playlists: {
    createPlaylist(body: CreatePlaylistBody): Promise<CreatePlaylistResponse>;
    listPlaylists(): Promise<ListPlaylistsResponse>;
    getPlaylist(playlistId: PlaylistId): Promise<GetPlaylistResponse>;
    updatePlaylist(
      playlistId: PlaylistId,
      body: UpdatePlaylistBody,
    ): Promise<UpdatePlaylistResponse>;
    deletePlaylist(playlistId: PlaylistId): Promise<DeletePlaylistResponse>;
    addToRoomQueue(body: AddToRoomQueueBody): Promise<AddToRoomQueueResponse>;
  };
  /** Event replay endpoint (used to backfill after socket gaps). */
  readonly events: {
    replay(roomId: RoomId, sinceSeq: number): Promise<ReplayEventsResponse>;
  };
  /** LiveKit token endpoint. */
  readonly livekit: {
    token(body: LivekitTokenBody): Promise<LivekitTokenResponse>;
  };
  /** WebRTC mesh support endpoints (TURN credentials etc.). */
  readonly rtc: {
    turnCredentials(): Promise<TurnCredentialsResponse>;
  };
  /** Web push subscription endpoints. */
  readonly push: {
    subscribe(body: PushSubscribeBody): Promise<PushSubscribeResponse>;
    unsubscribe(body: PushUnsubscribeBody): Promise<PushUnsubscribeResponse>;
  };
  /** GIF search endpoint. */
  readonly gifs: {
    search(query: { q: string; limit?: number }): Promise<SearchGifsResponse>;
  };

  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly getAccessToken: (() => string | null | Promise<string | null>) | undefined;
  private readonly onAuthExpired: (() => void) | undefined;
  private readonly credentials: 'include' | 'omit' | 'same-origin';
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(baseUrl: string, opts?: RestClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts?.fetchImpl ?? defaultFetch();
    this.getAccessToken = opts?.getAccessToken;
    this.onAuthExpired = opts?.onAuthExpired;
    this.credentials = opts?.credentials ?? 'include';

    this.auth = {
      requestMagicLink: (body) =>
        this.request({
          label: 'auth.requestMagicLink',
          method: 'POST',
          path: '/auth/magic-link',
          schema: RequestMagicLinkResponse,
          body,
          authExempt: true,
        }),
      verifyToken: (body) =>
        this.request({
          label: 'auth.verifyToken',
          method: 'POST',
          path: '/auth/verify',
          schema: VerifyTokenResponse,
          body,
          authExempt: true,
        }),
      refresh: () =>
        this.request({
          label: 'auth.refresh',
          method: 'POST',
          path: '/auth/refresh',
          schema: RefreshResponse,
          authExempt: true,
        }),
      me: () =>
        this.request({ label: 'auth.me', method: 'GET', path: '/auth/me', schema: MeResponse }),
      updateProfile: (body) =>
        this.request({
          label: 'auth.updateProfile',
          method: 'PATCH',
          path: '/auth/me',
          schema: UpdateProfileResponse,
          body,
        }),
      guestJoin: (body) =>
        this.request({
          label: 'auth.guestJoin',
          method: 'POST',
          path: '/auth/guest',
          schema: GuestJoinResponse,
          body,
          authExempt: true,
        }),
      logout: () =>
        this.request({
          label: 'auth.logout',
          method: 'POST',
          path: '/auth/logout',
          schema: LogoutResponse,
        }),
      listSessions: () =>
        this.request({
          label: 'auth.listSessions',
          method: 'GET',
          path: '/auth/sessions',
          schema: ListSessionsResponse,
        }),
      revokeSession: (sessionId) =>
        this.request({
          label: 'auth.revokeSession',
          method: 'DELETE',
          path: `/auth/sessions/${encodeURIComponent(sessionId)}`,
          schema: RevokeSessionResponse,
        }),
      revokeAllSessions: () =>
        this.request({
          label: 'auth.revokeAllSessions',
          method: 'POST',
          path: '/auth/sessions/revoke-all',
          schema: RevokeAllSessionsResponse,
        }),
      upgradeGuest: (body) =>
        this.request({
          label: 'auth.upgradeGuest',
          method: 'POST',
          path: '/auth/upgrade',
          schema: UpgradeGuestResponse,
          body,
        }),
    };

    this.rooms = {
      createRoom: (body) =>
        this.request({
          label: 'rooms.createRoom',
          method: 'POST',
          path: '/rooms',
          schema: CreateRoomResponse,
          body,
        }),
      listMyRooms: () =>
        this.request({
          label: 'rooms.listMyRooms',
          method: 'GET',
          path: '/rooms',
          schema: ListMyRoomsResponse,
        }),
      getRoom: (roomId) =>
        this.request({
          label: 'rooms.getRoom',
          method: 'GET',
          path: `/rooms/${encodeURIComponent(roomId)}`,
          schema: GetRoomResponse,
        }),
      joinRoom: (body) =>
        this.request({
          label: 'rooms.joinRoom',
          method: 'POST',
          path: '/rooms/join',
          schema: JoinRoomResponse,
          body,
        }),
      leaveRoom: (roomId) =>
        this.request({
          label: 'rooms.leaveRoom',
          method: 'POST',
          path: `/rooms/${encodeURIComponent(roomId)}/leave`,
          schema: LeaveRoomResponse,
        }),
      listMembers: (roomId) =>
        this.request({
          label: 'rooms.listMembers',
          method: 'GET',
          path: `/rooms/${encodeURIComponent(roomId)}/members`,
          schema: ListMembersResponse,
        }),
      updatePolicies: (roomId, body) =>
        this.request({
          label: 'rooms.updatePolicies',
          method: 'PATCH',
          path: `/rooms/${encodeURIComponent(roomId)}/policies`,
          schema: UpdatePoliciesResponse,
          body,
        }),
      transferHost: (roomId, body) =>
        this.request({
          label: 'rooms.transferHost',
          method: 'POST',
          path: `/rooms/${encodeURIComponent(roomId)}/transfer-host`,
          schema: TransferHostResponse,
          body,
        }),
      kickMember: (roomId, body) =>
        this.request({
          label: 'rooms.kickMember',
          method: 'POST',
          path: `/rooms/${encodeURIComponent(roomId)}/kick`,
          schema: KickMemberResponse,
          body,
        }),
      banMember: (roomId, body) =>
        this.request({
          label: 'rooms.banMember',
          method: 'POST',
          path: `/rooms/${encodeURIComponent(roomId)}/ban`,
          schema: BanMemberResponse,
          body,
        }),
      createInvite: (roomId, body) =>
        this.request({
          label: 'rooms.createInvite',
          method: 'POST',
          path: `/rooms/${encodeURIComponent(roomId)}/invites`,
          schema: CreateInviteResponse,
          body,
        }),
    };

    this.messages = {
      listMessages: (roomId, query) =>
        this.request({
          label: 'messages.listMessages',
          method: 'GET',
          path: `/rooms/${encodeURIComponent(roomId)}/messages`,
          schema: ListMessagesResponse,
          query: { beforeSeq: query?.beforeSeq, limit: query?.limit },
        }),
      searchMessages: (roomId, query) =>
        this.request({
          label: 'messages.searchMessages',
          method: 'GET',
          path: `/rooms/${encodeURIComponent(roomId)}/messages/search`,
          schema: SearchMessagesResponse,
          query: { q: query.q, limit: query.limit },
        }),
      pinMessage: (roomId, body) =>
        this.request({
          label: 'messages.pinMessage',
          method: 'POST',
          path: `/rooms/${encodeURIComponent(roomId)}/messages/pin`,
          schema: PinMessageResponse,
          body,
        }),
      unfurl: (body) =>
        this.request({
          label: 'messages.unfurl',
          method: 'POST',
          path: '/unfurl',
          schema: UnfurlResponse,
          body,
        }),
    };

    this.media = {
      createUpload: (body) =>
        this.request({
          label: 'media.createUpload',
          method: 'POST',
          path: '/media/uploads',
          schema: CreateUploadResponse,
          body,
        }),
      completeUpload: (body) =>
        this.request({
          label: 'media.completeUpload',
          method: 'POST',
          path: '/media/uploads/complete',
          schema: CompleteUploadResponse,
          body,
        }),
      listLibrary: (query) =>
        this.request({
          label: 'media.listLibrary',
          method: 'GET',
          path: '/media/library',
          schema: ListLibraryResponse,
          query: { cursor: query?.cursor, limit: query?.limit },
        }),
      deleteAsset: (assetId) =>
        this.request({
          label: 'media.deleteAsset',
          method: 'DELETE',
          path: `/media/assets/${encodeURIComponent(assetId)}`,
          schema: DeleteAssetResponse,
        }),
      renameAsset: (assetId, body) =>
        this.request({
          label: 'media.renameAsset',
          method: 'PATCH',
          path: `/media/assets/${encodeURIComponent(assetId)}`,
          schema: RenameAssetResponse,
          body,
        }),
      resolveMedia: (body) =>
        this.request({
          label: 'media.resolveMedia',
          method: 'POST',
          path: '/media/resolve',
          schema: ResolveMediaResponse,
          body,
        }),
    };

    this.playlists = {
      createPlaylist: (body) =>
        this.request({
          label: 'playlists.createPlaylist',
          method: 'POST',
          path: '/playlists',
          schema: CreatePlaylistResponse,
          body,
        }),
      listPlaylists: () =>
        this.request({
          label: 'playlists.listPlaylists',
          method: 'GET',
          path: '/playlists',
          schema: ListPlaylistsResponse,
        }),
      getPlaylist: (playlistId) =>
        this.request({
          label: 'playlists.getPlaylist',
          method: 'GET',
          path: `/playlists/${encodeURIComponent(playlistId)}`,
          schema: GetPlaylistResponse,
        }),
      updatePlaylist: (playlistId, body) =>
        this.request({
          label: 'playlists.updatePlaylist',
          method: 'PATCH',
          path: `/playlists/${encodeURIComponent(playlistId)}`,
          schema: UpdatePlaylistResponse,
          body,
        }),
      deletePlaylist: (playlistId) =>
        this.request({
          label: 'playlists.deletePlaylist',
          method: 'DELETE',
          path: `/playlists/${encodeURIComponent(playlistId)}`,
          schema: DeletePlaylistResponse,
        }),
      addToRoomQueue: (body) =>
        this.request({
          label: 'playlists.addToRoomQueue',
          method: 'POST',
          path: '/playlists/add-to-queue',
          schema: AddToRoomQueueResponse,
          body,
        }),
    };

    this.events = {
      replay: (roomId, sinceSeq) =>
        this.request({
          label: 'events.replay',
          method: 'GET',
          path: `/rooms/${encodeURIComponent(roomId)}/events`,
          schema: ReplayEventsResponse,
          query: { since: sinceSeq },
        }),
    };

    this.livekit = {
      token: (body) =>
        this.request({
          label: 'livekit.token',
          method: 'POST',
          path: '/rtc/livekit-token',
          schema: LivekitTokenResponse,
          body,
        }),
    };

    this.rtc = {
      turnCredentials: () =>
        this.request({
          label: 'rtc.turnCredentials',
          method: 'GET',
          path: '/rtc/turn-credentials',
          schema: TurnCredentialsResponse,
        }),
    };

    this.push = {
      subscribe: (body) =>
        this.request({
          label: 'push.subscribe',
          method: 'POST',
          path: '/push/subscribe',
          schema: PushSubscribeResponse,
          body,
        }),
      unsubscribe: (body) =>
        this.request({
          label: 'push.unsubscribe',
          method: 'POST',
          path: '/push/unsubscribe',
          schema: PushUnsubscribeResponse,
          body,
        }),
    };

    this.gifs = {
      search: (query) =>
        this.request({
          label: 'gifs.search',
          method: 'GET',
          path: '/gifs/search',
          schema: SearchGifsResponse,
          query: { q: query.q, limit: query.limit },
        }),
    };
  }

  private async request<T>(args: RequestArgs<T>): Promise<T> {
    const { label, method, path, schema, query, body } = args;
    const authExempt = args.authExempt ?? false;
    const retried = args.retried ?? false;

    const fetchImpl = this.fetchImpl;
    if (fetchImpl === undefined) {
      throw new ApiError('INTERNAL', 'no fetch implementation available');
    }

    let url = this.baseUrl + path;
    if (query !== undefined) {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
      if (parts.length > 0) url += `?${parts.join('&')}`;
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = this.getAccessToken !== undefined ? await this.getAccessToken() : null;
    if (token !== null) headers['authorization'] = `Bearer ${token}`;

    const init: FetchInitLike = {
      method,
      headers,
      credentials: this.credentials,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };

    const res = await fetchImpl(url, init);

    if (res.ok) {
      const data: unknown = await res.json();
      try {
        return schema.parse(data);
      } catch {
        throw new ApiError('VALIDATION', `invalid response from ${label}`, res.status);
      }
    }

    const text = await res.text();
    let error: ApiError;
    try {
      const parsed = ApiErrorPayload.safeParse(JSON.parse(text));
      error = parsed.success
        ? new ApiError(parsed.data.code, parsed.data.message, res.status, parsed.data.refType)
        : apiErrorFromStatus(res.status, text);
    } catch {
      error = apiErrorFromStatus(res.status, text);
    }

    if (res.status === 401 && !authExempt && !retried) {
      const refreshed = await this.ensureRefreshed();
      if (refreshed) {
        return this.request({ ...args, retried: true });
      }
      this.onAuthExpired?.();
    }
    throw error;
  }

  /** Single-flight guard: concurrent 401s await the same refresh promise. */
  private ensureRefreshed(): Promise<boolean> {
    if (this.refreshInFlight === null) {
      this.refreshInFlight = this.doRefresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  /** POSTs /auth/refresh directly (auth-exempt, never retried). */
  private async doRefresh(): Promise<boolean> {
    try {
      const fetchImpl = this.fetchImpl;
      if (fetchImpl === undefined) return false;
      const headers: Record<string, string> = { accept: 'application/json' };
      const token = this.getAccessToken !== undefined ? await this.getAccessToken() : null;
      if (token !== null) headers['authorization'] = `Bearer ${token}`;
      const res = await fetchImpl(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers,
        credentials: this.credentials,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
