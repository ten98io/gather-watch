/**
 * WebSocket hub: owns every open socket grouped by room, dispatches inbound
 * client events to the module handler registry, and fans bus messages out to
 * local sockets. Cross-instance delivery comes free from the bus — the hub
 * only ever talks to its own sockets.
 *
 * Close codes: 4401 auth failures, 4403 forbidden/banned/scope, 4404 no room.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import type { ApiError, Member, RoomId, UserId } from '@gather/contracts';
import { ClientEvent, ReplayEventsQuery, ServerEvent, makeApiError } from '@gather/contracts';
import { memberDocId, roomChannel } from '../adapters/ports';
import type { RoomBusMessage } from '../adapters/ports';
import { AppError, isAppError } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';
import { requireAuth } from '../plugins/auth';
import { countWsEvent } from '../plugins/metrics';
import { parseWith } from '../plugins/error-mapper';
import type {
  AuthContext,
  Deps,
  HandlerContext,
  HubApi,
  ModulePlugin,
  WsHandler,
} from '../modules/types';

/** One open socket plus its connect-time identity. */
interface Conn {
  socket: WebSocket;
  auth: AuthContext;
  member: Member;
  alive: boolean;
  /** Inbound-frame rate limiting (sliding window). */
  frameWindowStart: number;
  frameCount: number;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * Per-socket inbound frame ceiling: @fastify/rate-limit only guards REST, so
 * WS floods (webrtc.* signaling spam, sync churn) need their own gate — every
 * persisted event a flood triggers is a DB write. 300 frames / 10 s is ~30
 * msg/s sustained, far above any legitimate client (typing + clock pings +
 * signaling bursts), far below a flood.
 */
const WS_FRAME_WINDOW_MS = 10_000;
const WS_FRAME_LIMIT = 300;

/** First zod issue rendered as "path.to.field: message". */
function firstIssueMessage(err: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const issue = err.issues[0];
  if (issue === undefined) return 'invalid event';
  const path = issue.path.join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}

/** Ephemeral (seq 0) error event, this socket only. */
function sendError(socket: WebSocket, roomId: RoomId, payload: ApiError): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'error', roomId, seq: 0, ts: Date.now(), payload }));
}

/**
 * Room-socket registry + client-event dispatcher. Constructed with the deps
 * minus `hub` (app.ts builds the full Deps afterwards and hands them back via
 * setDeps before any connection is accepted).
 */
export class RoomHub implements HubApi {
  private readonly baseDeps: Omit<Deps, 'hub'>;
  private deps: Deps | null = null;
  private readonly rooms = new Map<string, Set<Conn>>();
  private readonly handlers = new Map<string, WsHandler>();
  private readonly busSubs = new Map<string, () => Promise<void>>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(deps: Omit<Deps, 'hub'>) {
    this.baseDeps = deps;
    this.registerModule({
      name: 'hub-core',
      wsHandlers: {
        'clock.ping': (event, ctx) => {
          ctx.reply('clock.pong', { clientTs: event.payload.clientTs, serverTs: Date.now() });
        },
        'webrtc.offer': (event, ctx) => {
          ctx.deps.events.emitDirect(ctx.roomId, event.payload.targetUserId, 'webrtc.offer', {
            ...event.payload,
            fromUserId: ctx.auth.userId,
          });
        },
        'webrtc.answer': (event, ctx) => {
          ctx.deps.events.emitDirect(ctx.roomId, event.payload.targetUserId, 'webrtc.answer', {
            ...event.payload,
            fromUserId: ctx.auth.userId,
          });
        },
        'webrtc.ice': (event, ctx) => {
          ctx.deps.events.emitDirect(ctx.roomId, event.payload.targetUserId, 'webrtc.ice', {
            ...event.payload,
            fromUserId: ctx.auth.userId,
          });
        },
      },
    });
    this.heartbeat = setInterval(() => {
      this.sweep();
    }, HEARTBEAT_INTERVAL_MS);
    // Never keep the process alive just for the sweep.
    this.heartbeat.unref();
  }

  /** Called once by app.ts with the full Deps (hub included) before any
   *  connection is accepted. */
  setDeps(deps: Deps): void {
    this.deps = deps;
  }

