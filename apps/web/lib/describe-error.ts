/**
 * describeError — the one place a thrown failure becomes a sentence a person
 * can read.
 *
 * ApiError.message is the RAW HTTP response body (packages/api-client
 * errors.ts) or `HTTP 500`, so it is NEVER shown to a user. Every call site
 * passes its own contextual fallback and gets curated copy back: known error
 * codes map to a shared sentence, a blocked browser permission gets its own,
 * and anything unrecognised falls back to the caller's wording.
 */
import { ApiError } from '@playin/api-client';

export function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    // Payment-required is a status, not a code — check it before the codes so
    // a plan gate reads as a plan gate rather than a permission refusal.
    if (err.status === 402) return 'This needs the Premium plan.';
    switch (err.code) {
      case 'UNAUTHORIZED':
        return 'Please sign in again.';
      case 'FORBIDDEN':
      case 'ROOM_POLICY':
        return 'You don’t have permission to do that here.';
      case 'NOT_FOUND':
        return 'That no longer exists.';
      case 'RATE_LIMITED':
        return 'You’re doing that too fast — give it a moment.';
      case 'VALIDATION':
        return 'That didn’t look right — check it and try again.';
      case 'QUOTA_EXCEEDED':
        return 'Storage limit reached.';
      case 'CONFLICT':
        return 'That changed while you were editing — try again.';
      default:
        return fallback;
    }
  }
  if (
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    err.name === 'NotAllowedError'
  ) {
    return 'Permission was blocked — check browser permissions.';
  }
  return fallback;
}
