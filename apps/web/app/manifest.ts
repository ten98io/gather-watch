import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Gather',
    short_name: 'Gather',
    description:
      'Self-hosted watch parties — synced playback, calls and chat in a private cinema drifting through space.',
    start_url: '/home',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#17141f', // --bg-void (dark), approximated to sRGB
    theme_color: '#17141f',
    categories: ['entertainment', 'social'],
    // SVG icon only for now; PNG maskable icons land with the brand pass.
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
