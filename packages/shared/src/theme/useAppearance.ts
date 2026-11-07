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
//
// Shared store (P3-5): every useAppearance() instance reads one module-level
// snapshot, so a picker in Settings and any other reader stay in sync, and a
// `storage` event from another tab re-applies the attributes and notifies
// them. While no component is subscribed the snapshot is re-read from storage
// on every read, so a fresh mount always sees what is stored.
//
// Account sync (P3-5): accent/base are also saved on the user's account
// (users.accent_preference / base_preference, PATCH /api/profile).
// hydrateAppearanceFromAccount() applies the server values after the session
// user is validated (server wins over localStorage, which stays the no-flash
// cache). It is a no-op while APPEARANCE_PICKER_ENABLED is false.

import { useCallback, useSyncExternalStore } from 'react';
import { safeGetItem, safeSetItem, setRootAttr } from './storage';
import { ACCENTS, APPEARANCE_PICKER_ENABLED, BASES, DEFAULT_ACCENT, DEFAULT_BASE } from './appearanceDefaults';
import type { Accent, Base } from './appearanceDefaults';

// The constants live in ./appearanceDefaults (a separate module so tests can
// simulate the P3-6 flip); re-exported here for the public API.
export { ACCENTS, APPEARANCE_PICKER_ENABLED, BASES, DEFAULT_ACCENT, DEFAULT_BASE } from './appearanceDefaults';
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
  ensureStorageListener();
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

// ── shared store ──────────────────────────────────────────────────────

interface Snapshot { accent: Accent | null; base: Base | null }

let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();
let storageListenerInstalled = false;

function readSnapshot(): Snapshot {
  return { accent: readStoredAccent(), base: readStoredBase() };
}

/** Replace the snapshot (keeping the old object when nothing changed, so
 *  useSyncExternalStore sees a stable reference) and notify on change. */
function commit(next: Snapshot): void {
  if (snapshot && snapshot.accent === next.accent && snapshot.base === next.base) return;
  snapshot = next;
  for (const l of [...listeners]) l();
}

function getSnapshot(): Snapshot {
  // Unsubscribed: storage is the truth (it may have been written directly).
  if (!snapshot || listeners.size === 0) {
    const fresh = readSnapshot();
    if (!snapshot || snapshot.accent !== fresh.accent || snapshot.base !== fresh.base) snapshot = fresh;
  }
  return snapshot;
}

const SERVER_SNAPSHOT: Snapshot = { accent: DEFAULT_ACCENT, base: DEFAULT_BASE };
const getServerSnapshot = (): Snapshot => SERVER_SNAPSHOT;

function onStorage(e: StorageEvent): void {
  // key === null: another tab called localStorage.clear().
  if (e.key !== null && e.key !== ACCENT_STORAGE_KEY && e.key !== BASE_STORAGE_KEY) return;
  const next = readSnapshot();
  setRootAttr('data-accent', next.accent);
  setRootAttr('data-base', next.base);
  commit(next);
}

/** Follow accent/base changes made in other tabs (idempotent). */
function ensureStorageListener(): void {
  if (storageListenerInstalled || typeof window === 'undefined') return;
  storageListenerInstalled = true;
  window.addEventListener('storage', onStorage);
}

function subscribe(cb: () => void): () => void {
  ensureStorageListener();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Apply an accent: attribute + storage + every subscribed hook. null/invalid
 *  = "the default": nothing stored (so a later default change is followed),
 *  DEFAULT_ACCENT applied. */
export function applyAccent(a: Accent | null): void {
  const chosen = a !== null && isAccent(a) ? a : null;
  const next = chosen ?? DEFAULT_ACCENT;
  setRootAttr('data-accent', next);
  safeSetItem(ACCENT_STORAGE_KEY, chosen);
  commit({ accent: next, base: getSnapshot().base });
}

/** Apply a base: attribute + storage + every subscribed hook. null/invalid = the default. */
export function applyBase(b: Base | null): void {
  const chosen = b !== null && isBase(b) ? b : null;
  const next = chosen ?? DEFAULT_BASE;
  setRootAttr('data-base', next);
  safeSetItem(BASE_STORAGE_KEY, chosen);
  commit({ accent: getSnapshot().accent, base: next });
}

/** The account's saved appearance, as /api/auth/me and /api/profile return it. */
export interface AccountAppearance {
  accent_preference?: string | null;
  base_preference?: string | null;
}

/**
 * Apply the account's saved accent/base (server wins over localStorage).
 * Only fields PRESENT on `user` are applied, so a response from an older
 * Worker (or a cached user written before 0317) never clears a choice;
 * a present null or unknown value means "the default". No-op while
 * APPEARANCE_PICKER_ENABLED is false (nothing changes before the P3-6 flip).
 */
export function hydrateAppearanceFromAccount(user: AccountAppearance | null | undefined): void {
  if (!APPEARANCE_PICKER_ENABLED || !user || typeof user !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(user, 'accent_preference')) {
    const v = user.accent_preference;
    applyAccent(isAccent(v) ? v : null);
  }
  if (Object.prototype.hasOwnProperty.call(user, 'base_preference')) {
    const v = user.base_preference;
    applyBase(isBase(v) ? v : null);
  }
}

export function useAppearance(): UseAppearanceReturn {
  const { accent, base } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setAccent = useCallback((a: Accent | null) => applyAccent(a), []);
  const setBase = useCallback((b: Base | null) => applyBase(b), []);
  return { accent, base, setAccent, setBase };
}

/** Test hook: drop the shared snapshot (module state is global). */
export function __resetAppearanceStoreForTests(): void {
  snapshot = null;
}
