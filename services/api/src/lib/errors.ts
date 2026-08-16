import { makeApiError } from '@gather/contracts';
import type { ApiError, ErrorCode } from '@gather/contracts';

/** HTTP status for each contracts error code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  // 402 is what turns a plan gate into an upgrade prompt client-side; never
  // use FORBIDDEN for an entitlement check.
  PAYMENT_REQUIRED: 402,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  ROOM_POLICY: 403,
  VALIDATION: 400,
  QUOTA_EXCEEDED: 413,
  CONFLICT: 409,
  INTERNAL: 500,
};

/**
 * The one throwable the API maps to the contracts error shape. Every route
 * and adapter throws AppError for expected failures; anything else surfaces
 * as INTERNAL via the error-mapper plugin.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly refType: string | undefined;

  constructor(code: ErrorCode, message: string, refType?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.refType = refType;
  }

  get statusCode(): number {
    return ERROR_STATUS[this.code];
  }

  toPayload(): ApiError {
    return makeApiError(this.code, this.message, this.refType);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
