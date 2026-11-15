import * as React from 'react';
import { currentBuildScript, isNewBuildAvailable } from './appUpdate';

// Checked when the app comes back to the foreground (a home-screen / resumed
// tab is not relaunched) and every 30 minutes while open, only while visible,
// at most once a minute. Never reloads by itself: reloading under someone
// mid-form would lose what they typed.

export const UPDATE_MIN_GAP_MS = 60_000;
export const UPDATE_INTERVAL_MS = 30 * 60_000;

/** `shellUrl`: the app's own shell, `/v2/` (ops) or `/tenant/` (tenant). */
export function useAppUpdateAvailable(shellUrl: string): boolean {
  const [available, setAvailable] = React.useState(false);

  React.useEffect(() => {
    const current = currentBuildScript();
    if (!current) return undefined; // dev server / tests: nothing to compare
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
      if (await isNewBuildAvailable(current, shellUrl)) {
        if (!stopped) setAvailable(true);
      }
    };
    const onCheck = () => { void check(); };
    document.addEventListener('visibilitychange', onCheck);
    window.addEventListener('focus', onCheck);
    window.addEventListener('online', onCheck);
    const timer = window.setInterval(onCheck, UPDATE_INTERVAL_MS);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onCheck);
      window.removeEventListener('focus', onCheck);
      window.removeEventListener('online', onCheck);
      window.clearInterval(timer);
    };
  }, [shellUrl]);

  return available;
}