  registerModule(mod: ModulePlugin): void {
    for (const [type, handler] of Object.entries(mod.wsHandlers ?? {})) {
      if (handler === undefined) continue;
      if (this.handlers.has(type)) {
        throw new Error(`duplicate ws handler for event type "${type}" (module ${mod.name})`);
      }
      // Dispatch validates the frame against ClientEvent before lookup, so the
      // handler only ever sees its own event type.
      this.handlers.set(type, handler as WsHandler);
    }
  }

  localUserIds(roomId: RoomId): UserId[] {
    const userIds = new Set<UserId>();
    for (const conn of this.rooms.get(roomId) ?? []) {
      if (conn.socket.readyState === WebSocket.OPEN) {
        userIds.add(conn.auth.userId);
      }
    }
    return [...userIds];
  }

  localConnectionCount(roomId: RoomId): number {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  /** Instance-local gauges for the ops surface (/admin/overview). */
  stats(): { connections: number; rooms: number } {
    let connections = 0;
    for (const conns of this.rooms.values()) connections += conns.size;
    return { connections, rooms: this.rooms.size };
  }

  disconnectUser(roomId: RoomId, userId: UserId, code = 4403, reason = 'removed'): void {
    for (const conn of this.rooms.get(roomId) ?? []) {
      if (conn.auth.userId === userId) {
        conn.socket.close(code, reason);
      }
    }
  }

  disconnectSession(sessionId: string, code = 4401, reason = 'session revoked'): void {
    for (const conns of this.rooms.values()) {
      for (const conn of conns) {
        if (conn.auth.sessionId === sessionId) {
          conn.socket.close(code, reason);
        }
      }
    }
  }

  /** Full connection handshake, then frame dispatch until close. */
  async accept(socket: WebSocket, request: FastifyRequest): Promise<void> {
    const { config, store, log } = this.baseDeps;
    // Buffer frames from the moment the upgrade lands: the handshake below
    // (token/session/member loads) is async, and on a real store it takes
    // tens of ms — a client whose socket is already open (RoomSocket flushes
    // its send queue on open) would otherwise silently lose those frames.
    const earlyFrames: Array<[unknown, boolean]> = [];
    const onEarlyFrame = (data: unknown, isBinary: boolean): void => {
      earlyFrames.push([data, isBinary]);
    };
    socket.on('message', onEarlyFrame);
    try {
      const query = request.query as Record<string, unknown>;
      const roomId = typeof query.roomId === 'string' ? query.roomId : null;
      const token = typeof query.token === 'string' ? query.token : null;
      if (roomId === null || token === null) {
        socket.close(4401, 'missing roomId or token');
        return;
      }

      const claims = await verifyAccessToken(config, token);
      if (claims === null) {
        socket.close(4401, 'invalid token');
        return;
      }
      const session = await store.sessions.findById(claims.sessionId);
      if (session === null || session.revokedAt !== null) {
        socket.close(4401, 'invalid token');
        return;
      }
      if (claims.guestRoomId !== null && claims.guestRoomId !== roomId) {
        socket.close(4403, 'guest token is room-scoped');
        return;
      }

      const room = await store.rooms.findById(roomId);
      if (room === null) {
        socket.close(4404, 'room not found');
        return;
      }
      const member = await store.members.findById(memberDocId(roomId, claims.userId));
      if (member === null) {
        socket.close(4403, 'not a member');
        return;
      }
      if (member.banned) {
        socket.close(4403, 'banned');
        return;
      }

      const auth: AuthContext = {
        userId: claims.userId as UserId,
        sessionId: claims.sessionId,
        guest: claims.guest,
        guestRoomId: claims.guestRoomId as RoomId | null,
      };
      const conn: Conn = {
        socket,
        auth,
        member,
        alive: true,
        frameWindowStart: Date.now(),
        frameCount: 0,
      };
      this.addConn(roomId, conn);
      await this.ensureBusSub(roomId);

      socket.off('message', onEarlyFrame);
      socket.on('message', (data: unknown, isBinary: boolean) => {
        void this.onFrame(conn, roomId as RoomId, data, isBinary);
      });
      // Replay handshake-window frames in arrival order.
      for (const [data, isBinary] of earlyFrames) {
        await this.onFrame(conn, roomId as RoomId, data, isBinary);
      }
      socket.on('pong', () => {
        conn.alive = true;
      });
      socket.on('close', () => {
        this.removeConn(roomId, conn);
      });
      socket.on('error', (err: unknown) => {
        log.warn({ err, roomId, userId: auth.userId }, 'websocket error');
        this.removeConn(roomId, conn);
      });
    } catch (err) {
      log.error({ err }, 'websocket handshake failed');
      socket.close(1011, 'internal error');
    }
  }

  /** Clear the sweep, close every socket (1001), unsubscribe all channels. */
  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const conns of this.rooms.values()) {
      for (const conn of conns) {
        conn.socket.close(1001, 'server shutting down');
      }
    }
    this.rooms.clear();
    const unsubs = [...this.busSubs.values()];
    this.busSubs.clear();
    await Promise.all(unsubs.map((unsub) => unsub()));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private addConn(roomId: string, conn: Conn): void {
    let conns = this.rooms.get(roomId);
    if (conns === undefined) {
      conns = new Set();
      this.rooms.set(roomId, conns);
    }
    conns.add(conn);
  }

