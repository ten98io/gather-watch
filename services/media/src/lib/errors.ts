import { makeApiError } from '@playin/contracts';
import type { ApiError, ErrorCode } from '@playin/contracts';

/** HTTP status for each contracts error code (mirrors services/api). */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
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
 * The one throwable the service maps to the contracts error shape. Every route
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
