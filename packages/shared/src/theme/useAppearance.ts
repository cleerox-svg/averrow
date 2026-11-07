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
// hydrateAppearanceFromAccount() applies the server values (and the light/dark
// theme_preference) after the session user is validated: server wins over
// localStorage, which stays the no-flash cache. It runs once per signed-in
// user and never overwrites a field picked locally or with a save in flight
// (./accountSync; every sign-out path resets it). It is a no-op while APPEARANCE_PICKER_ENABLED is false.
//
// Saves (pickAccent / pickBase) are serialized per field: one PATCH in flight,
// and when it settles only the LATEST pick is sent. A failure that no newer
// pick supersedes reverts to the last value the server confirmed (this
// session's /me or a successful save; none known = no revert).

import { useCallback, useSyncExternalStore } from 'react';
import { safeGetItem, safeSetItem, setRootAttr } from './storage';
import { ACCENTS, APPEARANCE_PICKER_ENABLED, BASES, DEFAULT_ACCENT, DEFAULT_BASE } from './appearanceDefaults';
import { applyThemePreference } from './useTheme';
import {
  beginAccountSave, endAccountSave, hydratedUserId, markHydrated, markLocalPick, mayHydrateField,
  onAccountSyncReset, resetAccountSyncSession,
} from './accountSync';
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
  // Another tab's choice is newer than anything /me could still deliver here.
  if (e.key === null || e.key === ACCENT_STORAGE_KEY) markLocalPick('accent');
  if (e.key === null || e.key === BASE_STORAGE_KEY) markLocalPick('base');
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
  /** The account's user id: hydration runs once per id. */
  id?: string;
  theme_preference?: string | null;
  accent_preference?: string | null;
  base_preference?: string | null;
}

function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Apply the account's saved theme / accent / base (server wins over
 * localStorage). Runs once per signed-in user: only the first call for a user
 * id does anything, so a later refreshUser cannot re-apply an older account
 * value over a newer local pick. A different id (another user signing in on
 * this tab) starts a new session first. A field picked on this device before
 * that first call, or with a save in flight, is left alone on screen, but the
 * account value still becomes the save queue's server-confirmed value.
 * Only fields PRESENT on `user` are applied, so a response from an older
 * Worker (or a cached user written before 0317) never clears a choice;
 * a present null or unknown value means "the default" (theme: follow the
 * device). No-op while APPEARANCE_PICKER_ENABLED is false (nothing changes
 * before the P3-6 flip).
 */
export function hydrateAppearanceFromAccount(user: AccountAppearance | null | undefined): void {
  if (!APPEARANCE_PICKER_ENABLED || !user || typeof user !== 'object') return;
  const id = typeof user.id === 'string' ? user.id : '';
  const prior = hydratedUserId();
  if (prior === id) return;
  if (prior !== null) resetAccountSyncSession(); // a different user on this tab
  if (has(user, 'theme_preference') && mayHydrateField('theme')) {
    const v = user.theme_preference;
    applyThemePreference(v === 'dark' || v === 'light' ? v : 'auto');
  }
  if (has(user, 'accent_preference')) {
    const v = isAccent(user.accent_preference) ? user.accent_preference : null;
    if (mayHydrateField('accent')) applyAccent(v);
    if (saves.accent.confirmed === undefined) saves.accent.confirmed = v;
  }
  if (has(user, 'base_preference')) {
    const v = isBase(user.base_preference) ? user.base_preference : null;
    if (mayHydrateField('base')) applyBase(v);
    if (saves.base.confirmed === undefined) saves.base.confirmed = v;
  }
  markHydrated(id);
}

// ── serialized account saves ───────────────────────────────────────────

/** Sends one field to the account; resolves true when the server saved it. */
export type AppearanceSaver<T> = (value: T | null) => Promise<boolean>;

interface SaveQueue<T> {
  /** Last value the server confirmed: from this session's /me or a successful
   *  save. undefined = not known yet (localStorage is never treated as it). */
  confirmed: T | null | undefined;
  inFlight: boolean;
  /** The newest pick not yet sent. */
  queued: { value: T | null } | null;
  save: AppearanceSaver<T> | null;
  onFailed: (() => void) | null;
}

function newQueue<T>(): SaveQueue<T> {
  return { confirmed: undefined, inFlight: false, queued: null, save: null, onFailed: null };
}

const saves: { accent: SaveQueue<Accent>; base: SaveQueue<Base> } = { accent: newQueue(), base: newQueue() };

// A new session (sign-out, another user) starts with empty queues; the old
// queue objects become stale, so their in-flight saves stop at the next await.
onAccountSyncReset(() => {
  saves.accent = newQueue();
  saves.base = newQueue();
});

async function pump<T>(field: 'accent' | 'base', q: SaveQueue<T>, apply: (v: T | null) => void): Promise<void> {
  if (q.inFlight) return;
  q.inFlight = true;
  const gen = beginAccountSave(field);
  try {
    while (q.queued) {
      // Always send the latest pick (even one equal to the last confirmed
      // value: a failed request may still have reached the server).
      const { value } = q.queued;
      q.queued = null;
      let ok = false;
      try { ok = q.save ? await q.save(value) : false; } catch { ok = false; }
      // Signed out / another user since this save started: drop it silently.
      if (q !== saves[field]) return;
      if (ok) {
        q.confirmed = value;
      } else if (!q.queued) {
        // Nothing newer to send: revert to what the server holds. With no
        // server value known yet (/me not in), keep the pick; the account
        // value applies when /me lands.
        if (q.confirmed !== undefined) apply(q.confirmed);
        q.onFailed?.();
      }
      // else: a newer pick supersedes this one; send it instead.
    }
  } finally {
    q.inFlight = false;
    endAccountSave(field, gen);
  }
}

function pick<T>(
  field: 'accent' | 'base', q: SaveQueue<T>, value: T | null,
  apply: (v: T | null) => void, save: AppearanceSaver<T>, onFailed: () => void,
): Promise<void> {
  markLocalPick(field);
  apply(value);
  q.queued = { value };
  q.save = save;
  q.onFailed = onFailed;
  return pump(field, q, apply);
}

/** User picked an accent: apply now, save to the account (serialized). */
export function pickAccent(value: Accent | null, save: AppearanceSaver<Accent>, onFailed: () => void): Promise<void> {
  return pick('accent', saves.accent, value, applyAccent, save, onFailed);
}

/** User picked a background: apply now, save to the account (serialized). */
export function pickBase(value: Base | null, save: AppearanceSaver<Base>, onFailed: () => void): Promise<void> {
  return pick('base', saves.base, value, applyBase, save, onFailed);
}

export function useAppearance(): UseAppearanceReturn {
  const { accent, base } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // A choice on this device: the account hydration must not overwrite it.
  const setAccent = useCallback((a: Accent | null) => { markLocalPick('accent'); applyAccent(a); }, []);
  const setBase = useCallback((b: Base | null) => { markLocalPick('base'); applyBase(b); }, []);
  return { accent, base, setAccent, setBase };
}

/** Test hook: drop the shared snapshot (module state is global). */
export function __resetAppearanceStoreForTests(): void {
  snapshot = null;
  saves.accent = newQueue();
  saves.base = newQueue();
}
