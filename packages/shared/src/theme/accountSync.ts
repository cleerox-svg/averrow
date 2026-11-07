// Session bookkeeping for the account-synced appearance (facelift P3-5 review).
//
// The account's theme / accent / base are applied from /api/auth/me ONCE per
// session (the first successful /me). Later /me calls (refreshUser after a
// profile save, a re-check) must not re-apply them: the account value they
// carry can be older than a choice the user just made on this device.
//
// Even that first hydration skips a field the user changed locally before it
// arrived (the shell can render from the cached user before /me resolves), or
// whose save is still in flight.
//
// No imports: useTheme and useAppearance both depend on this module.

export type SyncField = 'theme' | 'accent' | 'base';

const FIELDS: readonly SyncField[] = ['theme', 'accent', 'base'];

let hydrated = false;
const pickedLocally: Record<SyncField, boolean> = { theme: false, accent: false, base: false };
const pendingSaves: Record<SyncField, number> = { theme: 0, accent: 0, base: 0 };

/** The user (or another tab) chose a value on this device. */
export function markLocalPick(field: SyncField): void {
  pickedLocally[field] = true;
}

/** A save of `field` to the account started / finished. */
export function beginAccountSave(field: SyncField): void {
  pendingSaves[field] += 1;
}
export function endAccountSave(field: SyncField): void {
  pendingSaves[field] = Math.max(0, pendingSaves[field] - 1);
}

/** Whether this session already applied the account's appearance. */
export function hasHydratedThisSession(): boolean {
  return hydrated;
}

/** Whether hydration may write `field`: nothing picked locally since the last
 *  hydration and no save pending. */
export function mayHydrateField(field: SyncField): boolean {
  return !pickedLocally[field] && pendingSaves[field] === 0;
}

/** Record the session's (single) hydration. */
export function markHydrated(): void {
  hydrated = true;
  for (const f of FIELDS) pickedLocally[f] = false;
}

/** Start a new session (logout, tests). Pending counters are kept: a save in
 *  flight still finishes. */
export function resetAccountSyncSession(): void {
  hydrated = false;
  for (const f of FIELDS) pickedLocally[f] = false;
}

/** Test hook: full reset, including pending counters. */
export function __resetAccountSyncForTests(): void {
  resetAccountSyncSession();
  for (const f of FIELDS) pendingSaves[f] = 0;
}
