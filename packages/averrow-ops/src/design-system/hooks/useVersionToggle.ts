// Generic V2/V3 version toggle for any platform surface.
// Persisted in localStorage, synced across tabs via the storage event.
//
// Add a new surface by adding a row to SURFACES — the hook + the
// VersionToggle component pick it up automatically.

import { useState, useEffect, useCallback } from 'react';

export type Version = 'v2' | 'v3';

export type Surface = 'observatory' | 'agents' | 'feeds' | 'metrics';

interface SurfaceConfig {
  storageKey:     string;
  defaultVersion: Version;
  paths:          Record<Version, string>;
}

export const SURFACES: Record<Surface, SurfaceConfig> = {
  observatory: {
    storageKey:     'averrow.observatory-version',
    defaultVersion: 'v3', // existing default — v3 GPU TripsLayer ships first
    paths:          { v2: '/observatory', v3: '/observatory-v3' },
  },
  agents: {
    storageKey:     'averrow.agents-version',
    defaultVersion: 'v2', // safe default until v3 reaches parity
    paths:          { v2: '/agents', v3: '/agents-v3' },
  },
  feeds: {
    storageKey:     'averrow.feeds-version',
    defaultVersion: 'v2',
    paths:          { v2: '/feeds', v3: '/feeds-v3' },
  },
  metrics: {
    storageKey:     'averrow.metrics-version',
    defaultVersion: 'v2',
    paths:          { v2: '/admin/metrics', v3: '/admin/metrics-v3' },
  },
};

function read(surface: Surface): Version {
  const cfg = SURFACES[surface];
  try {
    const stored = localStorage.getItem(cfg.storageKey);
    return stored === 'v2' || stored === 'v3' ? stored : cfg.defaultVersion;
  } catch {
    return cfg.defaultVersion;
  }
}

export function pathForVersion(surface: Surface, version: Version): string {
  return SURFACES[surface].paths[version];
}

export function useVersionToggle(surface: Surface) {
  const cfg = SURFACES[surface];
  const [version, setVersionState] = useState<Version>(() => read(surface));

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== cfg.storageKey) return;
      const next = e.newValue;
      if (next === 'v2' || next === 'v3') setVersionState(next);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [cfg.storageKey]);

  const setVersion = useCallback((v: Version) => {
    setVersionState(v);
    try {
      localStorage.setItem(cfg.storageKey, v);
    } catch {}
  }, [cfg.storageKey]);

  return {
    version,
    setVersion,
    isV2: version === 'v2',
    isV3: version === 'v3',
    path: pathForVersion(surface, version),
  };
}
