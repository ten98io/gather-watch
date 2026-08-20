/**
 * RTC domain logic: short-lived TURN credentials with a strategy chain —
 * Cloudflare TURN-keys API when configured, and a STUN-only fallback when it
 * is not. Relay is unmetered for everyone. Pure logic over Deps (global fetch
 * injectable via tests stubbing it); no Fastify types here.
 *
 * Honesty constraint: STUN-only is not a degraded relay, it is NO relay —
 * links that cannot hole-punch never connect at all. So every issue reports
 * whether a relay actually came through (`relayAvailable`, read off the
 * servers on the wire) and leaves an operator-facing reading behind for
 * /admin. The two ways to have no relay — no keys, or keys that failed — are
 * identical for the caller and are deliberately reported identically to it;
 * they differ only in `AdminRelayStatus`, where the owner learns which thing
 * to fix.
 *
 * Contract conformance note: `fairUseRemainingGb` is always `null`, the
 * contract's long-standing "unmetered" value — clients (packages/p2p
 * TurnManager) already treat null as unmetered/unknown and never gate on it,
 * so the field stays on the wire purely for compatibility.
 */
import type { AdminRelayStatus, TurnCredentialsResponse } from '@gather/contracts';
import type { AuthContext, Deps } from '../types';

/** Cloudflare credential lifetime: 6 hours. */
export const TOKEN_TTL_SECONDS = 6 * 60 * 60;

const CF_TURN_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const CF_FETCH_TIMEOUT_MS = 5000;
const STUN_ONLY_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];

/**
 * How long an observed relay outcome answers for /admin before the next read
 * probes again. The owner console polls the overview every 5s; issuing a
 * Cloudflare credential per poll would be pure noise against the API, and a
 * relay's state does not change on that timescale.
 */
export const RELAY_STATUS_TTL_MS = 60_000;

/** Operator detail for a deployment carrying no relay keys at all. */
const NO_KEYS_DETAIL =
  'CF_TURN_KEY_ID / CF_TURN_API_TOKEN are unset — STUN only, no relay is offered';

/** Failure detail when a live key answers with nothing that can relay. */
const NO_RELAY_URL_DETAIL = 'cloudflare issued iceServers with no turn:/turns: URL';

/** Cap on a provider error string before it reaches an admin payload. */
const DETAIL_MAX_CHARS = 200;

type IceServer = TurnCredentialsResponse['iceServers'][number];

/** Cloudflare's TURN-keys response: iceServers as one object OR an array. */
interface CloudflareCredentialsPayload {
  iceServers?:
    | { urls?: string | string[]; username?: string; credential?: string }
    | Array<{ urls?: string | string[]; username?: string; credential?: string }>;
}

/** One credential issue, seen from the server side. */
interface RelayIssue {
  /** What the caller gets — never empty; STUN-only when no relay was issued. */
  iceServers: IceServer[];
  /** Both Cloudflare keys present in config. */
  configured: boolean;
  /** Why no relay came through, in operator words; null when one did. */
  failure: string | null;
}

/** Cloudflare's answer: servers, or the reason there are none. */
type CloudflareAttempt =
  | { servers: IceServer[]; failure: null }
  | { servers: null; failure: string };

export class RtcService {
  /**
   * Freshest reading from any credential issue — a real caller's or an admin
   * probe's. Per-Deps (one service per app instance), so /admin reports what
   * users actually got rather than a separate synthetic check.
   */
  private observed: AdminRelayStatus | null = null;

  constructor(private readonly deps: Deps) {}

  /**
   * ICE servers for the caller. Strategy chain: Cloudflare → STUN-only.
   * Relay is unmetered for every account, so `fairUseRemainingGb` is always
   * `null`.
   */
  async turnCredentials(auth: AuthContext): Promise<TurnCredentialsResponse> {
    const { issue } = await this.issueRelay(auth.userId);
    return {
      iceServers: issue.iceServers,
      ttlSeconds: TOKEN_TTL_SECONDS,
      fairUseRemainingGb: null,
      // Read off the servers actually being returned, not off config: a key
      // that failed to issue leaves THIS caller as relay-less as no key at
      // all, and the client has to be told the same thing in both cases.
      relayAvailable: hasRelayUrl(issue.iceServers),
    };
  }

  /**
   * The relay's real state for the owner console. Config cannot answer this —
   * a revoked or misspelled key reads exactly like a working one until it is
   * spent — and the question is only useful BEFORE a call, so an unconfigured
   * deployment answers instantly and a configured one is probed for real,
   * reusing a recent observation rather than issuing per poll.
   */
  async relayStatus(identifier: string): Promise<AdminRelayStatus> {
    const { cloudflare } = this.deps.config;
    if (cloudflare.turnKeyId === null || cloudflare.turnApiToken === null) {
      return { state: 'not-configured', detail: NO_KEYS_DETAIL, checkedAt: Date.now() };
    }
    const observed = this.observed;
    if (observed !== null && Date.now() - observed.checkedAt < RELAY_STATUS_TTL_MS) {
      return observed;
    }
    const { status } = await this.issueRelay(identifier);
    return status;
  }

  /** One issue plus its operator reading; every issue refreshes `observed`. */
  private async issueRelay(
    identifier: string,
  ): Promise<{ issue: RelayIssue; status: AdminRelayStatus }> {
    const issue = await this.attemptRelay(identifier);
    const status = relayStatusOf(issue, Date.now());
    this.observed = status;
    return { issue, status };
  }

