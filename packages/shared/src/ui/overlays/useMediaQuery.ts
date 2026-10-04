import { useCallback, useSyncExternalStore } from 'react';

/** Phones + coarse-pointer tablets in portrait: overlays become bottom sheets. */
export const COMPACT_QUERY = '(max-width: 767px), (pointer: coarse) and (max-width: 1023px)';

/**
 * SSR-safe `matchMedia` subscription. Returns `defaultValue` on the server,
 * during hydration and wherever `matchMedia` is unavailable (jsdom).
 */
export function useMediaQuery(query: string, defaultValue = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = useCallback((): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return defaultValue;
    return window.matchMedia(query).matches;
  }, [query, defaultValue]);
  return useSyncExternalStore(subscribe, getSnapshot, () => defaultValue);
}

/** True when overlays should present as bottom sheets. */
export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}
