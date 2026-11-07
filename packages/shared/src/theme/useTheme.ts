// Averrow shared — useTheme hook + bootstrap.
//
// Three-mode theme: 'auto' | 'dark' | 'light'.
// - 'auto' follows the OS via prefers-color-scheme. The DOM
//   data-theme attribute always resolves to 'dark' | 'light' so
//   CSS only ever sees the two concrete states.
// - When the user picks 'dark' or 'light' explicitly, OS changes
//   are ignored.
//
// Side effects (DOM attribute + localStorage) happen
// SYNCHRONOUSLY inside setTheme/toggle, NOT in a useEffect — when
// the hook is mounted inside a dropdown menu and the user clicks
// the toggle, the menu unmounts before React commits effects, so
// a useEffect-based approach silently no-ops. Surfaced via the
// avatar dropdown's "Light Mode" item being a no-op while
// /v2/profile's toggle worked correctly. Audit fix 2026-05-08.

import { useEffect, useState, useCallback, useRef } from 'react';
import { safeGetItem, safeSetItem, setRootAttr } from './storage';
import { markLocalPick } from './accountSync';

export type Theme         = 'auto' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'averrow-theme';
const SYSTEM_QUERY = '(prefers-color-scheme: light)';

function readSystemPreference(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia(SYSTEM_QUERY).matches ? 'light' : 'dark';
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'auto') return readSystemPreference();
  return theme;
}

function applyTheme(resolved: ResolvedTheme): void {
  setRootAttr('data-theme', resolved);
}

function persistTheme(theme: Theme): void {
  safeSetItem(STORAGE_KEY, theme);
}

function readStoredTheme(): Theme {
  const raw = safeGetItem(STORAGE_KEY);
  return raw === 'auto' || raw === 'dark' || raw === 'light' ? raw : 'auto';
}

/** Read once on app boot so the theme is correct on first paint
 *  even before any component mounts useTheme(). Called from
 *  main.tsx. Returns the user's preference (which may be 'auto');
 *  resolved value is what hits the DOM.
 *
 *  Also installs a `prefers-color-scheme` listener so 'auto'
 *  reflects OS changes live without a reload. Idempotent —
 *  re-calls just no-op the listener install (we use a module-level
 *  flag). */
let systemListenerInstalled = false;

export function bootstrapTheme(): Theme {
  const stored = readStoredTheme();
  applyTheme(resolveTheme(stored));
  if (!systemListenerInstalled && typeof window !== 'undefined' && window.matchMedia) {
    systemListenerInstalled = true;
    const mq = window.matchMedia(SYSTEM_QUERY);
    const listener = () => {
      const current = readStoredTheme();
      if (current === 'auto') applyTheme(resolveTheme(current));
    };
    // Modern + Safari fallback.
    if (mq.addEventListener) mq.addEventListener('change', listener);
    else if (mq.addListener)  mq.addListener(listener);
  }
  return stored;
}

export interface UseThemeReturn {
  /** The user's preference. May be 'auto'. */
  theme:         Theme;
  /** What's actually on the DOM right now ('dark' | 'light'). */
  resolvedTheme: ResolvedTheme;
  /** Set the preference. Side effects (DOM + storage) happen
   *  synchronously. */
  setTheme:      (t: Theme) => void;
  /** Cycle preference: auto → dark → light → auto. */
  cycle:         () => void;
  isDark:        boolean;
  isLight:       boolean;
  isAuto:        boolean;
}

// Every mounted useTheme() follows a preference set anywhere (another
// instance, or the account hydration after /api/auth/me).
const themeListeners = new Set<(t: Theme) => void>();

/** Apply a theme preference: DOM + storage + every mounted useTheme(). Does
 *  NOT count as a local pick (the account hydration uses it). */
export function applyThemePreference(t: Theme): void {
  applyTheme(resolveTheme(t));
  persistTheme(t);
  for (const l of [...themeListeners]) l(t);
}

/** True for the preference values the account / storage may carry. */
export function isTheme(v: unknown): v is Theme {
  return v === 'auto' || v === 'dark' || v === 'light';
}

export function useTheme(): UseThemeReturn {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [resolved, setResolvedState] = useState<ResolvedTheme>(() => {
    if (typeof document === 'undefined') return 'dark';
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    return resolveTheme(theme);
  });

  // Subscribe to system pref changes ONLY while in 'auto' so the
  // hook re-renders when the OS flips. The bootstrap-level
  // listener already updates the DOM; this keeps the React
  // resolved state in sync.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(SYSTEM_QUERY);
    const onChange = () => {
      if (readStoredTheme() === 'auto') {
        const next = resolveTheme('auto');
        applyTheme(next);
        setResolvedState(next);
      }
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener)  mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener)  mq.removeListener(onChange);
    };
  }, []);

  // Follow preferences applied by other instances / the account hydration.
  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme;
  useEffect(() => {
    const onApply = (t: Theme) => {
      setThemeState(t);
      setResolvedState(resolveTheme(t));
    };
    themeListeners.add(onApply);
    return () => { themeListeners.delete(onApply); };
  }, []);

  // A user choice on this device: the account hydration must not overwrite it.
  const setTheme = useCallback((t: Theme) => {
    markLocalPick('theme');
    applyThemePreference(t);
  }, []);

  const cycle = useCallback(() => {
    const order: Theme[] = ['auto', 'dark', 'light'];
    const idx = order.indexOf(themeRef.current);
    const nextTheme: Theme = order[(idx + 1) % order.length] ?? 'auto';
    themeRef.current = nextTheme;
    markLocalPick('theme');
    applyThemePreference(nextTheme);
  }, []);

  return {
    theme,
    resolvedTheme: resolved,
    setTheme,
    cycle,
    isDark:  resolved === 'dark',
    isLight: resolved === 'light',
    isAuto:  theme === 'auto',
  };
}
