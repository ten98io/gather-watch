/**
 * RTC domain logic: LiveKit access-token minting for room members and
 * short-lived TURN credentials with a strategy chain — Cloudflare TURN-keys
 * API when configured, coturn REST (HMAC-SHA1) credentials when a static auth
 * secret is set, and a STUN-only fallback — plus the free-plan fair-use cap
 * on TURN relay traffic. Pure logic over Deps (global fetch injectable via
 * tests stubbing it); no Fastify types here.
 *
 * Contract conformance notes:
 * - LivekitTokenResponse is exactly { url, token } — the room's relayMode has
 *   no field in the contract, so it is NOT carried (deviation from the early
 *   draft; relayMode is already visible on the Room entity).
 * - The fair-use "capped" signal is `fairUseRemainingGb: 0` — the contract
 *   has no separate boolean.
 */
import { createHmac } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import type { LivekitTokenResponse, TurnCredentialsResponse } from '@playin/contracts';
import { AppError } from '../../lib/errors';
import { memberDocId } from '../../adapters/ports';
import { getEntitlementsPort } from '../rooms/deps';
import type { AuthContext, Deps } from '../types';

/** LiveKit grant + coturn/Cloudflare credential lifetime: 6 hours. */
export const TOKEN_TTL_SECONDS = 6 * 60 * 60;

const CF_TURN_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const CF_FETCH_TIMEOUT_MS = 5000;
const STUN_ONLY_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];
/** Usage `unit` for TURN metering; amounts are byte counts. */
const TURN_USAGE_KIND = 'turn-bytes';
const BYTES_PER_GB = 1e9;

type IceServer = TurnCredentialsResponse['iceServers'][number];

/** Cloudflare's TURN-keys response: iceServers as one object OR an array. */
interface CloudflareCredentialsPayload {
  iceServers?:
    | { urls?: string | string[]; username?: string; credential?: string }
    | Array<{ urls?: string | string[]; username?: string; credential?: string }>;
}

export class RtcService {
  constructor(private readonly deps: Deps) {}

  private now(): number {
    return Date.now();
  }

