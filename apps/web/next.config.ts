import type { NextConfig } from 'next';

/**
 * Baseline browser hardening for every route. Notes on the deliberate shapes:
 *
 * - script-src NAMES THE FOUR PLAYER SDKS, and it has to. Every provider whose
 *   player we drive is loaded by injecting THEIR script tag: YouTube's
 *   iframe_api (apps/web/lib/player/youtube.ts), Vimeo's player.js,
 *   SoundCloud's widget api.js, and Google's cast_sender.js
 *   (apps/web/lib/cast.ts). With `script-src 'self'` alone the browser refuses
 *   all four BEFORE any of our code runs, so a YouTube row simply never
 *   played — no error surfaced in the room, only a CSP violation in a console
 *   nobody had open. The hosts are pinned individually rather than opening
 *   script-src to https:, which would readmit exactly the external-script
 *   injection this policy exists to block.
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

/**
 * The only external script origins the room loads, each one a provider SDK we
 * have no alternative to: the player APIs are the sanctioned way to drive
 * these services, and every one of them ships as a script from its own host.
 * Keep this list closed — a host added here can run script in the room.
 */
const PLAYER_SDK_HOSTS = [
  'https://www.youtube.com', // iframe_api — the YouTube player
  'https://player.vimeo.com', // player.js
  'https://w.soundcloud.com', // widget api.js
  'https://www.gstatic.com', // cast_sender.js — Chromecast
  // Cloudflare Web Analytics, injected by the proxy in front of the site
  // rather than by our own code — so it is blocked here even though nothing
  // in this repo asks for it, and the only evidence is a console violation.
  'https://static.cloudflareinsights.com',
].join(' ');

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
      `script-src 'self' 'unsafe-inline' ${PLAYER_SDK_HOSTS}${IS_DEV ? " 'unsafe-eval'" : ''}`,
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