  private removeConn(roomId: string, conn: Conn): void {
    const conns = this.rooms.get(roomId);
    if (conns === undefined || !conns.delete(conn)) return;
    if (conns.size === 0) {
      this.rooms.delete(roomId);
      const unsub = this.busSubs.get(roomId);
      this.busSubs.delete(roomId);
      if (unsub !== undefined) {
        void unsub().catch((err: unknown) => {
          this.baseDeps.log.warn({ err, roomId }, 'bus unsubscribe failed');
        });
      }
    }
  }

  /** Subscribe the room's bus channel on first local connection. */
  private async ensureBusSub(roomId: string): Promise<void> {
    if (this.busSubs.has(roomId)) return;
    const subscribing = this.baseDeps.bus.subscribe(roomChannel(roomId), (raw) => {
      this.onBusMessage(roomId, raw);
    });
    // Stash immediately (behind the pending promise) so concurrent first
    // connections for one room cannot double-subscribe.
    this.busSubs.set(roomId, async () => {
      const unsub = await subscribing;
      await unsub();
    });
    await subscribing;
  }

  /** Fan a bus message out to this instance's sockets for the room. Events
   *  were validated/typed at emit time — no re-validation on the hot path. */
  private onBusMessage(roomId: string, raw: unknown): void {
    const msg = raw as RoomBusMessage;
    const conns = this.rooms.get(roomId);
    if (conns === undefined) return;
    const frame = JSON.stringify(msg.event);
    for (const conn of conns) {
      if (conn.socket.readyState !== WebSocket.OPEN) continue;
      if (msg.targetUserId === null || conn.auth.userId === msg.targetUserId) {
        conn.socket.send(frame);
      }
    }
  }

