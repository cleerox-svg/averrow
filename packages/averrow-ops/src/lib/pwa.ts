/**
 * PWA helpers — service worker registration + install/standalone detection.
 *
 * The SW is hand-rolled at /v2/sw.js (no vite-plugin-pwa) and scoped to /v2/
 * so it never touches the legacy SPA at /. See public/sw.js for the strategies.
 *
 * `isStandalone()` is the gate to use later when wiring Web Push: iOS only
 * allows `Notification.permission` requests when the PWA is installed (Add to
 * Home Screen). PR 3 (push notifications) will read this.
 */

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // Don't run the SW against the Vite dev server — it caches the dev shell
  // and breaks HMR. localhost / 127.0.0.1 is sufficient; unregister via
  // DevTools → Application → Service Workers if one slips through.
  const host = typeof location !== 'undefined' ? location.hostname : '';
  if (host === 'localhost' || host === '127.0.0.1') return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/v2/sw.js', { scope: '/v2/' })
      .catch((err) => {
        // Swallow — SW failure should never break the app.
        console.warn('[pwa] service worker registration failed:', err);
      });
  });
}

/** True when the page is running as an installed PWA (standalone display mode). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari uses a non-standard `navigator.standalone` flag.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Convenience for iOS-specific PWA prompts (Web Push gating, install hints). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iP(ad|hone|od)/.test(navigator.userAgent);
}
