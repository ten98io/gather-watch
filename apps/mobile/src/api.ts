/**
 * RestClient wired for React Native.
 *
 * AUTH TRANSPORT FINDING (services/api/src/plugins/auth.ts + modules/auth/routes.ts):
 *  - The api authenticates REST + WS exclusively via `Authorization: Bearer
 *    <accessToken>`. Cookies are NOT read for authentication.
 *  - The ONLY cookie is `gather_rt` (httpOnly, path=/auth) carrying the
 *    refresh token; `/auth/refresh` reads it from the Cookie header.
 *  - `/auth/verify`, `/auth/guest`, `/auth/refresh` return
 *    `{ accessToken, accessTokenExpiresAt }` in the body, but the contracts
 *    response schemas (VerifyTokenResponse / GuestJoinResponse / RefreshResponse)
 *    strip those keys during zod parsing, so RestClient's typed methods never
 *    expose the token.
 *
 * Therefore on RN (`credentials: 'omit'`, no cookie jar):
 *  1. `getAccessToken` reads the access token from expo-secure-store — Bearer
 *     works for every endpoint including the WS handshake token.
 *  2. `captureFetch` (below) intercepts the raw JSON of the three
 *     token-issuing endpoints BEFORE zod strips it and persists the access
 *     token + expiry; it also scrapes the `gather_rt` Set-Cookie (readable in
 *     RN, unlike browsers) into secure store.
 *  3. On `/auth/refresh` requests it re-attaches `Cookie: gather_rt=…`
 *     manually. This is the documented "tiny fetch wrapper" — the api DOES
 *     support Bearer, only the refresh *transport* is cookie-bound.
 */
import * as SecureStore from 'expo-secure-store';
import { RestClient } from '@gather/api-client';
import type { FetchInitLike, FetchLike, FetchResponseLike } from '@gather/api-client';
import { API_URL } from './config';

const KEY_ACCESS = 'gather.accessToken';
const KEY_ACCESS_EXP = 'gather.accessTokenExpiresAt';
const KEY_REFRESH = 'gather.refreshToken';

const RT_COOKIE = 'gather_rt';

/** In-memory mirror of the secure store so `getAccessToken` stays cheap. */
let memoryAccessToken: string | null = null;
let memoryAccessExpiresAt = 0;
let memoryRefreshToken: string | null = null;
/** Dev convenience: the api echoes the magic link in development responses. */
let lastDevLink: string | null = null;

function persist(key: string, value: string): void {
  // Fire-and-forget: memory copy is authoritative within the session; a
  // failed persist only means the next cold start re-authenticates.
  void SecureStore.setItemAsync(key, value).catch(() => undefined);
}

function wipe(key: string): void {
  void SecureStore.deleteItemAsync(key).catch(() => undefined);
}

export const tokenStore = {
  /** Load persisted tokens into memory. Call once at app boot. */
  async hydrate(): Promise<void> {
    const [access, exp, refresh] = await Promise.all([
      SecureStore.getItemAsync(KEY_ACCESS).catch(() => null),
      SecureStore.getItemAsync(KEY_ACCESS_EXP).catch(() => null),
      SecureStore.getItemAsync(KEY_REFRESH).catch(() => null),
    ]);
    memoryAccessToken = access;
    memoryAccessExpiresAt = exp !== null ? Number(exp) || 0 : 0;
    memoryRefreshToken = refresh;
  },
  getAccessToken(): string | null {
    return memoryAccessToken;
  },
  accessTokenExpiresAt(): number {
    return memoryAccessExpiresAt;
  },
  /** True when a token exists and is valid for at least `skewMs` longer. */
  hasValidAccessToken(skewMs = 10_000): boolean {
    return memoryAccessToken !== null && memoryAccessExpiresAt > Date.now() + skewMs;
  },
  getRefreshToken(): string | null {
    return memoryRefreshToken;
  },
  setTokens(accessToken: string, accessTokenExpiresAt: number, refreshToken: string | null): void {
    memoryAccessToken = accessToken;
    memoryAccessExpiresAt = accessTokenExpiresAt;
    persist(KEY_ACCESS, accessToken);
    persist(KEY_ACCESS_EXP, String(accessTokenExpiresAt));
    if (refreshToken !== null) {
      memoryRefreshToken = refreshToken;
      persist(KEY_REFRESH, refreshToken);
    }
  },
  clear(): void {
    memoryAccessToken = null;
    memoryAccessExpiresAt = 0;
    memoryRefreshToken = null;
    wipe(KEY_ACCESS);
    wipe(KEY_ACCESS_EXP);
    wipe(KEY_REFRESH);
  },
  /** Last magic-link echo from a development-mode api; null in production. */
  consumeDevLink(): string | null {
    const link = lastDevLink;
    lastDevLink = null;
    return link;
  },
};

type AuthCaptureBody = {
  accessToken?: unknown;
  accessTokenExpiresAt?: unknown;
  devLink?: unknown;
};

function isTokenIssuingPath(url: string): boolean {
  return /\/auth\/(verify|guest|refresh)$/.test(url);
}

function scrapeRefreshCookie(res: FetchResponseLike): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) return null;
  const m = new RegExp(`${RT_COOKIE}=([^;]+)`).exec(setCookie);
  return m?.[1] ?? null;
}

/**
 * Fetch wrapper implementing the RN auth transport described above. Returned
 * responses for token-issuing endpoints replay the already-parsed JSON (the
 * raw stream is consumed once here).
 */
export const captureFetch: FetchLike = async (url, init) => {
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };

  // RN has no cookie jar: re-attach the refresh token manually on /auth/refresh.
  if (url.endsWith('/auth/refresh') && memoryRefreshToken !== null) {
    headers['cookie'] = `${RT_COOKIE}=${memoryRefreshToken}`;
  }

  const requestInit: FetchInitLike = { ...init, headers };
  const res = await fetch(url, requestInit as RequestInit);

  if (!res.ok) return res;

  if (isTokenIssuingPath(url)) {
    const data: unknown = await res.json();
    if (typeof data === 'object' && data !== null) {
      const body = data as AuthCaptureBody;
      if (typeof body.accessToken === 'string' && typeof body.accessTokenExpiresAt === 'number') {
        tokenStore.setTokens(body.accessToken, body.accessTokenExpiresAt, scrapeRefreshCookie(res));
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    };
  }

  if (url.endsWith('/auth/magic-link')) {
    const data: unknown = await res.json();
    if (typeof data === 'object' && data !== null) {
      const link = (data as AuthCaptureBody).devLink;
      if (typeof link === 'string') lastDevLink = link;
    }
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    };
  }

  return res;
};

let authExpiredHandler: (() => void) | null = null;

/** Registered by AuthProvider: fired when a 401 survives the refresh retry. */
export function setAuthExpiredHandler(handler: (() => void) | null): void {
  authExpiredHandler = handler;
}

/** App-wide REST client singleton (Bearer from secure store, no cookies). */
export const api = new RestClient(API_URL, {
  fetchImpl: captureFetch,
  credentials: 'omit',
  getAccessToken: () => tokenStore.getAccessToken(),
  onAuthExpired: () => authExpiredHandler?.(),
});
