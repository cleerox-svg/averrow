// Shell-level version toggle (v4 redesign coexistence).
//
// This flips the WHOLE app shell between the current chrome and the new
// cinematic v4 shell, while both render the exact same route <Outlet/>.
// localStorage-persisted, synced across tabs via the storage event.
//
// Default stays 'current' until the W4 cutover flips it to 'v4'.

import { useState, useEffect, useCallback } from 'react';

export type ShellVersion = 'current' | 'v4';

const STORAGE_KEY = 'averrow.shell-version';
const DEFAULT: ShellVersion = 'current';

function read(): ShellVersion {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'v4' || stored === 'current' ? stored : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function useShellVersion() {
  const [version, setVersionState] = useState<ShellVersion>(() => read());

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      const next = e.newValue;
      if (next === 'v4' || next === 'current') setVersionState(next);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setVersion = useCallback((v: ShellVersion) => {
    setVersionState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {}
  }, []);

  return { version, setVersion, isV4: version === 'v4' };
}
