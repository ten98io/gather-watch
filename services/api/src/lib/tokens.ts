/**
 * Access-token signing/verification (jose, HS256) plus the hashing helpers the
 * auth module needs for refresh tokens and single-use email tokens. Refresh
 * and email tokens are stored ONLY as HMAC digests, so a database leak does
 * not hand out usable credentials.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AppConfig } from '../config';

/** Claims carried by the short-lived access JWT (also the WS auth payload). */
export interface AccessClaims {
  userId: string;
  sessionId: string;
  guest: boolean;
  /** Guests are room-scoped; null for full accounts. */
  guestRoomId: string | null;
}

const ISSUER = 'playin';
const AUDIENCE = 'playin-api';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(config: AppConfig, claims: AccessClaims): Promise<string> {
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
    .setExpirationTime(Math.floor(Date.now() / 1000) + config.accessTokenTtlSec)
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

/** 32 random bytes, base64url — refresh tokens and single-use email tokens. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** HMAC-SHA256(config.jwtRefreshSecret, value) hex — keyed so raw token
 *  digests are useless without the server secret. */
export function hashToken(config: AppConfig, value: string): string {
  return createHmac('sha256', config.jwtRefreshSecret).update(value).digest('hex');
}

export function newId(): string {
  return randomUUID();
}
