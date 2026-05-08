// Theme switching for averrow-tenant.
//
// Mirrors averrow-ops/src/design-system/hooks/useTheme.ts so the
// preference key stays compatible (averrow-theme in localStorage)
// — staff who switch between back-office and tenant sessions on
// the same browser get a consistent theme.
//
// Side effects (DOM attribute + localStorage) happen SYNCHRONOUSLY
// inside setTheme/toggle, NOT in a useEffect. When the hook is
// mounted inside a dropdown (TopBar avatar menu) and the user
// clicks the toggle, the menu unmounts before React commits
// effects — so a useEffect-based approach silently no-ops.

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

/** Read once on app boot so the theme is correct on first paint. */
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
    setThemeState((prev) => {
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
