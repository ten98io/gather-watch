/**
 * Site access under the narrowed permission model. The manifest demands no
 * host at install time; every content origin is an OPTIONAL grant
 * (`optional_host_permissions: ["<all_urls>"]`), and content.js reaches pages
 * three ways:
 *
 *   1. durable — a dynamic registered content script whose matches are the
 *      currently-granted origins (background.ts syncRegisteredScripts), so a
 *      granted site behaves exactly like the old declarative `<all_urls>`
 *      entry did: every new document, every new frame;
 *   2. one tab, right now — activeTab + scripting.executeScript, granted by
 *      the user opening the popup on that tab;
 *   3. everything at once — the popup requesting broader grants.
 *
 * This module is the pure part: which patterns to register, which to request.
 * It touches no chrome API so it is unit-testable in node.
 */
import { originOfUrl } from './config';
import { providerById, providerForUrl } from './providers';

/** The one dynamic registration background.ts maintains. */
export const REGISTRATION_ID = 'gather-driver';

/** The single origin a match pattern admits, or null when it admits more
 *  (any `*` left of the path). Mirrors buildTarget.ts's build-time twin —
 *  that module must stay out of the bundle, so the few lines live twice. */
function patternOrigin(pattern: string): string | null {
  const withoutPath = pattern.replace(/\/\*$/, '');
  if (withoutPath.includes('*')) return null;
  return originOfUrl(withoutPath);
}

/**
 * The matches for the dynamic registration: every granted origin pattern
 * EXCEPT the ones that pin to a Gather web origin — those carry the
 * declarative manifest entry (the extension-id announce depends on it), and
 * registering them twice would say the same thing in two places. A wildcard
 * grant (`<all_urls>`, a starred host) stays whole: it covers Gather too, and
 * the content script's boot sentinel makes the overlap a no-op.
 */
export function registrationMatches(
  grantedOrigins: readonly string[],
  gatherOrigins: readonly string[],
): string[] {
  const gather = new Set(gatherOrigins.map((o) => o.toLowerCase()));
  const out: string[] = [];
  for (const pattern of grantedOrigins) {
    const origin = patternOrigin(pattern);
    if (origin !== null && gather.has(origin)) continue;
    if (!out.includes(pattern)) out.push(pattern);
  }
  return out;
}

/**
 * The grant to ask for so Gather sticks to the site this tab is on.
 *
 * A known provider is granted as its registry patterns — the site the user is
 * watching spans hosts (www/player/CDN subdomains), and granting one hostname
 * would make the grant look kept while the player iframe stays out of reach.
 * An unrecognised site is granted as exactly its scheme + hostname.
 *
 * HTTPS ONLY, the registry's own doctrine (packages/contracts providers.ts
 * header): a standing grant is a standing door, and a persistent `http://…`
 * origin grant holds that door open for anyone on the user's network — a MITM
 * can then run a content script's worth of code on every future visit. So a
 * plain-http tab returns [] exactly like a page that is not http(s) at all
 * (chrome://, about:blank, the PDF viewer): honestly empty, never a guess.
 * The tab still WORKS while connected — activeTab covers it — it just cannot
 * be kept; the popup says so (see {@link isInsecureTabUrl}).
 */
export function grantPatternsForTabUrl(url: string | undefined): string[] {
  if (typeof url !== 'string' || url.length === 0) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== 'https:') return [];
  const patterns = providerById(providerForUrl(url).id)?.grantPatterns ?? [];
  if (patterns.length > 0) return [...patterns];
  return [`${parsed.protocol}//${parsed.hostname}/*`];
}

/**
 * Is this a plain-http page — grantable-shaped, but refused a standing grant
 * by {@link grantPatternsForTabUrl}? The popup tells this apart from "nothing
 * grantable at all" so it can explain the refusal instead of going silent:
 * the tab works while connected, it just cannot be kept.
 */
export function isInsecureTabUrl(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    return new URL(url).protocol === 'http:';
  } catch {
    return false;
  }
}

/** Set equality on match patterns — order and duplicates carry no meaning,
 *  and re-registering an unchanged set costs a churn Chrome need not see. */
export function sameMatchSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const pattern of setA) {
    if (!setB.has(pattern)) return false;
  }
  return true;
}
