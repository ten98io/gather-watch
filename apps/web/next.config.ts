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
 */
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
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
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
