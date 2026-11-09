// requireAuth's per-user status cache + last_active throttle
// (lib/auth-user-cache.ts, middleware/auth.ts).
//
//   - per-isolate memo (15s) → KV `auth_user:<id>` (trusted ≤60s after the
//     D1 proof in `checked_at`) → D1;
//   - hit → no D1 read; memo hit → no KV auth_user read either; the
//     forced_logout gate runs on every request first;
//   - suspended / missing user → 403 and never cached;
//   - a manual SQL suspend is honoured within ~75s, never renewed by a hit;
//   - last_active UPDATE only when the known value is ≥5 min old; the entry
//     is re-cached only when that guarded UPDATE changed a row;
//   - KV read failure falls through to D1 (never open);
//   - the admin users PATCH (the one status writer) drops KV + memo, and its
//     forced_logout stamp keeps already-revoked sids.
//
// Real handlers against migration-derived SQLite (test/sqlite-d1-harness.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, sqliteTimestampHoursAgo, type SqliteDb,
} from "./sqlite-d1-harness";
import { signJWT } from "../src/lib/jwt";
import { requireAuth, type AuthContext } from "../src/middleware/auth";
import {
  authUserCacheKey, parseAuthUserCache, lastActiveIsStale, sqliteNow, clearAuthUserMemo,
  memoGetAuthUser, memoSetAuthUser, authUserMemoSize,
  LAST_ACTIVE_THROTTLE_MS, AUTH_USER_MEMO_MAX, type AuthUserCacheEntry,
} from "../src/lib/auth-user-cache";
import { runWithRequestContext } from "../src/lib/request-context";
import { parseForcedLogout } from "../src/lib/forced-logout";
import { handleAdminUpdateUser } from "../src/handlers/admin/users";
import type { Env } from "../src/types";

const SECRET = "test-secret-require-auth-cache";

interface Rig {
  raw: SqliteDb;
  env: Env;
  kv: ReturnType<typeof fakeKv>;
  sqls: string[];
  kvGets: string[];
}

function makeRig(): Rig {
  const raw = openDerivedDb(["users", "sessions", "organizations", "org_members"]);
  raw.exec(`
    INSERT INTO users (id, email, name, role, status) VALUES
      ('root', 'root@averrow.com', 'Root', 'super_admin', 'active'),
      ('u1',   'u1@averrow.com',   'U1',   'analyst',     'active'),
      ('sus',  'sus@averrow.com',  'Sus',  'analyst',     'suspended');
  `);
  const db = d1FromSqlite(raw);
  const sqls: string[] = [];
  const spyDb = {
    prepare(sql: string) {
      sqls.push(sql);
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  };
  const auditDb = {
    prepare() {
      return { bind() { return { async run() { return { success: true }; } }; } };
    },
  };
  const kv = fakeKv();
  const kvGets: string[] = [];
  const realGet = kv.get;
  kv.get = (async (key: string) => { kvGets.push(key); return realGet(key); }) as typeof kv.get;
  const env = { DB: spyDb, AUDIT_DB: auditDb, CACHE: kv, JWT_SECRET: SECRET } as unknown as Env;
  return { raw, env, kv, sqls, kvGets };
}

async function authReq(sub: string): Promise<Request> {
  const token = await signJWT({ sub, email: `${sub}@averrow.com`, role: "analyst" }, SECRET);
  return new Request("https://averrow.com/api/x", { headers: { Authorization: `Bearer ${token}` } });
}

/** Run requireAuth inside a request scope and wait for its background work. */
async function auth(rig: Rig, sub: string): Promise<AuthContext | Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const req = await authReq(sub);
  const out = await runWithRequestContext(ctx, () => requireAuth(req, rig.env));
  await Promise.all(pending);
  return out;
}

const statusReads = (sqls: string[]) => sqls.filter((s) => /FROM users WHERE id/.test(s));
const lastActiveWrites = (sqls: string[]) => sqls.filter((s) => /UPDATE users SET last_active/.test(s));
const reset = (rig: Rig) => { rig.sqls.length = 0; rig.kvGets.length = 0; };

