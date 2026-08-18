/**
 * What a push endpoint is allowed to be.
 *
 * A web-push subscription hands the server a URL and a promise that it belongs
 * to a push service. The server later POSTs to it, unattended, from inside our
 * network, once per @mention — so an unvalidated endpoint is a stored
 * request-forgery primitive: `http://169.254.169.254/…`, an internal admin
 * port, someone else's webhook. The row outlives the request that created it,
 * which is what makes this worse than a one-shot SSRF.
 *
 * Two independent controls, in this order:
 *
 *   1. HOST. The endpoint must belong to a real push service. This is the
 *      control that does the work: there are exactly four of them, every
 *      browser mints its endpoint on one, and nothing internal is reachable
 *      through any. Suffix rules are anchored on a dot so `notify.windows.com`
 *      cannot be spelled `evilnotify.windows.com`, and the match is on the
 *      parsed hostname so it cannot be spelled
 *      `notify.windows.com.attacker.test` either.
 *
 *   2. ADDRESS. The URL then goes through the SSRF guard in lib/safe-fetch.ts
 *      — scheme, hostname resolution, every returned address checked against
 *      isPrivateIp — with the concrete hostname as its allowlist. Redundant
 *      while (1) holds, and deliberately so: it is the layer that survives a
 *      host being added to the list carelessly, and it keeps ONE module the
 *      authority on "is this URL safe to dial".
 *
 * What neither control gives is TOCTOU safety: `web-push` opens its own socket
 * later, with its own DNS lookup and no pinning, so a hijack of a push
 * service's DNS between registration and delivery is not covered here. That is
 * why the host list — not the address probe — is the load-bearing half, and
 * why chat/notify.ts re-checks the host on the way out.
 */
import { AppError } from '../../lib/errors';
import { createSafeFetcher } from '../../lib/safe-fetch';
import type { LookupFn } from '../../lib/safe-fetch';

/**
 * How many subscriptions one account may hold. A subscription is per BROWSER
 * INSTALLATION, and endpoints rotate (a key rotation mints a new one and
 * leaves the old row behind), so a long-lived account legitimately accumulates
 * rows it can never clean up itself. The bound therefore EVICTS THE OLDEST
 * rather than refusing the newest: refusing would eventually lock a real
 * person out of notifications on their newest device because of dead endpoints
 * on file, which is the opposite of what the limit is for. Storage stays
 * bounded and so does the per-mention fan-out.
 */
export const MAX_PUSH_SUBS_PER_USER = 20;

/**
 * Every host that mints web-push endpoints today. A leading dot means "any
 * subdomain of this domain" — WNS hands out per-region hosts
 * (`par02p.notify.windows.com`, `wns2-…`), so it cannot be an exact match.
 * Adding an entry here is a security decision: it must be a push service, not
 * merely a domain we happen to trust.
 */
export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge, Brave, Opera
  'android.googleapis.com', // legacy GCM endpoints still in the wild
  'updates.push.services.mozilla.com', // Firefox
  '.notify.windows.com', // Windows Notification Service
  'web.push.apple.com', // Safari (macOS 13+ / iOS 16.4+)
] as const;

/** True when `url`'s host is one of the push services above. */
export function isKnownPushService(url: URL): boolean {
  // Trailing dot: `fcm.googleapis.com.` is the same host to a resolver and
  // must not be a way past an exact-match rule.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return PUSH_SERVICE_HOSTS.some((rule) =>
    rule.startsWith('.') ? host.endsWith(rule) : host === rule,
  );
}

/**
 * Test seam: pin DNS for endpoint vetting so the suite never dials out.
 * Production leaves this null and the guard uses node's resolver.
 */
let lookupOverride: LookupFn | null = null;

export function setPushEndpointLookup(lookup: LookupFn | null): void {
  lookupOverride = lookup;
}

/**
 * Validate one subscription endpoint, or throw AppError('VALIDATION') — which
 * is also the only thing safe-fetch throws, so the caller has one shape to
 * handle.
 */
export async function assertPushEndpointAllowed(endpoint: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AppError('VALIDATION', 'push endpoint must be a supported push service url');
  }
  // One message for both checks: a caller learning WHICH one refused learns
  // nothing it can act on, and the fix is the same either way — resubscribe
  // through the browser's own pushManager.
  if (url.protocol !== 'https:' || !isKnownPushService(url)) {
    throw new AppError('VALIDATION', 'push endpoint must be a supported push service url');
  }
  const fetcher = createSafeFetcher({
    hostAllowlist: [url.hostname.toLowerCase()],
    label: 'push endpoint',
    ...(lookupOverride === null ? {} : { lookupImpl: lookupOverride }),
  });
  await fetcher.guard(url.toString());
}
