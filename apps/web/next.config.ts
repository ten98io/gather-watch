import type { NextConfig } from 'next';

/**
 * Baseline browser hardening for every route. Notes on the deliberate shapes:
 *
 * - script-src carries 'unsafe-inline' because the no-flash theme bootstrap in
 *   app/layout.tsx is an inline script, and the App Router's own flight data
 *   ships inline too. A nonce pipeline is the real fix; until then the CSP's
 *   working half is object-src/base-uri/frame-ancestors/form-action plus
 *   blocking EXTERNAL script injection.
 * - connect-src allows https:/wss: outright: the api origin, the bucket's
 *   presigned redirects, Tenor, and provider APIs are all https and vary by
 *   deployment. The media PATH is unaffected by CSP (WebRTC is not gated by
 *   connect-src).
 * - frame-src https: — provider embeds (YouTube/Spotify/…) are the only
 *   iframes, all https.
 * - frame-ancestors 'none' + X-Frame-Options DENY — gather.watch is never a
 *   framee; clickjacking the room UI is the concern this closes.
 * - Permissions-Policy opens exactly what the room uses: mic/camera for the
 *   call, display-capture for screen share, autoplay for synced playback.
 * - TWO DIRECTIVES RELAX IN DEVELOPMENT ONLY, and both are load-bearing for
 *   `pnpm dev` rather than cosmetic:
 *
 *   script-src gains 'unsafe-eval'. `next dev` compiles React Refresh and HMR
 *   through `eval`, so a policy without it does not fail loudly — it throws an
 *   EvalError into the console on every reload and hot reloading quietly stops
 *   working, which reads as "the dev server is flaky" rather than as a header.
 *
 *   connect-src gains http: and ws:. This one broke the documented dev path
 *   outright. A different PORT is a different ORIGIN, so the api on
 *   localhost:4000 is neither 'self' (localhost:3000) nor https: nor wss: —
 *   every REST call and the room socket were refused before they left the
 *   page, and the UI reported it as "could not send the link", i.e. as the
 *   API's fault. Production speaks https/wss to a real origin and is unchanged.
 *
 *   Production never evaluates a string and never talks plaintext, so the
 *   shipped policy is exactly what it was; apps/web/test/security-headers.test.ts
 *   pins both halves of the split so neither relaxation can reach a deploy.
 */
const IS_DEV = process.env.NODE_ENV === 'development';

const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(self), microphone=(self), display-capture=(self), autoplay=(self)',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${IS_DEV ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "font-src 'self' data:",
      `connect-src 'self' https: wss:${IS_DEV ? ' http: ws:' : ''}`,
      'frame-src https:',
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
      {
        // The service worker must always be revalidated so deploys take effect.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
