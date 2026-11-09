// Averrow — per-user auth cache for requireAuth (KV `auth_user:<user_id>`).
//
// requireAuth (middleware/auth.ts) runs on every API request. It used to do
// a D1 `SELECT status FROM users` plus an unthrottled primary
// `UPDATE users SET last_active` per request, so a page that fires ~18 API
// calls at once paid ~18 reads + ~18 writes before any handler ran. This
// module caches the two columns requireAuth needs:
//
//   auth_user:<user_id> → {"status":"active","last_active":"YYYY-MM-DD HH:MM:SS"|null}
//
// Rules:
//   - Keyed ONLY on the verified JWT subject (payload.sub), read after the
//     signature check and the forced-logout gate. Never keyed on the token.
//   - Only `active` rows are cached, for AUTH_USER_CACHE_TTL (60s, the KV
//     minimum). A non-active or missing user always goes to D1, so a
//     re-activation or a newly created row is seen at once.
//   - Every writer of `users.status` and every writer of
//     `forced_logout:<user_id>` calls `invalidateAuthUserCache`. Suspension
//     through the admin PATCH also stamps forced_logout, which requireAuth
//     checks BEFORE this cache, so a suspension is enforced at the same KV
//     consistency level as a logout.
//   - A status change made OUTSIDE the app (e.g. a manual
//     `UPDATE users SET status='suspended'`, the UI-preview kill switch in
//     docs/API_REFERENCE.md) is not invalidated and takes effect within the
//     TTL (≤60s).
//   - KV failures fall through to D1 (never fail open).
//   - last_active is throttled: written only when the known value is older
//     than LAST_ACTIVE_THROTTLE_MS; the cached value doubles as the stamp.

import type { Env } from "../types";

/** KV minimum expirationTtl. */
export const AUTH_USER_CACHE_TTL = 60;

/** Only rewrite users.last_active when it is older than this. */
export const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

export interface AuthUserCacheEntry {
  status: string;
  /** SQLite `datetime('now')` format (UTC, "YYYY-MM-DD HH:MM:SS"), or null. */
  last_active: string | null;
}

export function authUserCacheKey(userId: string): string {
  return `auth_user:${userId}`;
}

/** Parse a cached value; null for a miss or anything malformed. */
export function parseAuthUserCache(raw: string | null): AuthUserCacheEntry | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.status !== "string") return null;
    const lastActive = typeof obj.last_active === "string" ? obj.last_active : null;
    return { status: obj.status, last_active: lastActive };
  } catch {
    return null;
  }
}

/** Best-effort KV read: any failure is a miss (caller falls back to D1). */
export async function readAuthUserCache(env: Env, userId: string): Promise<AuthUserCacheEntry | null> {
  try {
    return parseAuthUserCache(await env.CACHE.get(authUserCacheKey(userId)));
  } catch {
    return null;
  }
}

/** Best-effort KV write of an ACTIVE user's entry. Never throws. */
export async function writeAuthUserCache(env: Env, userId: string, entry: AuthUserCacheEntry): Promise<void> {
  if (entry.status !== "active") return;
  try {
    await env.CACHE.put(authUserCacheKey(userId), JSON.stringify(entry), {
      expirationTtl: AUTH_USER_CACHE_TTL,
    });
  } catch {
    // Cache write is an optimisation only.
  }
}

/**
 * Drop a user's cached auth entry. Call after any change to `users.status`
 * and after any write of `forced_logout:<user_id>`. Never throws.
 */
export async function invalidateAuthUserCache(env: Env, userId: string): Promise<void> {
  try {
    await env.CACHE.delete(authUserCacheKey(userId));
  } catch {
    // Entry expires on its own within AUTH_USER_CACHE_TTL.
  }
}

/** Current time in SQLite `datetime('now')` format. */
export function sqliteNow(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().replace("T", " ").slice(0, 19);
}

/** True when `lastActive` is unknown, unparseable or older than the throttle. */
export function lastActiveIsStale(lastActive: string | null, nowMs: number = Date.now()): boolean {
  if (!lastActive) return true;
  const iso = lastActive.includes("T") ? lastActive : lastActive.replace(" ", "T");
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (!Number.isFinite(ms)) return true;
  return nowMs - ms >= LAST_ACTIVE_THROTTLE_MS;
}
