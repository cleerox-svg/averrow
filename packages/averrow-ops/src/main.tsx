import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '@/lib/query-client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { ToastProvider } from '@/components/ui/Toast';
import { registerServiceWorker, captureInstallPrompt } from '@/lib/pwa';
import { bootstrapTheme } from '@/design-system/hooks/useTheme';
import { bootstrapAppearance } from '@averrow/shared/theme';
import App, { preloadRouteForPath } from '@/App';
import '@/index.css';

// Apply persisted theme synchronously, before React mounts. Without
// this the page renders in default dark until UserAvatar (or
// another useTheme consumer) mounts, then snaps to the persisted
// theme — visible flash. bootstrapTheme reads localStorage and
// sets data-theme on <html> in one shot.
bootstrapTheme();
bootstrapAppearance(); // accent/base attributes (no-op in the legacy look)

// Catch Chrome's one-shot `beforeinstallprompt` before any lazy route mounts.
captureInstallPrompt();

// Start the current route's (and workspace tab's) lazy chunk now, in parallel
// with the auth round-trip, instead of after auth settles. Called here, at the
// browser entry, rather than at App.tsx module scope so importing App (tests)
// never starts module loads. An optimisation only: it must never throw.
try {
  preloadRouteForPath(window.location.pathname, window.location.search);
} catch {
  /* the route's React.lazy loads it on render instead */
}

const queryClient = createAppQueryClient();

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
