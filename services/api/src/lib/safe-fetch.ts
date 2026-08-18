/**
 * SSRF-hardened outbound HTTP for every server-initiated fetch of a
 * user-supplied URL (chat link previews, media metadata resolution).
 *
 * The rules, in one place so no caller can forget one:
 *   • http/https only, and every hop — the initial URL and each redirect
 *     target — is re-validated (redirects are followed MANUALLY).
 *   • hostnames are resolved and every returned address is checked against
 *     `isPrivateIp`; anything private/reserved/unparseable is refused.
 *   • DNS-rebinding defence: the vetted addresses are PINNED — the default
 *     fetch dials through an undici Agent whose connect-time lookup only ever
 *     returns what the guard resolved (fail closed on anything else), so an
 *     attacker DNS server cannot answer public-to-the-check and
 *     private-to-the-connect.
 *   • optional `hostAllowlist` for fixed, known endpoints (provider metadata
 *     APIs): a hop to any other host is refused before a socket is opened.
 *   • one deadline across all hops, and a hard byte cap on the body.
 *
 * Every `.catch(() => {})` in this file is body TEARDOWN — cancelling a
 * response we have already decided to discard. None of them sits on a fetch or
 * a read; those two are caught explicitly and converted to AppError. Each
 * teardown site says at the call why a rejection there changes nothing, so a
 * swallow added on a real failure path stands out as the undocumented one.
 *
 * Injecting `fetchImpl` bypasses pinning and `allowPrivateAddresses` skips the
 * address guard entirely; BOTH exist for tests only. Every failure surfaces as
 * AppError('VALIDATION') — this module never throws anything else on purpose.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { AppError } from './errors';

export interface ResolvedAddress {
  address: string;
  family: number;
}
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeFetchOptions {
  allowPrivateAddresses?: boolean; // default false — ONLY tests set true
  timeoutMs?: number; // default 3000 (one deadline across all redirects)
  maxBytes?: number; // default 512 * 1024
  maxRedirects?: number; // default 3
  fetchImpl?: typeof fetch; // default globalThis.fetch
  lookupImpl?: LookupFn; // default node:dns/promises lookup(hostname, { all: true })
  /**
   * Exact, lowercased hostnames this fetcher may reach — enforced on EVERY
   * hop. Undefined means "any public host" (the link-preview case).
   */
  hostAllowlist?: readonly string[];
  userAgent?: string; // default 'gather-unfurl/1.0'
  /** Prefix for operation-scoped failure messages. Default 'unfurl'. */
  label?: string;
}

export interface SafeFetchRequest {
  /** Accept header. Default 'text/html,*\/*;q=0.5'. */
  accept?: string;
  /**
   * Substring the response content-type must contain before the body is read.
   * A mismatch cancels the body and returns `bodyRead: false` — a 500 MB video
   * is never downloaded to look for a <title>.
   */
  expectContentType?: string;
}

export interface SafeFetchResult {
  /** Final URL after redirects — always a vetted one. */
  url: URL;
  status: number;
  contentType: string | null;
  /** Body decoded as UTF-8 and truncated at maxBytes; '' when not read. */
  text: string;
  bodyRead: boolean;
}

