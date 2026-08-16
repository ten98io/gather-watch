/**
 * The create-room dialog offers NO watch/listen mode choice any more — a room
 * is just a room and the stage adapts to what plays. The home page is
 * SSR-rendered; the dialog module is mocked to render its children directly
 * because the real <DialogContent> portals after mount, which a server render
 * never reaches — the form inside is the real one from app/home/page.tsx.
 *
 * Auth and theme hooks are mocked at the module seam (signed-out, loading):
 * the page still mounts the create dialog, which is all this suite is about.
 */
import * as React from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: null, loading: true, logout: async () => {} }),
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: () => {}, toggle: () => {} }),
}));

vi.mock('@/components/ui/dialog', async () => {
  const { createElement, Fragment } = await import('react');
  const passthrough = ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children);
  return {
    Dialog: passthrough,
    DialogContent: passthrough,
    DialogTitle: passthrough,
    DialogDescription: passthrough,
  };
});

// Classic-runtime shim (see test/helpers/room-render.ts).
(globalThis as unknown as { React: typeof React }).React = React;
const { default: HomePage } = await import('@/app/home/page');

function renderHome(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client }, React.createElement(HomePage)),
  );
}

describe('create-room dialog', () => {
  it('renders the name field and submit, with no mode toggle', () => {
    const html = renderHome();
    expect(html).toContain('Room name');
    expect(html).toContain('Create room');
    expect(html).not.toContain('🎬');
    expect(html).not.toContain('🎧');
    expect(html).not.toContain('>Mode<');
    expect(html).not.toContain('aria-pressed');
  });
});
