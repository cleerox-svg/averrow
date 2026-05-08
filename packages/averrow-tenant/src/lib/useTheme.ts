// Theme switching for averrow-tenant.
//
// Mirrors averrow-ui/src/design-system/hooks/useTheme.ts so the
// preference key stays compatible (averrow-theme in localStorage)
// — staff who switch between back-office and tenant sessions on
// the same browser get a consistent theme.
//
// Applied via document.documentElement[data-theme]; the index.css
// rules and Tailwind theme tokens read off that attribute.

import { useState, useEffect, useCallback } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'averrow-theme';

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
      return stored === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Storage may be unavailable (incognito mode, server-side, …)
    }
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return {
    theme,
    setTheme,
    toggle,
    isDark:  theme === 'dark',
    isLight: theme === 'light',
  };
}