export interface SafeFetcher {
  /** Validate one URL (scheme, allowlist, private addresses) without fetching. */
  guard(raw: string): Promise<URL>;
  fetch(rawUrl: string, request?: SafeFetchRequest): Promise<SafeFetchResult>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * connect-time lookup that ONLY hands out addresses already vetted by the
 * guard. FAIL CLOSED: a hostname with no pinned entry is a connection error,
 * never a fresh DNS query. Handles both node lookup callback shapes
 * (`all: true` -> array, otherwise (address, family)).
 */
export type PinnedLookup = (
  hostname: string,
  options: { all?: boolean; family?: number | string },
  callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
) => void;

export function createPinnedLookup(
  pinned: ReadonlyMap<string, readonly ResolvedAddress[]>,
): PinnedLookup {
  return (hostname, options, callback) => {
    const vetted = pinned.get(hostname.toLowerCase()) ?? [];
    const family = options.family === 4 || options.family === 6 ? options.family : null;
    const usable = family === null ? vetted : vetted.filter((a) => a.family === family);
    const first = usable[0];
    if (first === undefined) {
      callback(new Error(`no vetted address for ${hostname}`));
      return;
    }
    if (options.all === true) {
      callback(
        null,
        usable.map((a) => ({ address: a.address, family: a.family })),
      );
      return;
    }
    callback(null, first.address, first.family);
  };
}

/** A fetch whose sockets resolve exclusively through the `pinned` map. */
export function createPinningFetch(
  pinned: ReadonlyMap<string, readonly ResolvedAddress[]>,
): typeof fetch {
  const agent = new Agent({
    connect: { lookup: createPinnedLookup(pinned) as unknown as LookupFunction },
  });
  const pinnedFetch = (input: string | URL, init?: RequestInit): Promise<Response> =>
    undiciFetch(input as never, {
      ...(init as object),
      dispatcher: agent,
    } as never) as unknown as Promise<Response>;
  return pinnedFetch as unknown as typeof fetch;
}

function privateAddressError(): AppError {
  return new AppError('VALIDATION', 'url resolves to a private address');
}

/**
 * True when `ip` is private/reserved — FAIL CLOSED: anything unparseable
 * counts as private. Covers IPv4 RFC1918/loopback/link-local/CGNAT/
 * documentation/multicast ranges plus IPv6 loopback, ULA, link-local,
 * v4-mapped (recursed on the v4 tail) and NAT64 prefixes.
 */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const octets = ip.split('.').map((part) => Number(part));
    const a = octets[0];
    const b = octets[1];
    const c = octets[2];
    if (a === undefined || b === undefined || c === undefined) {
      return true;
    }
    if (a === 0 || a >= 224) return true;
    if (a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (isIP(lower) !== 6) {
    return true; // fail closed
  }
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) {
    // v4-mapped — decide on the embedded v4 address.
    return isPrivateIp(lower.slice('::ffff:'.length));
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
  if (lower.startsWith('64:ff9b:')) return true; // NAT64 can smuggle v4
  return false;
}

/**
 * Build a fetcher bound to one set of guard options. Create one per call site
 * (link previews, provider metadata) — never share a permissive one.
 */
export function createSafeFetcher(options: SafeFetchOptions = {}): SafeFetcher {
  const allowPrivate = options.allowPrivateAddresses ?? false;
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const userAgent = options.userAgent ?? 'gather-unfurl/1.0';
  const label = options.label ?? 'unfurl';
  const allowlist =
    options.hostAllowlist === undefined
      ? null
      : new Set(options.hostAllowlist.map((host) => host.toLowerCase()));
  // hostname (lowercased) -> the exact addresses the guard vetted. The
  // default fetch dials ONLY through this map (see createPinningFetch);
  // allowPrivate skips vetting, so it falls back to the plain global fetch
  // (test-only mode, documented above).
  const pinned = new Map<string, ResolvedAddress[]>();
  const fetchImpl =
    options.fetchImpl ?? (allowPrivate ? globalThis.fetch : createPinningFetch(pinned));
  const lookupImpl: LookupFn =
    options.lookupImpl ?? (async (hostname) => dnsLookup(hostname, { all: true }));
  const pin = (hostname: string, addresses: readonly ResolvedAddress[]): void => {
    if (pinned.size > 256 && !pinned.has(hostname.toLowerCase())) {
      pinned.clear(); // hard bound; every entry is vetted-public anyway
    }
    pinned.set(hostname.toLowerCase(), [...addresses]);
  };

  /** Validate one hop: scheme, allowlist, localhost, private addresses. */
  const guard = async (raw: string): Promise<URL> => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new AppError('VALIDATION', 'only http/https urls can be fetched');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('VALIDATION', 'only http/https urls can be fetched');
    }
    let hostname = url.hostname.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1); // IPv6 literal brackets
    }
    // The allowlist is checked BEFORE (and independently of) the address
    // guard, so it holds even in the test-only allowPrivate mode.
    if (allowlist !== null && !allowlist.has(hostname)) {
      throw new AppError('VALIDATION', 'host is not allowed');
    }
    if (allowPrivate) {
      return url;
    }
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw privateAddressError();
    }
    if (isIP(hostname) !== 0) {
      if (isPrivateIp(hostname)) {
        throw privateAddressError();
      }
      pin(hostname, [{ address: hostname, family: isIP(hostname) }]);
      return url;
    }
    let addresses: ResolvedAddress[];
    try {
      addresses = await lookupImpl(hostname);
    } catch {
      throw new AppError('VALIDATION', 'could not resolve host');
    }
    if (addresses.length === 0) {
      throw new AppError('VALIDATION', 'could not resolve host');
    }
    for (const address of addresses) {
      if (isPrivateIp(address.address)) {
        throw privateAddressError();
      }
    }
    pin(hostname, addresses);
    return url;
  };

  const run = async (rawUrl: string, request: SafeFetchRequest): Promise<SafeFetchResult> => {
    const accept = request.accept ?? 'text/html,*/*;q=0.5';
    const expectContentType = request.expectContentType;
    // One deadline across the whole operation (all redirect hops).
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    timer.unref();

    try {
      let current = rawUrl;
      for (let hops = 0; ; hops += 1) {
        const url = await guard(current);

        let response: Response;
        try {
          response = await fetchImpl(url.toString(), {
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'user-agent': userAgent, accept },
          });
        } catch (_err) {
          if (controller.signal.aborted) {
            throw new AppError('VALIDATION', `${label} timed out`);
          }
          throw new AppError('VALIDATION', `${label} failed`);
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location');
          if (location !== null) {
            if (hops + 1 > maxRedirects) {
              throw new AppError('VALIDATION', 'too many redirects');
            }
            // Free the 3xx body before dialling the next hop. The fetch itself
            // already succeeded and `location` is the only thing we wanted, so
            // a cancel() rejection tells us nothing and must not abort a
            // redirect chain that is otherwise fine. Failing loudly here would
            // turn a harmless already-closed stream into a refused unfurl.
            await response.body?.cancel().catch(() => {});
            try {
              current = new URL(location, url).toString();
            } catch {
              throw new AppError('VALIDATION', `${label} failed`);
            }
            continue; // the guard re-validates the redirect target
          }
        }

        if (response.status < 200 || response.status >= 300) {
          throw new AppError('VALIDATION', `${label} target returned ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        const unread: SafeFetchResult = {
          url,
          status: response.status,
          contentType,
          text: '',
          bodyRead: false,
        };

        if (
          expectContentType !== undefined &&
          contentType !== null &&
          !contentType.includes(expectContentType)
        ) {
          // Wrong content-type: `unread` is already the full answer, and the
          // cancel exists only so a 500 MB video is not pulled down to look
          // for a <title>. Whether the stream tears down cleanly cannot change
          // what we return, so a rejection is swallowed rather than promoted
          // into a failure the caller would have to handle.
          await response.body?.cancel().catch(() => {});
          return unread;
        }
        if (response.body === null) {
          return unread;
        }

        // Read at most maxBytes, then cancel and decode the truncated buffer —
        // a huge page still yields its first chunk.
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            let done: boolean;
            let value: Uint8Array | undefined;
            try {
              ({ done, value } = await reader.read());
            } catch (_err) {
              if (controller.signal.aborted) {
                throw new AppError('VALIDATION', `${label} timed out`);
              }
              throw new AppError('VALIDATION', `${label} failed`);
            }
            if (done) {
              break;
            }
            if (value !== undefined) {
              chunks.push(value);
              total += value.byteLength;
              if (total >= maxBytes) {
                // Cap reached — every byte we intend to decode is already in
                // `chunks`, so this cancel is teardown of a stream we are done
                // with. Letting it reject would throw away a body that was
                // read SUCCESSFULLY and report the truncation as an error.
                // Read failures are a different thing entirely and are caught
                // around reader.read() a few lines up.
                await reader.cancel().catch(() => {});
                break;
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        const bytes = new Uint8Array(Math.min(total, maxBytes));
        let offset = 0;
        for (const chunk of chunks) {
          const slice = chunk.subarray(0, Math.min(chunk.byteLength, bytes.byteLength - offset));
          bytes.set(slice, offset);
          offset += slice.byteLength;
        }

        return {
          url,
          status: response.status,
          contentType,
          text: new TextDecoder().decode(bytes),
          bodyRead: true,
        };
      }
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    guard,
    fetch: (rawUrl, request = {}) => run(rawUrl, request),
  };
}
