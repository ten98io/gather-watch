import { ApiError, RestClient } from '@playin/api-client';
import type { FetchInitLike, FetchLike } from '@playin/api-client';
import {
  ApiError as ApiErrorPayload,
  GuestJoinResponse,
  RefreshResponse,
  RequestMagicLinkResponse,
  VerifyTokenResponse,
} from '@playin/contracts';
import type { GuestJoinBody, User } from '@playin/contracts';
import { z } from 'zod';

/** Parse an error body with the contracts schema, else fall back to status. */
function errorFromBody(data: unknown, text: string, status: number): ApiError {
  const parsed = ApiErrorPayload.safeParse(data);
  if (parsed.success) {
    const { code, message, refType } = parsed.data;
    return refType === undefined
      ? new ApiError(code, message, status)
      : new ApiError(code, message, status, refType);
  }
  const message = text.length > 0 ? text : `HTTP ${status}`;
  const code =
    status === 401
      ? 'UNAUTHORIZED'
      : status === 403
        ? 'FORBIDDEN'
        : status === 404
          ? 'NOT_FOUND'
          : status === 409
            ? 'CONFLICT'
            : status === 429
              ? 'RATE_LIMITED'
              : status === 400 || status === 422
                ? 'VALIDATION'
                : 'INTERNAL';
  return new ApiError(code, message, status);
}

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
/** Room websocket endpoint (services/api mounts it at /ws). */
export const WS_URL = `${API_URL.replace(/^http/i, (m) => (m === 'https' ? 'wss' : 'ws'))}/ws`;

/* ────────────────────────────────────────────────────────────────────────────
   Access-token store. The durable credential is the httpOnly `playin_rt`
   refresh cookie (scoped to /auth); the short-lived access JWT is returned in
   response BODIES — which the contracts zod schemas strip on parse — so the
   token is captured here via raw fetch, kept in memory only (never
   localStorage), and attached through RestClient's getAccessToken hook.
   ──────────────────────────────────────────────────────────────────────────── */

const wireTokens = {
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.number().int().nonnegative(),
};

const VerifyTokenWire = VerifyTokenResponse.extend(wireTokens);
const RefreshWire = RefreshResponse.extend(wireTokens);
const GuestJoinWire = GuestJoinResponse.extend(wireTokens);
const MagicLinkWire = RequestMagicLinkResponse.extend({
  devLink: z.string().min(1).optional(),
});

export interface AuthSession {
  user: User;
  accessToken: string;
  accessTokenExpiresAt: number;
}

export type GuestJoinResult = z.infer<typeof GuestJoinWire>;

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;

/** The current in-memory access token, or null when signed out. */
export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string, expiresAt: number): void {
  accessToken = token;
  accessTokenExpiresAt = expiresAt;
}

export function clearAccessToken(): void {
  accessToken = null;
  accessTokenExpiresAt = 0;
}

function stash(session: AuthSession): AuthSession {
  setAccessToken(session.accessToken, session.accessTokenExpiresAt);
  return session;
}

/* ── Raw auth transport (captures the body-carried tokens RestClient strips) ── */

async function rawPost<T>(path: string, body: unknown, schema: { parse(v: unknown): T }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('INTERNAL', `network error calling ${path}`);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError('INTERNAL', `invalid response from ${path}`, res.status);
  }
  if (!res.ok) {
    throw errorFromBody(data, text, res.status);
  }
  try {
    return schema.parse(data);
  } catch {
    throw new ApiError('VALIDATION', `invalid response from ${path}`, res.status);
  }
}

/** POST /auth/magic-link. In dev the API echoes the link back as `devLink`. */
export async function requestMagicLink(email: string): Promise<{ devLink: string | null }> {
  const res = await rawPost('/auth/magic-link', { email }, MagicLinkWire);
  return { devLink: res.devLink ?? null };
}

/** POST /auth/verify — exchanges the magic-link token for a session. */
export async function verifyToken(token: string): Promise<AuthSession> {
  return stash(await rawPost('/auth/verify', { token }, VerifyTokenWire));
}

/** POST /auth/guest — invite-code guest join; room-scoped identity. */
export async function guestJoin(body: GuestJoinBody): Promise<GuestJoinResult> {
  const res = await rawPost('/auth/guest', body, GuestJoinWire);
  setAccessToken(res.accessToken, res.accessTokenExpiresAt);
  return res;
}

/* ── Refresh (single-flight) ── */