  /** Cloudflare when configured, STUN-only otherwise. Never throws. */
  private async attemptRelay(identifier: string): Promise<RelayIssue> {
    const { cloudflare } = this.deps.config;
    if (cloudflare.turnKeyId === null || cloudflare.turnApiToken === null) {
      return { iceServers: stunOnly(), configured: false, failure: null };
    }
    const attempt = await this.cloudflareIceServers(
      cloudflare.turnKeyId,
      cloudflare.turnApiToken,
      identifier,
    );
    if (attempt.servers === null) {
      return { iceServers: stunOnly(), configured: true, failure: attempt.failure };
    }
    // A live key answering with only stun: URLs is an operator problem, not a
    // caller problem: the servers are still handed over (they are no worse
    // than the fallback), while /admin reads the issue as failing.
    return {
      iceServers: attempt.servers,
      configured: true,
      failure: hasRelayUrl(attempt.servers) ? null : NO_RELAY_URL_DETAIL,
    };
  }

  /**
   * Cloudflare TURN-keys API: short-lived credentials scoped to the account's
   * TURN key. Every failure path (network, HTTP, payload) is logged AND
   * returned as a distinct reason string — swallowing them into one silent
   * null is what made "no keys" and "keys that do not work" look alike.
   */
  private async cloudflareIceServers(
    keyId: string,
    apiToken: string,
    identifier: string,
  ): Promise<CloudflareAttempt> {
    try {
      // `/credentials/generate-ice-servers`, and the suffix is LOAD-BEARING.
      // The bare `/credentials` path this used to call is not Cloudflare's
      // credential endpoint at all — it answers `405 reserved for future
      // WHIP/WHEP` — so every fetch failed, the warn below fired into a log
      // nobody watches, and the service silently served STUN-only. TURN never
      // worked from this codebase, with or without keys; "set the keys" was
      // handed down through two sessions as the fix for voice dropouts and
      // could not have fixed them. Verified against the live API 2026-08-20:
      // this path answers 201 with the full transport set (UDP, TCP, port 53,
      // TCP/80 and TLS/443 relays) — the 80/443 variants being the ones that
      // reach through exactly the restrictive networks a relay exists for.
      const response = await fetch(`${CF_TURN_ENDPOINT}/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
        },
        // customIdentifier tags the credential with the requesting user so
        // relay usage stays attributable per user in Cloudflare analytics —
        // abuse review only; nothing is metered or capped against it.
        body: JSON.stringify({ ttl: TOKEN_TTL_SECONDS, customIdentifier: identifier }),
        signal: AbortSignal.timeout(CF_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.deps.log.warn({ status: response.status }, 'cloudflare TURN credentials failed');
        return {
          servers: null,
          failure: `cloudflare TURN-keys API returned HTTP ${response.status}`,
        };
      }
      const payload = (await response.json()) as CloudflareCredentialsPayload;
      const servers = normalizeCloudflareServers(payload);
      if (servers.length === 0) {
        this.deps.log.warn('cloudflare TURN credentials payload had no usable iceServers');
        return {
          servers: null,
          failure: 'cloudflare TURN-keys API returned no usable iceServers',
        };
      }
      return { servers, failure: null };
    } catch (err) {
      this.deps.log.warn({ err }, 'cloudflare TURN credentials request failed');
      const failure = `cloudflare TURN-keys API request failed: ${reason(err)}`;
      return { servers: null, failure };
    }
  }
}

/** Fresh copies — callers own the array they are handed. */
function stunOnly(): IceServer[] {
  return STUN_ONLY_SERVERS.map((s) => ({ ...s }));
}

/** A relay is a turn:/turns: URL. A stun: URL only reflects an address back:
 *  it cannot carry a byte when hole-punching fails, so it never counts. */
function hasRelayUrl(servers: readonly IceServer[]): boolean {
  return servers.some((server) => server.urls.some((url) => /^turns?:/i.test(url)));
}

/** Provider error text, bounded — it lands in an admin payload verbatim. */
function reason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, DETAIL_MAX_CHARS);
}

/** The operator reading of one issue. 'failing' and 'not-configured' are the
 *  same experience for a caller behind a symmetric NAT — no relay, no call —
 *  and are split here only because they need different fixes. */
function relayStatusOf(issue: RelayIssue, at: number): AdminRelayStatus {
  if (!issue.configured) {
    return { state: 'not-configured', detail: NO_KEYS_DETAIL, checkedAt: at };
  }
  if (issue.failure !== null) {
    return { state: 'failing', detail: issue.failure, checkedAt: at };
  }
  return { state: 'ok', detail: null, checkedAt: at };
}

/** Map Cloudflare's payload (object or array, urls string or string[]) onto
 *  the contract's iceServers shape, dropping malformed entries. */
function normalizeCloudflareServers(payload: CloudflareCredentialsPayload): IceServer[] {
  const raw = payload.iceServers;
  if (raw === undefined) {
    return [];
  }
  const entries = Array.isArray(raw) ? raw : [raw];
  const servers: IceServer[] = [];
  for (const entry of entries) {
    const urls = typeof entry.urls === 'string' ? [entry.urls] : (entry.urls ?? []);
    if (urls.length === 0) {
      continue;
    }
    // exactOptionalPropertyTypes: only set username/credential when present.
    servers.push({
      urls,
      ...(entry.username !== undefined ? { username: entry.username } : {}),
      ...(entry.credential !== undefined ? { credential: entry.credential } : {}),
    });
  }
  return servers;
}
