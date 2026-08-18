import { z } from 'zod';

/**
 * Every refusal this API can express. There is no payment code: Gather is
 * free for everyone, so nothing a client hits can be resolved by paying, and
 * a code that implies otherwise would only tempt the next gate into existing.
 * QUOTA_EXCEEDED covers the limits that remain — the ones physics and abuse
 * impose, which no amount of money would lift.
 */
export const ERROR_CODES = [
  'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED',
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
