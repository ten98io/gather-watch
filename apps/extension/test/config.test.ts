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
    expect(wsUrlFor('https://api.playin.app')).toBe('wss://api.playin.app/ws');
  });

  it('tolerates a trailing slash', () => {
    expect(wsUrlFor('https://api.playin.app/')).toBe('wss://api.playin.app/ws');
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
    expect(originOfUrl('https://Playin.App/room/1?x=2')).toBe('https://playin.app');
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
    expect(parseWebOrigins('https://playin.app, https://www.playin.app')).toEqual([
      'https://playin.app',
      'https://www.playin.app',
    ]);
  });

  it('fails closed: a typo is dropped, never widened into a wildcard', () => {
    expect(parseWebOrigins('https://playin.app,not-a-url,,file:///x')).toEqual([
      'https://playin.app',
    ]);
    expect(parseWebOrigins('')).toEqual([]);
    expect(parseWebOrigins(undefined)).toEqual([]);
  });

  it('de-duplicates', () => {
    expect(parseWebOrigins('https://playin.app,https://playin.app/room')).toEqual([
      'https://playin.app',
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
