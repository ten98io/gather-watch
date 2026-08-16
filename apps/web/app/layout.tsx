import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

/* Typography per DESIGN.md §3: Space Grotesk display, Inter text, JetBrains
   Mono for invite codes / debug HUD. */
const display = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-display',
});
const sans = Inter({ subsets: ['latin'], variable: '--font-sans' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: { default: 'Gather', template: '%s · Gather' },
  description:
    'Gather — self-hosted watch parties. Synced playback, calls and chat in a private cinema drifting through space.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Gather',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Gather' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#17141f' },
    { media: '(prefers-color-scheme: light)', color: '#f6f5fa' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

/** Set data-theme before first paint so the dark default never flashes light. */
const themeInit = `(function(){try{var t=localStorage.getItem('gather:theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <div aria-hidden className="void-aurora" />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
