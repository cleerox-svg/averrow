// Averrow Design System — useObservatoryVersion hook
// Picks which Observatory map to render: v3 (default — GPU TripsLayer)
// or v2 (legacy fallback). Persisted in localStorage so the choice
// survives reloads, and synced across tabs via the storage event so
// flipping it in one tab updates a sibling.

import { useState, useEffect, useCallback } from 'react';

export type ObservatoryVersion = 'v2' | 'v3';

const STORAGE_KEY = 'averrow.observatory-version';
const DEFAULT_VERSION: ObservatoryVersion = 'v3';

function read(): ObservatoryVersion {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'v2' || stored === 'v3' ? stored : DEFAULT_VERSION;
  } catch {
    return DEFAULT_VERSION;
  }
}

export function pathForObservatoryVersion(version: ObservatoryVersion): string {
  return version === 'v3' ? '/observatory-v3' : '/observatory';
}

export function useObservatoryVersion() {
  const [version, setVersionState] = useState<ObservatoryVersion>(read);

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      const next = e.newValue;
      if (next === 'v2' || next === 'v3') setVersionState(next);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setVersion = useCallback((v: ObservatoryVersion) => {
    setVersionState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {}
  }, []);

  return {
    version,
    setVersion,
    isV2: version === 'v2',
    isV3: version === 'v3',
    path: pathForObservatoryVersion(version),
  };
}
