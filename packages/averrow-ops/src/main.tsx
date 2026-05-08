import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { ToastProvider } from '@/components/ui/Toast';
import { registerServiceWorker } from '@/lib/pwa';
import App from '@/App';
import '@/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 30-minute staleTime means tab-switching between pages doesn't trigger
      // a refetch storm. Threat intel changes on a 15-min cron at the fastest,
      // so 5 minutes was needlessly aggressive — every nav was hitting D1
      // again for data the user had loaded seconds earlier. With 30 minutes,
      // a typical session of cross-navigation between Brands/Threats/Campaigns
      // touches the network once per resource per half-hour. Mutations still
      // invalidate their relevant keys explicitly, so write paths stay correct.
      staleTime: 30 * 60_000, // 30 minutes
      gcTime:    60 * 60_000, // 60 minutes — keep in cache even when not displayed
      retry: (failureCount, error: any) => {
        // Don't retry 4xx errors — only retry network/5xx errors
        if (error?.status >= 400 && error?.status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

// Apply stored theme before React mounts — prevents flash
(function() {
  try {
    const stored = localStorage.getItem('averrow-theme');
    if (stored === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch {}
})();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/v2">
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);

registerServiceWorker();
