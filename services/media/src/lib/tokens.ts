/**
 * Access-token verification — a deliberate COPY of services/api's scheme
 * (jose, HS256, issuer 'gather', audience 'gather-api'). Tokens are issued by
 * the api; this service only verifies. Do not import services/api code.
 *
 * NOTE: unlike the api's auth plugin, verification here is JWT-only — the
 * media service does not read the sessions collection, so a revoked session's
 * token stays valid until expiry (accessTokenTtlSec, default 15 min).
 */
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AppConfig } from '../config';

/** Claims carried by the short-lived access JWT. */
export interface AccessClaims {
  userId: string;
  sessionId: string;
  guest: boolean;
  /** Guests are room-scoped; null for full accounts. */
  guestRoomId: string | null;
}

const ISSUER = 'gather';
const AUDIENCE = 'gather-api';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Test/dev signer — production tokens are minted by services/api. */
export async function signAccessToken(
  config: AppConfig,
  claims: AccessClaims,
  expiresInSec = 900,
): Promise<string> {
  return new SignJWT({
    sid: claims.sessionId,
    guest: claims.guest,
    // exactOptionalPropertyTypes: omit the claim entirely when room-scoping
    // does not apply instead of writing an explicit null.
    ...(claims.guestRoomId === null ? {} : { roomId: claims.guestRoomId }),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSec)
    .sign(secretKey(config.jwtSecret));
}

/** Returns null on ANY failure (bad signature, expired, malformed claims) —
 *  callers treat every failure mode identically as "unauthenticated". */
export async function verifyAccessToken(
  config: AppConfig,
  token: string,
): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(config.jwtSecret), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const { sub, sid, guest, roomId } = payload;
    if (typeof sub !== 'string' || typeof sid !== 'string' || typeof guest !== 'boolean') {
      return null;
    }
    if (roomId !== undefined && roomId !== null && typeof roomId !== 'string') {
      return null;
    }
    return {
      userId: sub,
      sessionId: sid,
      guest,
      guestRoomId: guest && typeof roomId === 'string' ? roomId : null,
    };
  } catch {
    return null;
  }
}

export function newId(): string {
  return randomUUID();
}
