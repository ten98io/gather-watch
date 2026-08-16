import { z } from 'zod';

/**
 * PAYMENT_REQUIRED is deliberately distinct from FORBIDDEN: a plan gate is
 * not a permission refusal, and clients branch on its 402 to offer an
 * upgrade instead of "you don't have permission".
 */
export const ERROR_CODES = [
  'UNAUTHORIZED', 'FORBIDDEN', 'PAYMENT_REQUIRED', 'NOT_FOUND', 'RATE_LIMITED',
  'ROOM_POLICY', 'VALIDATION', 'QUOTA_EXCEEDED', 'CONFLICT', 'INTERNAL',
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

// const map: ErrorCodes.UNAUTHORIZED === 'UNAUTHORIZED', fully typed
export const ErrorCodes = Object.fromEntries(ERROR_CODES.map((c) => [c, c])) as {
  readonly [K in ErrorCode]: K;
};

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  refType: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export function makeApiError(code: ErrorCode, message: string, refType?: string): ApiError {
  return refType === undefined ? { code, message } : { code, message, refType };
}
