// Phase 1 of the unified Home rebuild — feature flag.
//
// Gates the new responsive Command Center (HomeUnified) so it can ship
// progressively without disrupting the current Home / MobileCommandCenter.
//
// How to opt in (one of):
//   1. Visit /?home=v2 once. The choice is persisted to localStorage,
//      so subsequent visits to / will render HomeUnified automatically.
//   2. Run `localStorage.setItem('averrow_home_v2', 'true')` in devtools.
//
// How to opt out:
//   1. Visit /?home=v1 once. Clears the localStorage flag.
//   2. Run `localStorage.removeItem('averrow_home_v2')` in devtools.
//
// Default: off. Existing Home / MobileCommandCenter render as before
// for everyone who hasn't opted in.

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'averrow_home_v2';

function readInitial(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const param = params.get('home');
    if (param === 'v2') {
      window.localStorage.setItem(STORAGE_KEY, 'true');
      return true;
    }
    if (param === 'v1') {
      window.localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // localStorage may throw in private mode — fall through to off.
    return false;
  }
}

export function useHomeFlag(): boolean {
  const [enabled, setEnabled] = useState(readInitial);

  // Re-read when the page becomes visible — covers the case where
  // someone toggled the flag in another tab and switched back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setEnabled(readInitial());
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return enabled;
}
