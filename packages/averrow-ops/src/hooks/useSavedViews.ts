// useSavedViews — localStorage-backed named filter sets for queue surfaces.
//
// SOC queues are expected to let an analyst pin a filter combination ("new
// high-sev app-store impersonations") and return to it, instead of rebuilding
// it every session (audit Batch 2, W6). This is the generic store; each
// surface supplies its own filter shape `T` and a storage key.
//
// Follows the codebase localStorage convention (useCardStyle): SSR guard,
// try/catch for blocked storage, cross-tab sync via the `storage` event.

import { useCallback, useEffect, useState } from 'react';

export interface SavedView<T> {
  id: string;
  name: string;
  filters: T;
}

export function useSavedViews<T>(storageKey: string) {
  const read = useCallback((): SavedView<T>[] => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SavedView<T>[]) : [];
    } catch {
      return [];
    }
  }, [storageKey]);

  const [views, setViews] = useState<SavedView<T>[]>(read);

  useEffect(() => {
    setViews(read());
    function onStorage(e: StorageEvent) {
      if (e.key === storageKey) setViews(read());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [read, storageKey]);

  const persist = useCallback((next: SavedView<T>[]) => {
    setViews(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // storage blocked — keep in-memory only for this session
    }
  }, [storageKey]);

  const saveView = useCallback((name: string, filters: T): string => {
    const id = `v_${Date.now().toString(36)}`;
    persist([...read(), { id, name, filters }]);
    return id;
  }, [persist, read]);

  const removeView = useCallback((id: string) => {
    persist(read().filter(v => v.id !== id));
  }, [persist, read]);

  return { views, saveView, removeView };
}
