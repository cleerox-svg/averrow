// Averrow shared - useAppearance hook + bootstrap.
//
// Two independent appearance axes layered on top of useTheme:
//   - accent: 'indigo' | 'violet' | 'mono' | 'lime'  -> <html data-accent>
//             localStorage key `averrow-accent`
//   - base:   'graphite' | 'navy'                    -> <html data-base>
//             localStorage key `averrow-base` (dark mode only; light ignores it)
//
// Mode (dark/light/auto) stays in useTheme / `averrow-theme`, untouched.
//
// DEFAULT_ACCENT / DEFAULT_BASE are `null` = the legacy look: no attribute is
// written, so the unscoped tokens in tokens.css apply. Phase 3 PR P3-6 flips
// the default by changing these two constants in ./appearanceDefaults.ts
// (indigo / graphite).
//
// Like useTheme, DOM + storage side effects run synchronously in the setters
// (not in an effect) so they survive a menu unmounting mid-click. All storage
// access is wrapped in try/catch; invalid stored values fall back safely.

import { useCallback, useState } from 'react';
import { safeGetItem, safeSetItem, setRootAttr } from './storage';
import { ACCENTS, BASES, DEFAULT_ACCENT, DEFAULT_BASE } from './appearanceDefaults';
import type { Accent, Base } from './appearanceDefaults';

// The constants live in ./appearanceDefaults (a separate module so tests can
// simulate the P3-6 flip); re-exported here for the public API.
export { ACCENTS, BASES, DEFAULT_ACCENT, DEFAULT_BASE } from './appearanceDefaults';
export type { Accent, Base } from './appearanceDefaults';

export const ACCENT_STORAGE_KEY = 'averrow-accent';
export const BASE_STORAGE_KEY = 'averrow-base';

export function isAccent(v: unknown): v is Accent {
  return typeof v === 'string' && (ACCENTS as readonly string[]).includes(v);
}
export function isBase(v: unknown): v is Base {
  return typeof v === 'string' && (BASES as readonly string[]).includes(v);
}

/** Stored accent, or the default when absent/invalid. */
export function readStoredAccent(): Accent | null {
  const raw = safeGetItem(ACCENT_STORAGE_KEY);
  return isAccent(raw) ? raw : DEFAULT_ACCENT;
}

/** Stored base, or the default when absent/invalid. */
export function readStoredBase(): Base | null {
  const raw = safeGetItem(BASE_STORAGE_KEY);
  return isBase(raw) ? raw : DEFAULT_BASE;
}

/** Apply stored (or default) accent/base to <html>. Call once at app boot,
 *  next to bootstrapTheme(). The inline script in each app's index.html does
 *  the same before first paint; this keeps the two in sync and is idempotent. */
export function bootstrapAppearance(): { accent: Accent | null; base: Base | null } {
  const accent = readStoredAccent();
  const base = readStoredBase();
  setRootAttr('data-accent', accent);
  setRootAttr('data-base', base);
  return { accent, base };
}

export interface UseAppearanceReturn {
  /** null = legacy look (no data-accent). */
  accent:    Accent | null;
  /** null = default base (graphite once an accent is set). */
  base:      Base | null;
  /** Pass null to return to the default: clears storage and applies
   *  DEFAULT_ACCENT (today null = legacy look, no attribute; after P3-6 indigo). */
  setAccent: (a: Accent | null) => void;
  /** Pass null to return to the default: clears storage and applies DEFAULT_BASE. */
  setBase:   (b: Base | null) => void;
}

export function useAppearance(): UseAppearanceReturn {
  const [accent, setAccentState] = useState<Accent | null>(() => readStoredAccent());
  const [base, setBaseState] = useState<Base | null>(() => readStoredBase());

  const setAccent = useCallback((a: Accent | null) => {
    const chosen = a !== null && isAccent(a) ? a : null;
    // null/invalid = "the default": nothing stored (so a later default change
    // follows), DEFAULT_ACCENT applied.
    const next = chosen ?? DEFAULT_ACCENT;
    setRootAttr('data-accent', next);
    safeSetItem(ACCENT_STORAGE_KEY, chosen);
    setAccentState(next);
  }, []);

  const setBase = useCallback((b: Base | null) => {
    const chosen = b !== null && isBase(b) ? b : null;
    const next = chosen ?? DEFAULT_BASE;
    setRootAttr('data-base', next);
    safeSetItem(BASE_STORAGE_KEY, chosen);
    setBaseState(next);
  }, []);

  return { accent, base, setAccent, setBase };
}
