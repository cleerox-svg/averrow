// Session bookkeeping for the account-synced appearance (facelift P3-5 review).
//
// The account's theme / accent / base are applied from /api/auth/me ONCE per
// signed-in user: the first successful /me for that user id. Later /me calls
// for the same user (refreshUser after a profile save, a re-check) must not
// re-apply them: the account value they carry can be older than a choice the
// user just made on this device.
//
// Even that first hydration skips a field the user changed locally before it
// arrived (the shell can render from the cached user before /me resolves), or
// whose save is still in flight.
//
// A session ends on EVERY sign-out path (AuthProvider resets it whenever the
// user becomes null: logout, 401, a failed /me) and when /me returns a
// different user id. The reset bumps a generation, so a save still in flight
// for the previous user can neither revert nor toast in the new session, and
// it runs the registered reset hooks (useAppearance clears its save queues).
//
// No imports: useTheme and useAppearance both depend on this module.

export type SyncField = 'theme' | 'accent' | 'base';

const FIELDS: readonly SyncField[] = ['theme', 'accent', 'base'];

/** The user id the account appearance was applied for; null = not yet. */
let hydratedFor: string | null = null;
let generation = 0;
const pickedLocally: Record<SyncField, boolean> = { theme: false, accent: false, base: false };
const pendingSaves: Record<SyncField, number> = { theme: 0, accent: 0, base: 0 };
const resetHooks = new Set<() => void>();

/** The user (or another tab) chose a value on this device. */
export function markLocalPick(field: SyncField): void {
  pickedLocally[field] = true;
}

/** Current session generation (changes on every reset). */
export function sessionGeneration(): number {
  return generation;
}

/** A save of `field` to the account started. Returns the generation to pass to endAccountSave. */
export function beginAccountSave(field: SyncField): number {
  pendingSaves[field] += 1;
  return generation;
}
/** A save started in generation `gen` finished (ignored after a reset). */
export function endAccountSave(field: SyncField, gen: number): void {
  if (gen !== generation) return;
  pendingSaves[field] = Math.max(0, pendingSaves[field] - 1);
}

/** The user id this session already hydrated for, or null. */
export function hydratedUserId(): string | null {
  return hydratedFor;
}

/** Whether hydration may write `field`: nothing picked locally since the last
 *  hydration and no save pending. */
export function mayHydrateField(field: SyncField): boolean {
  return !pickedLocally[field] && pendingSaves[field] === 0;
}

/** Record the session's hydration for `userId`. */
export function markHydrated(userId: string): void {
  hydratedFor = userId;
  for (const f of FIELDS) pickedLocally[f] = false;
}

/** Register state to clear on a session reset (returns an unregister). */
export function onAccountSyncReset(hook: () => void): () => void {
  resetHooks.add(hook);
  return () => { resetHooks.delete(hook); };
}

/** Start a new session: every sign-out path, or a different user signing in.
 *  Clears the hydrated user, local picks, pending saves and (via the hooks)
 *  the save queues; saves still in flight become stale. */
export function resetAccountSyncSession(): void {
  generation += 1;
  hydratedFor = null;
  for (const f of FIELDS) {
    pickedLocally[f] = false;
    pendingSaves[f] = 0;
  }
  for (const h of [...resetHooks]) h();
}

/** Test hook: full reset. */
export function __resetAccountSyncForTests(): void {
  resetAccountSyncSession();
}