function entry(lastActive: string | null, checkedAt = Date.now()): AuthUserCacheEntry {
  return { status: "active", last_active: lastActive, checked_at: checkedAt };
}
function setLastActive(raw: SqliteDb, id: string, v: string | null): void {
  raw.prepare("UPDATE users SET last_active = ? WHERE id = ?").run(v, id);
}
function lastActiveOf(raw: SqliteDb, id: string): string | null {
  const rows = raw.prepare("SELECT last_active FROM users WHERE id = ?").all(id) as Array<{ last_active: string | null }>;
  return rows[0]?.last_active ?? null;
}
const allowed = (r: AuthContext | Response) => !(r instanceof Response);

beforeEach(() => clearAuthUserMemo());
afterEach(() => vi.useRealTimers());

describe("auth-user-cache helpers", () => {
  it("parses only well-formed, active, in-window entries", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    expect(parseAuthUserCache(null, now)).toBeNull();
    expect(parseAuthUserCache("{bad", now)).toBeNull();
    expect(parseAuthUserCache(JSON.stringify({ status: "active", last_active: null }), now)).toBeNull(); // no checked_at
    expect(parseAuthUserCache(JSON.stringify({ status: "suspended", last_active: null, checked_at: now }), now)).toBeNull();
    expect(parseAuthUserCache(JSON.stringify({ status: "active", last_active: null, checked_at: now - 61_000 }), now)).toBeNull();
    expect(parseAuthUserCache(JSON.stringify(entry(null, now - 59_000)), now)).toEqual(entry(null, now - 59_000));
  });

  it("last_active staleness uses the 5-minute throttle", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    expect(lastActiveIsStale(null, now)).toBe(true);
    expect(lastActiveIsStale("garbage", now)).toBe(true);
    expect(lastActiveIsStale("2026-11-09 11:56:00", now)).toBe(false);
    expect(lastActiveIsStale("2026-11-09 11:55:00", now)).toBe(true);
    expect(lastActiveIsStale(sqliteNow(now - LAST_ACTIVE_THROTTLE_MS + 1000), now)).toBe(false);
  });

  it("memo expires after 15s and is size-capped (oldest evicted)", () => {
    const now = 1_000_000;
    memoSetAuthUser("a", entry(null, now), now);
    expect(memoGetAuthUser("a", now + 14_999)).not.toBeNull();
    expect(memoGetAuthUser("a", now + 15_000)).toBeNull();
    for (let i = 0; i < AUTH_USER_MEMO_MAX + 5; i++) memoSetAuthUser(`u${i}`, entry(null, now), now);
    expect(authUserMemoSize()).toBe(AUTH_USER_MEMO_MAX);
    expect(memoGetAuthUser("u0", now)).toBeNull();
    expect(memoGetAuthUser(`u${AUTH_USER_MEMO_MAX + 4}`, now)).not.toBeNull();
  });
});

