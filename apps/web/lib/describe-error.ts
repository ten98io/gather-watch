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
import { ApiError } from '@gather/api-client';
import type { ErrorCode } from '@gather/contracts';

/**
 * Codes that get NO sentence of their own, on purpose.
 *
 * INTERNAL is what api-client stamps on every status it cannot name — 500,
 * 502, a proxy timeout, a body that was not an error payload at all. A shared
 * sentence for it could only ever be "something went wrong", which is strictly
 * worse than the fallback the call site already passes ("Couldn't send that
 * message"), because the call site knows what the person was trying to do.
 *
 * Anything listed here is checked against the live enum by
 * test/describe-error-coverage.test.ts, so this cannot rot into a list of
 * codes that no longer exist.
 */
export const CONTEXTUAL_ONLY_CODES = ['INTERNAL'] as const satisfies readonly ErrorCode[];

export function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
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

/* ── render boundaries ───────────────────────────────────────────────────── */

/** What a boundary says when it has nothing more specific to say. */
const BROKE_SENTENCE = 'Something on this screen stopped working.';

/**
 * A deploy landed while this tab was open, so the chunk the router just asked
 * for is gone from the CDN. This is the one boundary case that is nobody's
 * bug and has an exact remedy, so it gets its own sentence.
 */
const STALE_BUILD_SENTENCE = 'Gather updated while this page was open — reload to get the new version.';

/**
 * One sentence for a caught render throw.
 *
 * Boundaries receive whatever React caught, which is far dirtier than an
 * ApiError: a DOM exception, a library's internal invariant, a connection
 * string in a driver message. NOTHING from `err` is ever returned — every
 * branch returns a constant — so this cannot leak a raw message the way
 * rendering `error.message` would.
 */
export function describeBoundaryError(err: unknown): string {
  if (isStaleBuildError(err)) return STALE_BUILD_SENTENCE;
  return BROKE_SENTENCE;
}

/** True for the several shapes a "chunk went missing after a deploy" takes. */
function isStaleBuildError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'ChunkLoadError') return true;
  return /Loading (CSS )?chunk|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(
    err.message,
  );
}

/**
 * Send a caught render throw somewhere a person can find it later.
 *
 * Next stamps a `digest` on server-thrown errors — a hash that matches a line
 * in the server log and is the ONLY way to trace a production report back to
 * a stack. It is useless to the person looking at the screen and it is not
 * theirs to read, so it goes here and never into markup.
 *
 * This is the ONE console call in apps/web, and it is deliberate: there is no
 * logger in this app, and a boundary that records nothing is the swallowed
 * rejection pattern at its worst — the crash still happened, and now the only
 * evidence of it is a person saying "it went weird".
 */
export function logBoundaryError(scope: string, err: unknown): void {
  const digest = err instanceof Error ? (err as { digest?: string }).digest : undefined;
  const trace = digest === undefined ? '' : ` digest=${digest}`;
  console.error(`[gather] ${scope} boundary caught${trace}`, err);
}
