import type { ErrorCode } from '@gather/contracts';

/**
 * Error thrown by this package for both HTTP-derived failures and local
 * client-side failures (e.g. missing platform capabilities).
 */
export class ApiError extends Error {
  /** Machine-readable error code from the contracts enum. */
  readonly code: ErrorCode;
  /** HTTP status the error was derived from, 0 when not HTTP-derived. */
  readonly status: number;
  /** Optional entity type the error refers to, when provided by the server. */
  readonly refType: string | undefined;

  constructor(code: ErrorCode, message: string, status?: number, refType?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? 0;
    this.refType = refType;
  }
}

/**
 * Builds an {@link ApiError} from an HTTP status and raw body text, mapping
 * the status to an error code for bodies that are not valid error payloads.
 */
export function apiErrorFromStatus(status: number, bodyText: string): ApiError {
  let code: ErrorCode;
  switch (status) {
    case 401:
      code = 'UNAUTHORIZED';
      break;
    case 403:
      code = 'FORBIDDEN';
      break;
    case 404:
      code = 'NOT_FOUND';
      break;
    case 409:
      code = 'CONFLICT';
      break;
    case 400:
    case 422:
      code = 'VALIDATION';
      break;
    case 429:
      code = 'RATE_LIMITED';
      break;
    default:
      code = 'INTERNAL';
      break;
  }
  const message = bodyText.length > 0 ? bodyText : `HTTP ${status}`;
  return new ApiError(code, message, status);
}
