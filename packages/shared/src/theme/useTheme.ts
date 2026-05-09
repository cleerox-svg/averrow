// Averrow Design System — useTheme hook
// Manages dark/light theme switching.
// Stores preference in localStorage, applies via data-theme on <html>.
//
// Side effects (DOM attribute + localStorage) happen SYNCHRONOUSLY
// inside setTheme/toggle, NOT in a useEffect. This is critical: when
// the hook is mounted inside a dropdown menu (e.g. UserAvatar's
// ProfileMenu) and the user clicks the toggle item, the menu
// unmounts before React commits effects. The state update would
// fire but the useEffect that applied the change to the DOM would
// never run — the toggle would silently do nothing. Surfaced via
// the avatar dropdown's "Light Mode" item being a no-op while
// /v2/profile's toggle worked correctly. Audit fix 2026-05-08.

import { useState, useCallback } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'averrow-theme';

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

function persistTheme(theme: Theme) {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch {}
}

/** Read once on app boot so the theme is correct on first paint
 *  even before any component mounts useTheme(). Called from
 *  main.tsx. */
export function bootstrapTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  let stored: Theme = 'dark';
  try {
    const raw = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (raw === 'light') stored = 'light';
  } catch {}
  applyTheme(stored);
  return stored;
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof document === 'undefined') return 'dark';
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
      return stored === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  const setTheme = useCallback((t: Theme) => {
    applyTheme(t);
    persistTheme(t);
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setThemeState(prev => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      persistTheme(next);
      return next;
    });
  }, []);

  return {
    theme,
    setTheme,
    toggle,
    isDark:  theme === 'dark',
    isLight: theme === 'light',
  };
}
