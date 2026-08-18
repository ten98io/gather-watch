/**
 * Structural types describing the host platform capabilities injected into
 * this package (fetch, WebSocket, timers). No DOM or Node typings are
 * referenced; runtime globals are read lazily off `globalThis` behind narrow
 * structural casts so the package stays isomorphic.
 */

/** Minimal structural subset of the platform Response used by this package. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Minimal structural subset of the platform RequestInit used by this package. */
export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  credentials?: 'include' | 'omit' | 'same-origin';
}

/** Minimal structural fetch signature used by this package. */
export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

/** Minimal structural subset of the platform WebSocket used by this package. */
export interface WebSocketLike {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Structural constructor for a {@link WebSocketLike}. The optional
 *  `protocols` argument carries the auth subprotocol (see ws.ts): browsers,
 *  `ws` and RN's WebSocket all accept it, and a test fake written against the
 *  one-argument shape stays assignable. */
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

/** Opaque timer handle, intentionally untyped to stay platform agnostic. */
export type TimeoutHandle = unknown;

/** Structural setTimeout signature used by this package. */
export type SetTimeoutFn = (fn: () => void, ms: number) => TimeoutHandle;

/** Structural clearTimeout signature used by this package. */
export type ClearTimeoutFn = (handle: TimeoutHandle) => void;

/**
 * Lazily resolves the platform `fetch`, bound to `globalThis` (an unbound
 * browser fetch throws "Illegal invocation"). Returns `undefined` when the
 * platform has no fetch.
 */
export function defaultFetch(): FetchLike | undefined {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  return f ? (f.bind(globalThis) as FetchLike) : undefined;
}

/** Lazily resolves the platform `WebSocket` constructor, if present. */
export function defaultWebSocketCtor(): WebSocketCtor | undefined {
  return (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
}

/**
 * Default `setTimeout` that calls through to `globalThis` lazily at
 * invocation time, so timers installed later (e.g. test fakes) are honored.
 */
export const defaultSetTimeout: SetTimeoutFn = (fn, ms) =>
  (globalThis as unknown as { setTimeout: SetTimeoutFn }).setTimeout(fn, ms);

/**
 * Default `clearTimeout` that calls through to `globalThis` lazily at
 * invocation time, so timers installed later (e.g. test fakes) are honored.
 */
export const defaultClearTimeout: ClearTimeoutFn = (handle) =>
  (globalThis as unknown as { clearTimeout: ClearTimeoutFn }).clearTimeout(handle);
