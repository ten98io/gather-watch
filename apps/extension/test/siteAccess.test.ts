/**
 * The pure half of the narrowed permission model: which patterns the dynamic
 * registration carries, and which grant a tab's URL translates into. The
 * chrome plumbing that consumes these lives in background.ts/popup.ts and is
 * exercised through their own harnesses.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_WEB_ORIGINS } from '../src/config';
import { providerById } from '../src/providers';
import {
  grantPatternsForTabUrl,
  isInsecureTabUrl,
  registrationMatches,
  sameMatchSet,
} from '../src/siteAccess';

describe('registrationMatches', () => {
  it('keeps granted patterns and drops the ones that pin to a Gather origin', () => {
    // The Gather origins carry the declarative manifest entry (the announce);
    // registering them again would say the same thing in two places.
    expect(
      registrationMatches(
        ['https://*.netflix.com/*', 'http://localhost:3000/*', 'https://gather.watch/*'],
        DEFAULT_WEB_ORIGINS,
      ),
    ).toEqual(['https://*.netflix.com/*']);
  });

  it('keeps a wildcard grant whole — the boot sentinel makes overlap harmless', () => {
    expect(registrationMatches(['<all_urls>'], DEFAULT_WEB_ORIGINS)).toEqual(['<all_urls>']);
  });

  it('dedupes, and is empty for an empty grant list', () => {
    expect(
      registrationMatches(['https://a.test/*', 'https://a.test/*'], DEFAULT_WEB_ORIGINS),
    ).toEqual(['https://a.test/*']);
    expect(registrationMatches([], DEFAULT_WEB_ORIGINS)).toEqual([]);
  });
});

describe('grantPatternsForTabUrl', () => {
  it("asks for a known provider's whole grant, not one hostname", () => {
    // The site the user is watching spans hosts; granting the one they are on
    // would look kept while the player iframe stays out of reach.
    expect(grantPatternsForTabUrl('https://www.netflix.com/watch/80100172')).toEqual(
      providerById('netflix')?.grantPatterns,
    );
  });

  it('asks for exactly scheme://hostname/* on an unrecognised site', () => {
    expect(grantPatternsForTabUrl('https://films.example.org/watch?v=1#t=2')).toEqual([
      'https://films.example.org/*',
    ]);
  });

  it('refuses a standing grant for a plain-http site — a persistent MITM door', () => {
    // The registry's own doctrine (packages/contracts providers.ts header):
    // standing grants are https only. Anyone on the user's network can BE an
    // http origin, and a persistent grant would run a content script's worth
    // of code for them on every future visit. The tab still works while
    // connected (activeTab); it just cannot be kept.
    expect(grantPatternsForTabUrl('http://intranet.local/movie')).toEqual([]);
    // A known provider reached over http is refused the same way.
    expect(grantPatternsForTabUrl('http://www.netflix.com/watch/80100172')).toEqual([]);
  });

  it('asks for nothing on a page that cannot be granted', () => {
    for (const url of ['chrome://extensions', 'about:blank', 'not a url', '', undefined]) {
      expect(grantPatternsForTabUrl(url), String(url)).toEqual([]);
    }
  });
});

describe('isInsecureTabUrl', () => {
  it('is true exactly for plain-http pages — what the popup must explain', () => {
    expect(isInsecureTabUrl('http://intranet.local/movie')).toBe(true);
    expect(isInsecureTabUrl('https://films.example.org/watch')).toBe(false);
  });

  it('is false for everything that is not an http page at all', () => {
    for (const url of ['chrome://extensions', 'about:blank', 'not a url', '', undefined]) {
      expect(isInsecureTabUrl(url), String(url)).toBe(false);
    }
  });
});

describe('sameMatchSet', () => {
  it('ignores order and duplicates — a set, not a list', () => {
    expect(sameMatchSet(['a', 'b'], ['b', 'a', 'b'])).toBe(true);
    expect(sameMatchSet([], [])).toBe(true);
  });

  it('is false the moment the sets differ', () => {
    expect(sameMatchSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameMatchSet(['a', 'b'], ['a'])).toBe(false);
    expect(sameMatchSet(['a'], ['b'])).toBe(false);
  });
});
