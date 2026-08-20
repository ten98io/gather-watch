/**
 * The web app's baseline browser hardening lives in next.config.ts, which no
 * other test imports — so a deletion there fails SILENTLY at the next deploy.
 * This suite pins the headers' existence and the few directive values that
 * are load-bearing (object-src, frame-ancestors, the download-only escape
 * hatch for script/embed policy).
 */
import { describe, expect, it, vi } from 'vitest';
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

  /**
   * `next dev` compiles React Refresh and HMR through `eval`. A CSP without
   * 'unsafe-eval' does not fail loudly there — it throws an EvalError into the
   * console on every reload and hot reloading quietly stops working, which
   * reads as a flaky dev server rather than as a header. The relaxation is
   * therefore deliberate AND must stay development-only: production never
   * evaluates a string, and shipping 'unsafe-eval' would hand an injected
   * string the one primitive the rest of this policy exists to deny.
   */
  it("relaxes eval and plaintext transports in development, NEVER in production", async () => {
    const prev = process.env.NODE_ENV;
    try {
      for (const [env, shouldAllow] of [
        ['development', true],
        ['production', false],
        ['test', false],
      ] as const) {
        vi.resetModules();
        // NODE_ENV is readonly in the Next types; the config reads it at module
        // load, which is the only way to observe the branch.
        (process.env as Record<string, string>)['NODE_ENV'] = env;
        const fresh = (await import('../next.config')).default;
        const groups = await fresh.headers?.();
        const all = groups?.find((g) => g.source === '/:path*') as { headers: Header[] };
        const csp = all.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
        expect(csp.includes("'unsafe-eval'"), `${env} → unsafe-eval`).toBe(shouldAllow);
        // The half that broke `pnpm dev` outright: a different PORT is a
        // different ORIGIN, so the dev api is neither 'self' nor https:, and
        // every REST call and the room socket were refused before they left
        // the page. Production speaks https/wss and must never allow either.
        expect(/connect-src[^;]*\bhttp:/.test(csp), `${env} → connect http:`).toBe(shouldAllow);
        expect(/connect-src[^;]*\bws:/.test(csp), `${env} → connect ws:`).toBe(shouldAllow);
      }
    } finally {
      (process.env as Record<string, string>)['NODE_ENV'] = prev ?? 'test';
      vi.resetModules();
    }
  });

  /**
   * THE POLICY MUST ADMIT THE PLAYERS IT DRIVES, and this is the test that
   * would have caught it. Every provider player is loaded by injecting THEIR
   * script tag — YouTube's iframe_api, Vimeo's player.js, SoundCloud's widget
   * api.js, Google's cast_sender.js. Under `script-src 'self'` the browser
   * refused all four before any of our code ran, so a queued YouTube row
   * never played and NOTHING in the room said why: the only evidence was a
   * CSP violation in a console nobody had open. A silent failure at the
   * product's single most common action is exactly the shape a header test
   * exists to catch, and this file already existed and did not look.
   */
  it('admits the player SDKs the room actually loads', async () => {
    const headers = await headersForAllRoutes();
    const csp = headers.find((h) => h.key === 'Content-Security-Policy')!.value;
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    for (const host of [
      'https://www.youtube.com',
      'https://player.vimeo.com',
      'https://w.soundcloud.com',
      'https://www.gstatic.com',
      'https://static.cloudflareinsights.com',
    ]) {
      expect(scriptSrc, `script-src must admit ${host}`).toContain(host);
    }
    // Named hosts, never a blanket https: — that would readmit the external
    // script injection the rest of this policy exists to block.
    expect(scriptSrc).not.toMatch(/script-src[^;]*\shttps:(\s|$)/);
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