describe.skipIf(!hasSqlite())("requireAuth: status cache", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("miss reads D1 once and populates KV; a KV hit does no D1 read", async () => {
    setLastActive(rig.raw, "u1", sqliteNow());
    expect(allowed(await auth(rig, "u1"))).toBe(true);
    expect(statusReads(rig.sqls)).toHaveLength(1);
    expect(lastActiveWrites(rig.sqls)).toHaveLength(0);
    expect(parseAuthUserCache(rig.kv.store.get(authUserCacheKey("u1")) ?? null)?.status).toBe("active");

    clearAuthUserMemo();
    reset(rig);
    expect(allowed(await auth(rig, "u1"))).toBe(true);
    expect(rig.sqls).toHaveLength(0);
    expect(rig.kvGets).toContain(authUserCacheKey("u1"));
  });

  it("memo serves a second request with no KV auth_user get and no D1; forced_logout is still read", async () => {
    setLastActive(rig.raw, "u1", sqliteNow());
    await auth(rig, "u1");
    reset(rig);
    expect(allowed(await auth(rig, "u1"))).toBe(true);
    expect(rig.sqls).toHaveLength(0);
    expect(rig.kvGets).toEqual(["forced_logout:u1"]);
  });

  it("forced_logout still rejects a user served from the memo", async () => {
    setLastActive(rig.raw, "u1", sqliteNow());
    await auth(rig, "u1");
    rig.kv.store.set("forced_logout:u1", String(Math.floor(Date.now() / 1000) + 5));
    const res = await auth(rig, "u1");
    expect((res as Response).status).toBe(401);
  });

  it("suspended user → 403 on a miss and is never cached", async () => {
    const res = await auth(rig, "sus");
    expect((res as Response).status).toBe(403);
    expect(rig.kv.store.has(authUserCacheKey("sus"))).toBe(false);
    expect(memoGetAuthUser("sus")).toBeNull();
  });

  it("missing user → 403, not cached", async () => {
    const res = await auth(rig, "ghost");
    expect((res as Response).status).toBe(403);
    expect(rig.kv.store.has(authUserCacheKey("ghost"))).toBe(false);
  });

  it("a KV read failure on the cache key falls through to D1", async () => {
    const get = rig.kv.get;
    rig.kv.get = (async (key: string) => {
      if (key.startsWith("auth_user:")) throw new Error("kv down");
      return get(key);
    }) as typeof rig.kv.get;
    rig.raw.exec("UPDATE users SET status = 'suspended' WHERE id = 'u1'");
    const res = await auth(rig, "u1");
    expect((res as Response).status).toBe(403);
    expect(statusReads(rig.sqls)).toHaveLength(1);
  });

  it("manual SQL suspend (no forced_logout): allowed while cached, rejected once memo + KV window lapse (≤ ~75s)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-11-09T12:00:00Z");
    vi.setSystemTime(t0);
    setLastActive(rig.raw, "u1", sqliteNow(t0));
    expect(allowed(await auth(rig, "u1"))).toBe(true);           // D1 proof at t0
    rig.raw.exec("UPDATE users SET status = 'suspended' WHERE id = 'u1'");

    vi.setSystemTime(t0 + 10_000);
    expect(allowed(await auth(rig, "u1"))).toBe(true);           // memo
    vi.setSystemTime(t0 + 59_000);
    expect(allowed(await auth(rig, "u1"))).toBe(true);           // KV (59s old) → memo until +74s
    vi.setSystemTime(t0 + 70_000);
    expect(allowed(await auth(rig, "u1"))).toBe(true);           // memo
    reset(rig);
    vi.setSystemTime(t0 + 75_000);
    const res = await auth(rig, "u1");                            // memo + KV lapsed → D1
    expect((res as Response).status).toBe(403);
    expect(statusReads(rig.sqls)).toHaveLength(1);
    // The KV entry was never renewed by the hits.
    expect(parseAuthUserCache(rig.kv.store.get(authUserCacheKey("u1")) ?? null, t0 + 1)?.checked_at).toBe(t0);
  });

  it("skips the last_active UPDATE when it is < 5 min old, issues it when older and re-caches", async () => {
    setLastActive(rig.raw, "u1", sqliteNow(Date.now() - 60_000));
    await auth(rig, "u1");
    expect(lastActiveWrites(rig.sqls)).toHaveLength(0);

    rig.kv.store.clear();
    clearAuthUserMemo();
    reset(rig);
    setLastActive(rig.raw, "u1", sqliteTimestampHoursAgo(1));
    await auth(rig, "u1");
    expect(lastActiveWrites(rig.sqls)).toHaveLength(1);
    expect(lastActiveIsStale(lastActiveOf(rig.raw, "u1"))).toBe(false);
    const cached = parseAuthUserCache(rig.kv.store.get(authUserCacheKey("u1")) ?? null);
    expect(lastActiveIsStale(cached?.last_active ?? null)).toBe(false);
    clearAuthUserMemo();
    reset(rig);
    await auth(rig, "u1");
    expect(rig.sqls).toHaveLength(0);
  });

  it("a hit with a stale last_active writes it and refreshes the entry when the row is active", async () => {
    rig.kv.store.set(authUserCacheKey("u1"), JSON.stringify(entry(sqliteTimestampHoursAgo(1))));
    await auth(rig, "u1");
    expect(statusReads(rig.sqls)).toHaveLength(0);
    expect(lastActiveWrites(rig.sqls)).toHaveLength(1);
    const cached = parseAuthUserCache(rig.kv.store.get(authUserCacheKey("u1")) ?? null);
    expect(lastActiveIsStale(cached?.last_active ?? null)).toBe(false);
  });

  it("a hit with a stale last_active does NOT re-cache when the UPDATE changes 0 rows (suspended in D1)", async () => {
    rig.raw.exec("UPDATE users SET last_active = NULL WHERE id = 'u1'");
    rig.raw.exec("UPDATE users SET status = 'suspended' WHERE id = 'u1'");
    const stored = JSON.stringify(entry(sqliteTimestampHoursAgo(1), Date.now() - 30_000));
    rig.kv.store.set(authUserCacheKey("u1"), stored);
    expect(allowed(await auth(rig, "u1"))).toBe(true);            // still inside the trust window
    expect(lastActiveWrites(rig.sqls)).toHaveLength(1);
    expect(lastActiveOf(rig.raw, "u1")).toBeNull();              // status guard refused the write
    expect(rig.kv.store.get(authUserCacheKey("u1"))).toBe(stored); // not renewed
  });

  it("works outside a request scope (floating background promise)", async () => {
    const res = await requireAuth(await authReq("u1"), rig.env);
    expect(allowed(res)).toBe(true);
  });
});

