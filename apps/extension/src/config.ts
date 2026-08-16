/**
 * Build-time endpoint config. The MV3 bundles cannot read env at runtime, so
 * the API origin is inlined by tsup's `define` from PLAYIN_API_URL:
 *
 *   PLAYIN_API_URL=https://api.playin.app pnpm --filter ./apps/extension build
 *
 * Unset builds keep the localhost dev default, so `pnpm dev` is unchanged.
 */

/** Injected by tsup define; falls back for typecheck/test where it is absent. */
declare const __PLAYIN_API_URL__: string | undefined;
/**
 * Comma-separated web origins allowed to talk to this extension over the
 * externally-connectable channel. Injected the same way:
 *
 *   PLAYIN_WEB_ORIGINS=https://playin.app,https://www.playin.app pnpm … build
 *
 * MUST stay a subset of `externally_connectable.matches` in the manifest —
 * the manifest is the browser-level gate, this list is the second, in-code
 * gate that every message is re-checked against (see external.ts).
 */
declare const __PLAYIN_WEB_ORIGINS__: string | undefined;

export const DEFAULT_API_URL = 'http://localhost:4000';

/** http(s) origin → the room WebSocket URL (mirrors apps/web/lib/api.ts). */
export function wsUrlFor(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/+$/, '');
  return `${trimmed.replace(/^http/, 'ws')}/ws`;
}

export const API_URL =
  typeof __PLAYIN_API_URL__ === 'string' && __PLAYIN_API_URL__.length > 0
    ? __PLAYIN_API_URL__.replace(/\/+$/, '')
    : DEFAULT_API_URL;

export const WS_URL = wsUrlFor(API_URL);

/** The API origin the room token may ever be sent to (scheme + host + port). */
export const API_ORIGIN = originOfUrl(API_URL) ?? API_URL;

/** http(s) URL → bare origin, lowercased. null when it is not an http(s) URL. */
export function originOfUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin.toLowerCase();
}

/**
 * Web origins allowed to drive this extension. Localhost:3000 is the Next dev
 * server; the production origins are explicit — no subdomain wildcard, so a
 * forgotten or hijacked `*.playin.app` host cannot reach the extension.
 */
export const DEFAULT_WEB_ORIGINS: readonly string[] = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://playin.app',
  'https://www.playin.app',
  'https://app.playin.app',
];

/** Parse the build-time origin list; drops anything that is not an http(s)
 *  origin so a typo fails closed rather than widening the allowlist. */
export function parseWebOrigins(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const origin = originOfUrl(part.trim());
    if (origin !== null && !out.includes(origin)) out.push(origin);
  }
  return out;
}

const configuredWebOrigins = parseWebOrigins(
  typeof __PLAYIN_WEB_ORIGINS__ === 'string' ? __PLAYIN_WEB_ORIGINS__ : undefined,
);

export const WEB_ORIGINS: readonly string[] =
  configuredWebOrigins.length > 0
    ? configuredWebOrigins
    : DEFAULT_WEB_ORIGINS.map((o) => originOfUrl(o) ?? o);
