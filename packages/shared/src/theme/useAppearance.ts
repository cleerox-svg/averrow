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
// the default by changing these two constants (indigo / graphite).
//
// Like useTheme, DOM + storage side effects run synchronously in the setters
// (not in an effect) so they survive a menu unmounting mid-click. All storage
// access is wrapped in try/catch; invalid stored values fall back safely.

import { useCallback, useState } from 'react';
import { safeGetItem, safeSetItem, setRootAttr } from './storage';

export const ACCENTS = ['indigo', 'violet', 'mono', 'lime'] as const;
export const BASES = ['graphite', 'navy'] as const;

export type Accent = (typeof ACCENTS)[number];
export type Base = (typeof BASES)[number];

/** `null` = legacy look (no data-accent attribute) - TODAY ONLY. At P3-6 this
 *  flips to 'indigo' and `null` then means "the default (indigo)" rather than
 *  legacy: the legacy amber look will NOT be user-selectable after the flip
 *  (owner decision: indigo default for everyone). Keep the inline bootstrap
 *  literals in each app's index.html in sync (a test enforces it). */
export const DEFAULT_ACCENT: Accent | null = null;
/** `null` = no data-base attribute (graphite is the CSS default once an accent is set). */
export const DEFAULT_BASE: Base | null = null;

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
  /** Pass null to return to the legacy look (clears storage + attribute). */
  setAccent: (a: Accent | null) => void;
  /** Pass null to clear the base (graphite default). */
  setBase:   (b: Base | null) => void;
}

export function useAppearance(): UseAppearanceReturn {
  const [accent, setAccentState] = useState<Accent | null>(() => readStoredAccent());
  const [base, setBaseState] = useState<Base | null>(() => readStoredBase());

  const setAccent = useCallback((a: Accent | null) => {
    const next = a !== null && isAccent(a) ? a : null;
    setRootAttr('data-accent', next);
    safeSetItem(ACCENT_STORAGE_KEY, next);
    setAccentState(next);
  }, []);

  const setBase = useCallback((b: Base | null) => {
    const next = b !== null && isBase(b) ? b : null;
    setRootAttr('data-base', next);
    safeSetItem(BASE_STORAGE_KEY, next);
    setBaseState(next);
  }, []);

  return { accent, base, setAccent, setBase };
}
