import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { ToastProvider } from '@/components/ui/Toast';
import { registerServiceWorker } from '@/lib/pwa';
import { bootstrapTheme } from '@/design-system/hooks/useTheme';
import App from '@/App';
import '@/index.css';

// Apply persisted theme synchronously, before React mounts. Without
// this the page renders in default dark until UserAvatar (or
// another useTheme consumer) mounts, then snaps to the persisted
// theme — visible flash. bootstrapTheme reads localStorage and
// sets data-theme on <html> in one shot.
bootstrapTheme();

// Self-heal from stale-chunk-after-deploy failures.
//
// Route views are lazy-loaded as vite-hashed chunks
// (/v2/assets/View-HASH.js). Every deploy produces new hashes and
// deletes the previous build's chunk files. A tab left open across a
// deploy (or a warm in-memory bundle) is still running the OLD entry
// JS with the OLD chunk map; navigating client-side to a not-yet-loaded
// route calls import('/v2/assets/View-OLDHASH.js'), which 404s. Vite's
// dynamic-import wrapper detects that failure and fires 'vite:preloadError'
// on window before letting it propagate to the ErrorBoundary. Catching it
// here means we can recover with a single full reload — which re-fetches
// index.html and gets the CURRENT chunk map — instead of leaving the user
// stuck on a "Something went wrong" screen tied to the stale bundle.
//
// Loop guard: sessionStorage (not state) so it survives the reload itself,
// and a 10s cooldown so a genuinely broken chunk (bad deploy, not just a
// stale tab) reloads once, fails again, and then falls through to the
// ErrorBoundary's normal error UI instead of reload-looping forever.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'av:chunkReloadAt';
  const last = Number(sessionStorage.getItem(KEY) || 0);
  if (Date.now() - last > 10_000) {
    sessionStorage.setItem(KEY, String(Date.now()));
    event.preventDefault(); // suppress the default throw — we're handling it
    window.location.reload();
  }
  // else: within cooldown of a previous reload attempt — let the error
  // propagate to the ErrorBoundary so the user sees the real error UI
  // instead of reloading forever.
});

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
