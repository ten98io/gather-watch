/**
 * Where a magic link lands when it comes back.
 *
 * Owns: the one destination the sign-in round trip is allowed to carry, and
 * the validation that keeps it from being anywhere but this origin.
 *
 * ── Why the destination is stored and not passed ──────────────────────────
 * The link in the email is minted by the SERVER —
 * `services/api/src/modules/auth/service.ts` builds
 * `${appUrl}/auth/verify?token=<token>` — so nothing the browser knows can
 * ride along in it. Between "email me a link" and the click that returns,
 * the only place the intended destination can live is this device.
 *
 * localStorage and NOT sessionStorage: a mail client opens the link in a new
 * tab, and a new tab is a new session store. sessionStorage would silently
 * drop every round trip it exists to survive.
 *
 * ── Why the value is re-validated on the way out ──────────────────────────
 * It is attacker-reachable — any script on the origin can write it, and it
 * outlives the tab that wrote it — so it is untrusted input when READ, not
 * only when written. `safeAfterSignIn` admits a same-origin path and nothing
 * else. `/auth/verify` runs immediately after authentication, which makes it
 * the single worst place in the product to host an open redirect: a link that
 * signs someone in and then hands them to another origin is a credential
 * phish wearing our domain.
 */

/** Where sign-in goes when nothing better was asked for. */
export const DEFAULT_AFTER_SIGNIN = '/home';

const STORAGE_KEY = 'gather:after-signin';

/**
 * A destination, or null if it is not one we will navigate to.
 *
 * The three rejected shapes are each a way out of the origin:
 *  · no leading `/` — `https://evil.example` and `javascript:…` alike;
 *  · `//host` — a protocol-relative URL, which every engine treats as
 *    absolute despite starting with a slash;
 *  · `/\host` — the backslash twin of the above, which WHATWG URL parsing
 *    normalises to `//host`.
 */
export function safeAfterSignIn(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw.length === 0) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  return raw;
}

/** Remember where to land. `null` clears, so a plain sign-in resets a stale one. */
export function rememberAfterSignIn(next: string | null): void {
  if (typeof window === 'undefined') return;
  const safe = safeAfterSignIn(next);
  try {
    if (safe === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, safe);
  } catch {
    // Private mode, or storage disabled. The round trip degrades to /home,
    // which is a worse landing and not a broken one.
  }
}

/**
 * The remembered destination, consumed.
 *
 * Reading CLEARS it, deliberately: it describes one journey, and a value left
 * behind would divert the next unrelated sign-in on this device.
 */
export function takeAfterSignIn(): string {
  if (typeof window === 'undefined') return DEFAULT_AFTER_SIGNIN;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    window.localStorage.removeItem(STORAGE_KEY);
    return safeAfterSignIn(stored) ?? DEFAULT_AFTER_SIGNIN;
  } catch {
    return DEFAULT_AFTER_SIGNIN;
  }
}