describe.skipIf(!hasSqlite())("admin users PATCH invalidation", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  const patch = (body: unknown) => new Request("https://averrow.com/api/admin/users/u1", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it("suspension drops KV + memo and stamps forced_logout; the next request is rejected", async () => {
    setLastActive(rig.raw, "u1", sqliteNow());
    await auth(rig, "u1");
    expect(memoGetAuthUser("u1")).not.toBeNull();
    const res = await handleAdminUpdateUser(patch({ status: "suspended" }), rig.env, "u1", "root", "super_admin");
    expect(res.status).toBe(200);
    expect(rig.kv.store.has(authUserCacheKey("u1"))).toBe(false);
    expect(memoGetAuthUser("u1")).toBeNull();
    expect(rig.kv.store.has("forced_logout:u1")).toBe(true);
    expect(allowed(await auth(rig, "u1"))).toBe(false);
  });

  it("any committed status PATCH clears the memo (next request re-reads D1)", async () => {
    setLastActive(rig.raw, "u1", sqliteNow());
    await auth(rig, "u1");
    const res = await handleAdminUpdateUser(patch({ status: "active" }), rig.env, "u1", "root", "super_admin");
    expect(res.status).toBe(200);
    expect(memoGetAuthUser("u1")).toBeNull();
    expect(rig.kv.store.has("forced_logout:u1")).toBe(false);
    reset(rig);
    expect(allowed(await auth(rig, "u1"))).toBe(true);
    expect(statusReads(rig.sqls)).toHaveLength(1);
  });

  it("the suspension stamp keeps already-revoked session ids (writeForcedLogout)", async () => {
    const now = Math.floor(Date.now() / 1000);
    rig.kv.store.set("forced_logout:u1", JSON.stringify({ ts: null, sids: { s1: now + 3600 } }));
    const res = await handleAdminUpdateUser(patch({ status: "suspended" }), rig.env, "u1", "root", "super_admin");
    expect(res.status).toBe(200);
    const st = parseForcedLogout(rig.kv.store.get("forced_logout:u1") ?? null)!;
    expect(st.sids.s1).toBe(now + 3600);
    expect(st.ts).toBeGreaterThanOrEqual(now);
  });

  it("a role change never lowers a later existing ts", async () => {
    const later = Math.floor(Date.now() / 1000) + 1000;
    rig.kv.store.set("forced_logout:u1", String(later));
    const res = await handleAdminUpdateUser(patch({ role: "client" }), rig.env, "u1", "root", "super_admin");
    expect(res.status).toBe(200);
    expect(parseForcedLogout(rig.kv.store.get("forced_logout:u1") ?? null)!.ts).toBe(later);
  });
});
