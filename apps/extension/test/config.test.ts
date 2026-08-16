import { describe, expect, it } from 'vitest';
import {
  API_ORIGIN,
  API_URL,
  DEFAULT_API_URL,
  DEFAULT_WEB_ORIGINS,
  WEB_ORIGINS,
  WS_URL,
  originOfUrl,
  parseWebOrigins,
  wsUrlFor,
} from '../src/config';

describe('wsUrlFor', () => {
  it('maps http to ws and https to wss', () => {
    expect(wsUrlFor('http://localhost:4000')).toBe('ws://localhost:4000/ws');
    expect(wsUrlFor('https://api.gather.watch')).toBe('wss://api.gather.watch/ws');
  });

  it('tolerates a trailing slash', () => {
    expect(wsUrlFor('https://api.gather.watch/')).toBe('wss://api.gather.watch/ws');
  });
});

describe('endpoint constants', () => {
  it('falls back to the dev origin when no build define is present', () => {
    expect(API_URL).toBe(DEFAULT_API_URL);
    expect(WS_URL).toBe(wsUrlFor(DEFAULT_API_URL));
  });

  it('exposes the API as a bare origin (the only host a room token may reach)', () => {
    expect(API_ORIGIN).toBe('http://localhost:4000');
  });
});

describe('originOfUrl', () => {
  it('normalises http(s) URLs to a lowercased bare origin', () => {
    expect(originOfUrl('https://Gather.Watch/room/1?x=2')).toBe('https://gather.watch');
    expect(originOfUrl('http://localhost:3000/')).toBe('http://localhost:3000');
  });

  it('rejects every non-http scheme', () => {
    for (const url of ['file:///etc/passwd', 'javascript:1', 'chrome://settings', 'nonsense']) {
      expect(originOfUrl(url), url).toBeNull();
    }
  });
});

describe('parseWebOrigins', () => {
  it('parses a comma-separated build define', () => {
    expect(parseWebOrigins('https://gather.watch, https://www.gather.watch')).toEqual([
      'https://gather.watch',
      'https://www.gather.watch',
    ]);
  });

  it('fails closed: a typo is dropped, never widened into a wildcard', () => {
    expect(parseWebOrigins('https://gather.watch,not-a-url,,file:///x')).toEqual([
      'https://gather.watch',
    ]);
    expect(parseWebOrigins('')).toEqual([]);
    expect(parseWebOrigins(undefined)).toEqual([]);
  });

  it('de-duplicates', () => {
    expect(parseWebOrigins('https://gather.watch,https://gather.watch/room')).toEqual([
      'https://gather.watch',
    ]);
  });
});

describe('WEB_ORIGINS', () => {
  it('falls back to the built-in list when no define is present', () => {
    expect(WEB_ORIGINS).toEqual(DEFAULT_WEB_ORIGINS);
  });

  it('contains no wildcard and no schemeless entry', () => {
    for (const origin of WEB_ORIGINS) {
      expect(origin, origin).not.toContain('*');
      expect(originOfUrl(origin), origin).toBe(origin);
    }
  });
});