  /** Parse, validate, and dispatch one inbound frame. */
  private async onFrame(conn: Conn, roomId: RoomId, data: unknown, isBinary: boolean): Promise<void> {
    const { socket } = conn;
    // Sliding-window frame limiter: drop excess frames (error sent once per
    // window) BEFORE parse/dispatch so a flood cannot amplify into handler
    // work or persisted-event writes.
    const nowMs = Date.now();
    if (nowMs - conn.frameWindowStart >= WS_FRAME_WINDOW_MS) {
      conn.frameWindowStart = nowMs;
      conn.frameCount = 0;
    }
    conn.frameCount += 1;
    if (conn.frameCount > WS_FRAME_LIMIT) {
      if (conn.frameCount === WS_FRAME_LIMIT + 1) {
        sendError(socket, roomId, makeApiError('RATE_LIMITED', 'too many messages'));
      }
      return;
    }
    if (isBinary) {
      sendError(socket, roomId, makeApiError('VALIDATION', 'binary frames are not supported'));
      return;
    }
    const text =
      typeof data === 'string'
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data as Buffer[]).toString('utf8')
          : Buffer.from(data as Buffer).toString('utf8');

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      sendError(socket, roomId, makeApiError('VALIDATION', 'invalid JSON'));
      return;
    }
    const parsed = ClientEvent.safeParse(json);
    if (!parsed.success) {
      sendError(socket, roomId, makeApiError('VALIDATION', firstIssueMessage(parsed.error)));
      return;
    }
    const event = parsed.data;
    if (event.roomId !== roomId) {
      sendError(socket, roomId, makeApiError('FORBIDDEN', 'event roomId does not match this connection'));
      return;
    }
    const handler = this.handlers.get(event.type);
    if (handler === undefined) {
      sendError(socket, roomId, makeApiError('VALIDATION', `unsupported event type: ${event.type}`));
      return;
    }
    countWsEvent(event.type);

    const reply: HandlerContext['reply'] = (type, payload) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type, roomId, seq: 0, ts: Date.now(), payload }));
    };
    const ctx: HandlerContext = {
      deps: this.fullDeps(),
      roomId,
      auth: conn.auth,
      member: conn.member,
      reply,
    };
    try {
      await handler(event, ctx);
    } catch (err) {
      if (isAppError(err)) {
        sendError(socket, roomId, err.toPayload());
      } else {
        this.baseDeps.log.error({ err, roomId, type: event.type }, 'ws handler failed');
        sendError(socket, roomId, makeApiError('INTERNAL', 'internal error'));
      }
    }
  }

  private fullDeps(): Deps {
    if (this.deps === null) {
      throw new Error('RoomHub.setDeps must be called before accepting connections');
    }
    return this.deps;
  }

  /** Terminate sockets that failed to answer the previous ws-level ping, and
   *  re-validate each live session so revocation (logout everywhere, refresh
   *  reuse) reaches sockets opened before the revoke — including sockets on
   *  OTHER instances, where the revoking instance's disconnectSession can't
   *  see them. Exposure is bounded by the sweep interval. */
  private sweep(): void {
    for (const conns of this.rooms.values()) {
      for (const conn of conns) {
        if (conn.socket.readyState !== WebSocket.OPEN) continue;
        if (!conn.alive) {
          conn.socket.terminate();
          continue;
        }
        conn.alive = false;
        conn.socket.ping();
      }
    }
    void this.sweepRevokedSessions();
  }

  private async sweepRevokedSessions(): Promise<void> {
    // One store read per distinct live session per sweep.
    const bySession = new Map<string, Conn[]>();
    for (const conns of this.rooms.values()) {
      for (const conn of conns) {
        if (conn.socket.readyState !== WebSocket.OPEN) continue;
        const list = bySession.get(conn.auth.sessionId);
        if (list === undefined) {
          bySession.set(conn.auth.sessionId, [conn]);
        } else {
          list.push(conn);
        }
      }
    }
    for (const [sessionId, conns] of bySession) {
      try {
        const session = await this.baseDeps.store.sessions.findById(sessionId);
        if (session === null || session.revokedAt !== null) {
          for (const conn of conns) {
            conn.socket.close(4401, 'session revoked');
          }
        }
      } catch (err) {
        this.baseDeps.log.warn({ err, sessionId }, 'session sweep check failed');
      }
    }
  }
}

/**
 * Wire the WS endpoint and the event-replay REST endpoint onto the app.
 * @fastify/websocket must already be registered.
 */
export function registerWs(app: FastifyInstance, hub: RoomHub): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    void hub.accept(socket, request);
  });

  app.get<{ Params: { roomId: string } }>('/rooms/:roomId/events', async (request, reply) => {
    const { store, log } = app.deps;
    const auth = requireAuth(request);
    const roomId = request.params.roomId;

    const member = await store.members.findById(memberDocId(roomId, auth.userId));
    if (member === null) {
      throw new AppError('FORBIDDEN', 'not a member');
    }
    if (member.banned) {
      throw new AppError('FORBIDDEN', 'banned');
    }

    const { since } = parseWith(ReplayEventsQuery, request.query);
    const docs = await store.events.findMany(
      { roomId, seq: { $gt: since } },
      { sort: [['seq', 1]], limit: 500 },
    );
    const events: ServerEvent[] = [];
    for (const doc of docs) {
      const parsed = ServerEvent.safeParse({
        type: doc.type,
        roomId: doc.roomId,
        seq: doc.seq,
        ts: doc.ts,
        payload: doc.payload,
      });
      // Drop (and report) events that no longer match the contracts schema —
      // replay must never crash a reconnecting client on schema drift.
      if (parsed.success) {
        events.push(parsed.data);
      } else {
        log.warn({ roomId, seq: doc.seq, type: doc.type }, 'dropping event that failed schema validation');
      }
    }
    return reply.send({ events } satisfies { events: ServerEvent[] });
  });
}
