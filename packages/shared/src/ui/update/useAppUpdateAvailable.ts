import * as React from 'react';
import { currentAssets, isNewBuildAvailable } from './appUpdate';

// Checked when the app comes back to the foreground (a home-screen / resumed
// tab is not relaunched) and every 30 minutes while open, only while visible,
// at most once a minute. Never reloads by itself: reloading under someone
// mid-form would lose what they typed. Once an update is found the checks stop
// (the banner stays until Reload).
//
// A lazy route chunk that fails to load (Vite fires `vite:preloadError`) is
// the other tell-tale of a deploy that replaced files under an open tab; it
// raises the same banner. The error itself is not swallowed.

export const UPDATE_MIN_GAP_MS = 60_000;
export const UPDATE_INTERVAL_MS = 30 * 60_000;

/** `shellUrl`: the app's own shell, `/ops/` (ops) or `/tenant/` (tenant). */
export function useAppUpdateAvailable(shellUrl: string): boolean {
  const [available, setAvailable] = React.useState(false);

  React.useEffect(() => {
    if (available) return undefined;
    const hasBuiltAssets = currentAssets().size > 0;
    if (!hasBuiltAssets) return undefined; // dev server / tests: nothing to compare
    let last = 0;
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last < UPDATE_MIN_GAP_MS) return;
      last = now;
      // Also let the browser pick up a new service worker (ops only; tenant has none).
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.update();
      } catch {
        /* best effort */
      }
      if (await isNewBuildAvailable(currentAssets(), shellUrl)) {
        if (!stopped) setAvailable(true);
      }
    };
    const onCheck = () => { void check(); };
    const onPreloadError = () => { if (!stopped) setAvailable(true); };
    document.addEventListener('visibilitychange', onCheck);
    window.addEventListener('focus', onCheck);
    window.addEventListener('online', onCheck);
    window.addEventListener('vite:preloadError', onPreloadError);
    const timer = window.setInterval(onCheck, UPDATE_INTERVAL_MS);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onCheck);
      window.removeEventListener('focus', onCheck);
      window.removeEventListener('online', onCheck);
      window.removeEventListener('vite:preloadError', onPreloadError);
      window.clearInterval(timer);
    };
  }, [shellUrl, available]);

  return available;
}
