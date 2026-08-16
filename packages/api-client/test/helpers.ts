import type { RoomId, ServerEvent, UserId } from '@gather/contracts';
import type {
  FetchInitLike,
  FetchLike,
  FetchResponseLike,
  SetTimeoutFn,
  TimeoutHandle,
  WebSocketLike,
} from '../src';

// The only permitted timer access: a narrow globalThis cast (no DOM/Node typings).
const realSetTimeout = (
  globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }
).setTimeout;

/** One real macrotask; awaiting it flushes all pending microtask chains. */
export const tick = (): Promise<void> =>
  new Promise((resolve) => {
    realSetTimeout(() => resolve(), 0);
  });

export const rid = (s: string): RoomId => s as unknown as RoomId;
export const uid = (s: string): UserId => s as unknown as UserId;

/** Deterministic scheduler for the injectable timer options. */
export class ManualTimers {
  pending: { id: number; fn: () => void; ms: number }[] = [];
  private nextId = 1;

  set: SetTimeoutFn = (fn, ms) => {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.push({ id, fn, ms });
    return id;
  };

  clear = (h: TimeoutHandle): void => {
    const idx = this.pending.findIndex((e) => e.id === h);
    if (idx >= 0) this.pending.splice(idx, 1);
  };

  /** Removes and runs the entry with the smallest `ms` (FIFO among equal `ms`). */
  runNext(): void {
    if (this.pending.length === 0) throw new Error('no pending timers');
    let best = 0;
    for (let i = 1; i < this.pending.length; i += 1) {
      if (this.pending[i]!.ms < this.pending[best]!.ms) best = i;
    }
    const entry = this.pending.splice(best, 1)[0]!;
    entry.fn();
  }

  /** The `ms` values of pending entries, in insertion order. */
  delays(): number[] {
    return this.pending.map((e) => e.ms);
  }
}

export class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];

  static reset(): void {
    MockWebSocket.instances = [];
  }

  readonly url: string;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  sent: string[] = [];
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Does NOT fire onclose — the socket owner nulls its reference first. */
  close(): void {
    this.closeCalls += 1;
  }

  open(): void {
    this.onopen?.(undefined);
  }

  message(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  end(): void {
    this.onclose?.({ code: 1006 });
  }

  fail(): void {
    this.onerror?.(undefined);
  }
}

// Server-event builders: plain objects that pass ServerEvent.safeParse at runtime.
export const typingEvt = (roomId: RoomId, seq: number, userId = uid('u1')): ServerEvent =>
  ({ type: 'chat.typing', roomId, seq, ts: 1, payload: { userId, typing: true } }) as ServerEvent;

export const pongEvt = (roomId: RoomId, clientTs: number, serverTs: number): ServerEvent =>
  ({ type: 'clock.pong', roomId, seq: 0, ts: 1, payload: { clientTs, serverTs } }) as ServerEvent;

export const jsonResponse = (status: number, body: unknown): FetchResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

export class FetchMock {
  calls: { url: string; init: FetchInitLike | undefined }[] = [];
  handlers: ((
    url: string,
    init?: FetchInitLike,
  ) => FetchResponseLike | Promise<FetchResponseLike> | null)[] = [];

  impl: FetchLike = async (url, init) => {
    this.calls.push({ url, init });
    for (const handler of this.handlers) {
      const res = await handler(url, init);
      if (res !== null) return res;
    }
    throw new Error('unhandled ' + url);
  };

  count(substr: string, method?: string): number {
    return this.calls.filter(
      (c) => c.url.includes(substr) && (method === undefined || c.init?.method === method),
    ).length;
  }
}

/** Passes the contracts User schema. */
export const demoUser = (id: string) => ({
  id,
  email: null,
  displayName: 'D',
  avatarUrl: null,
  accentColor: '#aabbcc',
  createdAt: 0,
});