  /**
   * Mint a LiveKit access token for a room member. Guests are confined to
   * their invite room. Subscribe is always granted; publish is granted to
   * every (non-banned) member — `maxPublishers` is enforced by LiveKit/the
   * client, not by the token grant.
   */
  async mintLivekitToken(auth: AuthContext, roomId: string): Promise<LivekitTokenResponse> {
    if (auth.guestRoomId !== null && auth.guestRoomId !== roomId) {
      throw new AppError('FORBIDDEN', 'guest token is room-scoped');
    }
    const room = await this.deps.store.rooms.findById(roomId);
    if (room === null) {
      throw new AppError('NOT_FOUND', 'room not found');
    }
    const member = await this.deps.store.members.findById(memberDocId(roomId, auth.userId));
    if (member === null) {
      throw new AppError('FORBIDDEN', 'not a member');
    }
    if (member.banned) {
      throw new AppError('FORBIDDEN', 'banned');
    }

    const { apiKey, apiSecret, url } = this.deps.config.livekit;
    const token = new AccessToken(apiKey, apiSecret, {
      identity: auth.userId,
      ttl: TOKEN_TTL_SECONDS,
    });
    token.addGrant({
      roomJoin: true,
      room: room.id,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return { url, token: await token.toJwt() };
  }

  /**
   * ICE servers for the caller. Strategy chain: Cloudflare → coturn HMAC →
   * STUN-only. Free-plan users over the monthly fair-use cap get all
   * `turn:`/`turns:` relay URLs stripped (STUN kept) and
   * `fairUseRemainingGb: 0`; premium (active subscription) is unmetered
   * (`fairUseRemainingGb: null`).
   */
  async turnCredentials(auth: AuthContext): Promise<TurnCredentialsResponse> {
    const entitlements = await getEntitlementsPort(this.deps).getFor(auth.userId);
    const unmetered = entitlements.plan === 'premium';

    const capGb = this.deps.config.freeTurnCapGbPerMonth;
    const usedGb = unmetered ? 0 : await this.turnUsageGbThisMonth(auth.userId);
    const remainingGb = unmetered ? null : Math.max(0, capGb - usedGb);
    const capped = !unmetered && usedGb >= capGb;

    let iceServers = await this.iceServersFromStrategies(auth.userId);
    if (capped) {
      iceServers = stripRelayUrls(iceServers);
    }
    if (iceServers.length === 0) {
      iceServers = STUN_ONLY_SERVERS.map((s) => ({ ...s }));
    }

    return {
      iceServers,
      ttlSeconds: TOKEN_TTL_SECONDS,
      // 3 decimals keeps the signal readable without float noise.
      fairUseRemainingGb: remainingGb === null ? null : Math.round(remainingGb * 1000) / 1000,
    };
  }

  /** Sum of this user's `turn-bytes` usage in the current UTC calendar month. */
  private async turnUsageGbThisMonth(userId: string): Promise<number> {
    const now = new Date(this.now());
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const docs = await this.deps.store.usage.findMany({
      userId,
      kind: TURN_USAGE_KIND,
      at: { $gte: monthStart },
    });
    const bytes = docs.reduce((total, doc) => total + doc.amount, 0);
    return bytes / BYTES_PER_GB;
  }

  /** First strategy that yields servers wins; failures fall through. */
  private async iceServersFromStrategies(userId: string): Promise<IceServer[]> {
    const { cloudflare, turnStaticAuthSecret } = this.deps.config;
    if (cloudflare.turnKeyId !== null && cloudflare.turnApiToken !== null) {
      const servers = await this.cloudflareIceServers(cloudflare.turnKeyId, cloudflare.turnApiToken);
      if (servers !== null) {
        return servers;
      }
    }
    if (turnStaticAuthSecret !== null) {
      return this.coturnIceServers(userId, turnStaticAuthSecret);
    }
    return STUN_ONLY_SERVERS.map((s) => ({ ...s }));
  }

  /**
   * Cloudflare TURN-keys API: short-lived credentials scoped to the account's
   * TURN key. Returns null on ANY network/API/payload failure (logged) so the
   * caller falls through to the next strategy.
   */
  private async cloudflareIceServers(keyId: string, apiToken: string): Promise<IceServer[] | null> {
    try {
      const response = await fetch(`${CF_TURN_ENDPOINT}/${keyId}/credentials`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl: TOKEN_TTL_SECONDS }),
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

  /**
   * coturn REST credentials: username `<unixExpiry>:<userId>`, credential =
   * base64 HMAC-SHA1(username, staticAuthSecret). URIs derive their host from
   * the configured apiUrl (localhost in dev).
   */
  private coturnIceServers(userId: string, secret: string): IceServer[] {
    const expiry = Math.floor(this.now() / 1000) + TOKEN_TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    return [{ urls: coturnUris(this.deps.config.apiUrl), username, credential }];
  }
}

/** turn/turns URIs for the host serving the API (localhost fallback in dev). */
function coturnUris(apiUrl: string): string[] {
  let host = 'localhost';
  try {
    host = new URL(apiUrl).hostname || 'localhost';
  } catch {
    // keep fallback
  }
  return [
    `turn:${host}:3478?transport=udp`,
    `turn:${host}:3478?transport=tcp`,
    `turns:${host}:5349?transport=tcp`,
  ];
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

/** Drop every turn:/turns: URL (relay transports) and any server left with no
 *  URLs; STUN entries pass through untouched. */
function stripRelayUrls(servers: IceServer[]): IceServer[] {
  const out: IceServer[] = [];
  for (const server of servers) {
    const urls = server.urls.filter((u) => !u.startsWith('turn:') && !u.startsWith('turns:'));
    if (urls.length === 0) {
      continue;
    }
    out.push({ ...server, urls });
  }
  return out;
}
