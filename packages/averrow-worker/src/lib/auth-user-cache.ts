// Averrow — per-user auth cache for requireAuth (KV `auth_user:<user_id>`
// plus a small per-isolate memo in front of it).
//
// requireAuth (middleware/auth.ts) runs on every API request. It used to do
// a D1 `SELECT status FROM users` plus an unthrottled primary
// `UPDATE users SET last_active` per request, so a page that fires ~18 API
// calls at once paid ~18 reads + ~18 writes before any handler ran. This
// module caches the two columns requireAuth needs:
//
//   auth_user:<user_id> → {"status":"active",
//                          "last_active":"YYYY-MM-DD HH:MM:SS"|null,
//                          "checked_at":<epoch ms of the D1 read/write that
//                                        proved the row active>}
//
// Rules:
//   - Keyed ONLY on the verified JWT subject (payload.sub), read after the
//     signature check. requireAuth evaluates the forced_logout gate first on
//     EVERY request (memo hit included); this cache holds nothing that gate
//     depends on, so forced_logout writers do not touch it.
//   - Only `active` rows are cached. A non-active or missing user always goes
//     to D1, so a re-activation or a newly created row is seen at once.
//   - An entry is written only with values D1 just returned: after a
//     `SELECT` that said active, or after the guarded last_active
//     `UPDATE … AND status = 'active'` changed a row. A cache hit is never
//     re-written without such a D1 proof, so a stale entry cannot renew
//     itself.
//   - KV trust window: an entry is honoured only while
//     `now - checked_at <= AUTH_USER_CACHE_TTL` (60s), regardless of KV's own
//     expiry or edge caching. The per-isolate memo adds at most
//     AUTH_USER_MEMO_TTL_MS (15s) on top.
//   - The only in-app writer of `users.status` (admin PATCH
//     /api/admin/users/:id) calls `invalidateAuthUserCache`, which deletes
//     the KV entry and this isolate's memo entry. Other isolates may keep a
//     memo entry ≤15s; that PATCH also stamps forced_logout on suspension,
//     which requireAuth checks before the status cache, so the suspension is
//     enforced at the same KV-consistency level as a logout.
//   - A status change made OUTSIDE the app (a manual
//     `UPDATE users SET status='suspended'`, the UI-preview kill switch in
//     docs/API_REFERENCE.md) is not invalidated and takes effect within
//     about 75s (60s KV trust window + 15s memo).
//   - KV failures fall through to D1 (never fail open).
//   - last_active is throttled: written only when the known value is older
//     than LAST_ACTIVE_THROTTLE_MS.

import type { Env } from "../types";

/** KV minimum expirationTtl, and the trust window for a KV entry (seconds). */
export const AUTH_USER_CACHE_TTL = 60;

/** Per-isolate memo lifetime. */
export const AUTH_USER_MEMO_TTL_MS = 15_000;

/** Per-isolate memo size cap (oldest entry evicted first). */
export const AUTH_USER_MEMO_MAX = 1000;

/** Only rewrite users.last_active when it is older than this. */
export const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

export interface AuthUserCacheEntry {
  status: "active";
  /** SQLite `datetime('now')` format (UTC, "YYYY-MM-DD HH:MM:SS"), or null. */
  last_active: string | null;
  /** Epoch ms of the D1 read/write that proved the row active. */
  checked_at: number;
}

export function authUserCacheKey(userId: string): string {
  return `auth_user:${userId}`;
}

/**
 * Parse a cached value; null for a miss, anything malformed, a non-active
 * status, or an entry older than the trust window.
 */
export function parseAuthUserCache(raw: string | null, nowMs: number = Date.now()): AuthUserCacheEntry | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.status !== "active") return null;
    if (typeof obj.checked_at !== "number" || !Number.isFinite(obj.checked_at)) return null;
    const age = nowMs - obj.checked_at;
    if (age < 0 || age > AUTH_USER_CACHE_TTL * 1000) return null;
    const lastActive = typeof obj.last_active === "string" ? obj.last_active : null;
    return { status: "active", last_active: lastActive, checked_at: obj.checked_at };
  } catch {
    return null;
  }
}

// ─── per-isolate memo ───────────────────────────────────────────
// Holds RESOLVED values only (never promises: Workers forbids awaiting I/O
// started by another request). Map insertion order doubles as LRU order.

const memo = new Map<string, { entry: AuthUserCacheEntry; expiresAt: number }>();

export function memoGetAuthUser(userId: string, nowMs: number = Date.now()): AuthUserCacheEntry | null {
  const hit = memo.get(userId);
  if (!hit) return null;
  if (hit.expiresAt <= nowMs) {
    memo.delete(userId);
    return null;
  }
  return hit.entry;
}

export function memoSetAuthUser(userId: string, entry: AuthUserCacheEntry, nowMs: number = Date.now()): void {
  memo.delete(userId);
  while (memo.size >= AUTH_USER_MEMO_MAX) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
  memo.set(userId, { entry, expiresAt: nowMs + AUTH_USER_MEMO_TTL_MS });
}

/** Test helper. */
export function clearAuthUserMemo(): void {
  memo.clear();
}

/** Test/diagnostic helper. */
export function authUserMemoSize(): number {
  return memo.size;
}

// ─── KV ─────────────────────────────────────────────────────────

/** Best-effort KV read: any failure is a miss (caller falls back to D1). */
export async function readAuthUserCache(env: Env, userId: string): Promise<AuthUserCacheEntry | null> {
  try {
    return parseAuthUserCache(await env.CACHE.get(authUserCacheKey(userId)));
  } catch {
    return null;
  }
}

/**
 * Best-effort KV write. Only call with values D1 just proved active (see the
 * header). Never throws.
 */
export async function writeAuthUserCache(env: Env, userId: string, entry: AuthUserCacheEntry): Promise<void> {
  try {
    await env.CACHE.put(authUserCacheKey(userId), JSON.stringify(entry), {
      expirationTtl: AUTH_USER_CACHE_TTL,
    });
  } catch {
    // Cache write is an optimisation only.
  }
}

/**
 * Drop a user's cached auth entry (KV + this isolate's memo). Call after any
 * change to `users.status`. Never throws.
 */
export async function invalidateAuthUserCache(env: Env, userId: string): Promise<void> {
  memo.delete(userId);
  try {
    await env.CACHE.delete(authUserCacheKey(userId));
  } catch {
    // Entry stops being trusted within AUTH_USER_CACHE_TTL on its own.
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
