// useCardStyle — rollback toggle for unified entity cards.
//
// Default: 'unified' (new shared EntityCard / MetricTile architecture)
// Fallback: 'classic' (preserved legacy card rendering per module)
//
// Toggle via:
//   - URL query: ?cards=classic or ?cards=unified
//     (sets localStorage so it persists across navigation)
//   - Manual localStorage.setItem('card_style', 'classic')
//
// If a feature module renders nothing different for 'classic', this hook
// has no visual effect — modules opt-in by importing and branching on it.

import { useEffect, useState } from 'react';

export type CardStyle = 'unified' | 'classic';

const STORAGE_KEY = 'card_style';

function readStyle(): CardStyle {
  if (typeof window === 'undefined') return 'unified';
  try {
    const params = new URLSearchParams(window.location.search);
    const urlOverride = params.get('cards');
    if (urlOverride === 'classic' || urlOverride === 'unified') {
      window.localStorage.setItem(STORAGE_KEY, urlOverride);
      return urlOverride;
    }
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'classic' || stored === 'unified') return stored;
  } catch {
    // localStorage blocked (private mode, etc.) — fall through to default
  }
  return 'unified';
}

/**
 * Returns the currently-active card style. React to changes via URL or localStorage.
 * Use inside a feature component to branch between classic and unified rendering.
 */
export function useCardStyle(): CardStyle {
  const [style, setStyle] = useState<CardStyle>(() => readStyle());

  useEffect(() => {
    // Re-read on mount (handles hydration)
    setStyle(readStyle());

    // Sync across tabs if localStorage changes
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setStyle(readStyle());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return style;
}
