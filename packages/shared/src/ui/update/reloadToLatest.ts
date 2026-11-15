// Reload onto the newest deploy. Always follows an explicit click.
//
// Ops has a service worker, tenant has none. With a registration, a waiting
// worker is told to take over (SKIP_WAITING) first, so the reload is not
// controlled by an old worker. No cache deletion is needed: the ops worker
// serves navigations network-first (shell cache is an offline fallback only)
// and Vite asset names are content-hashed, so the reload fetches the new
// index.html and the new bundles.

export interface ReloadToLatestOptions {
  /** Test seam. Default: `location.reload()`. */
  reload?: () => void;
}

/** A hung worker lookup (stalled network) must not block the reload. */
const SW_STEP_TIMEOUT_MS = 3000;

export async function reloadToLatest(options: ReloadToLatestOptions = {}): Promise<void> {
  const reload = options.reload ?? (() => window.location.reload());
  try {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (sw) {
      const reg = await Promise.race([
        sw.getRegistration(),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), SW_STEP_TIMEOUT_MS)),
      ]);
      reg?.waiting?.postMessage({ type: 'SKIP_WAITING' });
    }
  } catch {
    /* best effort: never block the reload */
  }
  reload();
}
