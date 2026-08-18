/**
 * The web app's baseline browser hardening lives in next.config.ts, which no
 * other test imports — so a deletion there fails SILENTLY at the next deploy.
 * This suite pins the headers' existence and the few directive values that
 * are load-bearing (object-src, frame-ancestors, the download-only escape
 * hatch for script/embed policy).
 */
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

type Header = { key: string; value: string };

async function headersForAllRoutes(): Promise<Header[]> {
  const groups = await nextConfig.headers?.();
  const all = groups?.find((g) => g.source === '/:path*');
  expect(all).toBeDefined();
  return (all as { headers: Header[] }).headers;
}

describe('web security headers', () => {
  it('ships the baseline set on every route', async () => {
    const headers = await headersForAllRoutes();
    const byKey = new Map(headers.map((h) => [h.key, h.value]));
    expect(byKey.get('X-Content-Type-Options')).toBe('nosniff');
    expect(byKey.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(byKey.get('X-Frame-Options')).toBe('DENY');
    expect(byKey.get('Permissions-Policy')).toContain('display-capture=(self)');
    expect(byKey.get('Content-Security-Policy')).toBeTypeOf('string');
  });

  it('the CSP closes the frames and objects that matter', async () => {
    const headers = await headersForAllRoutes();
    const csp = headers.find((h) => h.key === 'Content-Security-Policy')!.value;
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    // Provider embeds are the only iframes, and all of them are https.
    expect(csp).toContain('frame-src https:');
  });
});
