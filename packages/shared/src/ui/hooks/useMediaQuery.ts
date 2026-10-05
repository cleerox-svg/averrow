import { useCallback, useSyncExternalStore } from 'react';

type LegacyMql = MediaQueryList & {
  addListener?: (cb: () => void) => void;
  removeListener?: (cb: () => void) => void;
};

/**
 * SSR-safe `matchMedia` subscription (the one shared implementation).
 * `fallback` is used on the server, during hydration and wherever matchMedia
 * is unavailable (bare jsdom). Older Safari only has addListener/removeListener.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const mql = window.matchMedia(query) as LegacyMql;
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener?.(onChange);
    return () => mql.removeListener?.(onChange);
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