const REFRESH_SKEW_MS = 30_000;
let refreshInFlight: Promise<AuthSession | null> | null = null;

async function doRefresh(): Promise<AuthSession | null> {
  try {
    return stash(await rawPost('/auth/refresh', {}, RefreshWire));
  } catch {
    clearAccessToken();
    return null;
  }
}

/** Exchange the refresh cookie for a fresh access token + user. Single-flight. */
export function refreshSession(): Promise<AuthSession | null> {
  if (refreshInFlight === null) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * RestClient token provider: returns the in-memory token while it is fresh,
 * otherwise refreshes via the httpOnly cookie. Returns null when signed out.
 */
export async function ensureAccessToken(): Promise<string | null> {
  if (accessToken !== null && accessTokenExpiresAt - Date.now() > REFRESH_SKEW_MS) {
    return accessToken;
  }
  const session = await refreshSession();
  return session === null ? null : session.accessToken;
}

/* ── Auth-expired broadcast (RestClient fires this after a failed refresh) ── */

const authExpiredHandlers = new Set<() => void>();

export function onAuthExpired(cb: () => void): () => void {
  authExpiredHandlers.add(cb);
  return () => {
    authExpiredHandlers.delete(cb);
  };
}

function emitAuthExpired(): void {
  clearAccessToken();
  for (const cb of [...authExpiredHandlers]) {
    try {
      cb();
    } catch {
      // A bad listener must not break the client.
    }
  }
}

/* ── captureFetch: makes RestClient's 401→refresh→replay path actually work.
   The frozen RestClient's doRefresh POSTs /auth/refresh but DISCARDS the
   rotated access token in the body (packages/api-client rest.ts doRefresh
   returns res.ok only), and the replay re-asks getAccessToken — which would
   return the same stale in-memory token because its local expiry still looks
   fresh. Intercepting the refresh response here (mirror of mobile's
   captureFetch) stashes the fresh token BEFORE the replay asks for it, so
   server-side rejections of a locally-"fresh" token (sign-out-everywhere,
   secret rotation, clock skew) recover instead of failing until natural
   expiry. ── */

const captureFetch: FetchLike = async (url, init?: FetchInitLike) => {
  const res = await fetch(url, init as RequestInit);
  if (res.ok && url.startsWith(API_URL)) {
    let pathname: string | null = null;
    try {
      pathname = new URL(url).pathname;
    } catch {
      // Relative/odd URL — RestClient always passes absolute ones.
    }
    if (pathname === '/auth/refresh') {
      try {
        const data = (await res.clone().json()) as {
          accessToken?: unknown;
          accessTokenExpiresAt?: unknown;
        };
        if (
          typeof data.accessToken === 'string' &&
          typeof data.accessTokenExpiresAt === 'number'
        ) {
          setAccessToken(data.accessToken, data.accessTokenExpiresAt);
        }
      } catch {
        // Non-JSON refresh response — nothing to capture.
      }
    }
  }
  return res;
};

/** The shared REST client. Auth travels via the httpOnly cookie + the
 *  in-memory access token above; nothing is persisted to web storage. */
export const api = new RestClient(API_URL, {
  fetchImpl: captureFetch,
  getAccessToken: ensureAccessToken,
  onAuthExpired: emitAuthExpired,
});

/* ── apiFetch: typed raw calls for endpoints outside RestClient's surface
      (sessions, billing, GDPR). Same auth rules as the RestClient. ── */

export async function apiFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown; schema: { parse(v: unknown): T } },
  retried = false,
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = await ensureAccessToken();
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      credentials: 'include',
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  } catch {
    throw new ApiError('INTERNAL', `network error calling ${path}`);
  }

  if (res.status === 401) {
    // One replay only (matches RestClient's `retried` flag): a route-level
    // authz bug must not loop refresh→retry forever, burning refresh
    // rotations on every pass.
    if (retried) {
      emitAuthExpired();
      throw new ApiError('UNAUTHORIZED', 'session expired', 401);
    }
    const session = await refreshSession();
    if (session === null) {
      emitAuthExpired();
      throw new ApiError('UNAUTHORIZED', 'session expired', 401);
    }
    return apiFetch(path, opts, true);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError('INTERNAL', `invalid response from ${path}`, res.status);
    }
  }
  if (!res.ok) {
    throw errorFromBody(data, text, res.status);
  }
  return opts.schema.parse(data);
}
