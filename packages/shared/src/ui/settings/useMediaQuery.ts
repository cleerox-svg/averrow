import { useCallback, useSyncExternalStore } from 'react';

/**
 * SSR-safe `matchMedia` subscription. `fallback` is used when matchMedia is
 * unavailable (SSR, bare jsdom).
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, [query]);
  const get = useCallback(
    () =>
      typeof window === 'undefined' || typeof window.matchMedia !== 'function'
        ? fallback
        : window.matchMedia(query).matches,
    [query, fallback],
  );
  return useSyncExternalStore(subscribe, get, () => fallback);
}
