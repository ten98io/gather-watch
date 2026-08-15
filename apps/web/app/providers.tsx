'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { Toaster } from '@/components/ui/toast';
import { useServiceWorker } from '@/hooks/useServiceWorker';

function ServiceWorkerRegistration(): null {
  useServiceWorker();
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {children}
        <Toaster />
        <ServiceWorkerRegistration />
      </AuthProvider>
    </QueryClientProvider>
  );
}
