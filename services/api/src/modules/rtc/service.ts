/**
 * RTC domain logic: short-lived TURN credentials with a strategy chain —
 * Cloudflare TURN-keys API when configured, and a STUN-only fallback when it
 * is not. Relay is unmetered for everyone. Pure logic over Deps (global fetch
 * injectable via tests stubbing it); no Fastify types here.
 *
 * Contract conformance note: `fairUseRemainingGb` is always `null`, the
 * contract's long-standing "unmetered" value — clients (packages/p2p
 * TurnManager) already treat null as unmetered/unknown and never gate on it,
 * so the field stays on the wire purely for compatibility.
 */
import type { TurnCredentialsResponse } from '@gather/contracts';
import type { AuthContext, Deps } from '../types';

/** Cloudflare credential lifetime: 6 hours. */
export const TOKEN_TTL_SECONDS = 6 * 60 * 60;

const CF_TURN_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const CF_FETCH_TIMEOUT_MS = 5000;
const STUN_ONLY_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];

type IceServer = TurnCredentialsResponse['iceServers'][number];

/** Cloudflare's TURN-keys response: iceServers as one object OR an array. */
interface CloudflareCredentialsPayload {
  iceServers?:
    | { urls?: string | string[]; username?: string; credential?: string }
    | Array<{ urls?: string | string[]; username?: string; credential?: string }>;
}

export class RtcService {
  constructor(private readonly deps: Deps) {}

  /**
   * ICE servers for the caller. Strategy chain: Cloudflare → STUN-only.
   * Relay is unmetered for every account, so `fairUseRemainingGb` is always
   * `null`.
   */
  async turnCredentials(auth: AuthContext): Promise<TurnCredentialsResponse> {
    let iceServers = await this.iceServersFromStrategies(auth.userId);
    if (iceServers.length === 0) {
      iceServers = STUN_ONLY_SERVERS.map((s) => ({ ...s }));
    }

    return {
      iceServers,
      ttlSeconds: TOKEN_TTL_SECONDS,
      fairUseRemainingGb: null,
    };
  }

  /** First strategy that yields servers wins; failures fall through. */
  private async iceServersFromStrategies(userId: string): Promise<IceServer[]> {
    const { cloudflare } = this.deps.config;
    if (cloudflare.turnKeyId !== null && cloudflare.turnApiToken !== null) {
      const servers = await this.cloudflareIceServers(
        cloudflare.turnKeyId,
        cloudflare.turnApiToken,
        userId,
      );
      if (servers !== null) {
        return servers;
      }
    }
    return STUN_ONLY_SERVERS.map((s) => ({ ...s }));
  }

  /**
   * Cloudflare TURN-keys API: short-lived credentials scoped to the account's
   * TURN key. Returns null on ANY network/API/payload failure (logged) so the
   * caller falls through to the next strategy.
   */
  private async cloudflareIceServers(
    keyId: string,
    apiToken: string,
    userId: string,
  ): Promise<IceServer[] | null> {
    try {
      const response = await fetch(`${CF_TURN_ENDPOINT}/${keyId}/credentials`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
        },
        // customIdentifier tags the credential with the requesting user so
        // relay usage stays attributable per user in Cloudflare analytics —
        // abuse review only; nothing is metered or capped against it.
        body: JSON.stringify({ ttl: TOKEN_TTL_SECONDS, customIdentifier: userId }),
        signal: AbortSignal.timeout(CF_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.deps.log.warn({ status: response.status }, 'cloudflare TURN credentials failed');
        return null;
      }
      const payload = (await response.json()) as CloudflareCredentialsPayload;
      const servers = normalizeCloudflareServers(payload);
      if (servers.length === 0) {
        this.deps.log.warn('cloudflare TURN credentials payload had no usable iceServers');
        return null;
      }
      return servers;
    } catch (err) {
      this.deps.log.warn({ err }, 'cloudflare TURN credentials request failed');
      return null;
    }
  }
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
