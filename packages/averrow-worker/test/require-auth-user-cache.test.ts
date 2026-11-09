// requireAuth's per-user status cache + last_active throttle
// (lib/auth-user-cache.ts, middleware/auth.ts).
//
//   - hit (active entry in KV `auth_user:<id>`) → no D1 read;
//   - miss → one D1 read, entry written (active users only);
//   - suspended / missing user → 403 and never cached;
//   - the forced_logout gate still runs before the cached status;
//   - last_active UPDATE only when the known value is ≥5 min old, and the
//     cache entry is refreshed with the new stamp;
//   - KV read failure falls through to D1 (never open);
//   - every users.status writer / forced_logout writer drops the entry.
//
// Real handlers against migration-derived SQLite (test/sqlite-d1-harness.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, sqliteTimestampHoursAgo, type SqliteDb,
} from "./sqlite-d1-harness";
import { signJWT } from "../src/lib/jwt";
import { requireAuth, type AuthContext } from "../src/middleware/auth";
import {
  authUserCacheKey, parseAuthUserCache, lastActiveIsStale, sqliteNow, LAST_ACTIVE_THROTTLE_MS,
} from "../src/lib/auth-user-cache";
import { runWithRequestContext } from "../src/lib/request-context";
import { writeForcedLogout } from "../src/lib/forced-logout";
import { handleAdminUpdateUser } from "../src/handlers/admin/users";
import { handleForceLogout } from "../src/handlers/sessions";
import type { Env } from "../src/types";

const SECRET = "test-secret-require-auth-cache";

interface Rig {
  raw: SqliteDb;
  env: Env;
  kv: ReturnType<typeof fakeKv>;
  sqls: string[];
}

function makeRig(): Rig {
  const raw = openDerivedDb(["users", "sessions"]);
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
  const env = { DB: spyDb, AUDIT_DB: auditDb, CACHE: kv, JWT_SECRET: SECRET } as unknown as Env;
  return { raw, env, kv, sqls };
}

async function authReq(sub: string, role = "analyst"): Promise<Request> {
  const token = await signJWT({ sub, email: `${sub}@averrow.com`, role: role as AuthContext["role"] }, SECRET);
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

function setLastActive(raw: SqliteDb, id: string, v: string | null): void {
  raw.prepare("UPDATE users SET last_active = ? WHERE id = ?").run(v, id);
}
function lastActiveOf(raw: SqliteDb, id: string): string | null {
  const rows = raw.prepare("SELECT last_active FROM users WHERE id = ?").all(id) as Array<{ last_active: string | null }>;
  return rows[0]?.last_active ?? null;
}

describe("auth-user-cache helpers", () => {
  it("parses only well-formed entries", () => {
    expect(parseAuthUserCache(null)).toBeNull();
    expect(parseAuthUserCache("{bad")).toBeNull();
    expect(parseAuthUserCache('{"last_active":"x"}')).toBeNull();
    expect(parseAuthUserCache('{"status":"active","last_active":null}')).toEqual({ status: "active", last_active: null });
  });

  it("last_active staleness uses the 5-minute throttle", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    expect(lastActiveIsStale(null, now)).toBe(true);
    expect(lastActiveIsStale("garbage", now)).toBe(true);
    expect(lastActiveIsStale("2026-11-09 11:56:00", now)).toBe(false);
    expect(lastActiveIsStale("2026-11-09 11:55:00", now)).toBe(true);
    expect(lastActiveIsStale(sqliteNow(now - LAST_ACTIVE_THROTTLE_MS + 1000), now)).toBe(false);
  });
});

describe.skipIf(!hasSqlite())("requireAuth: KV status cache", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("miss reads D1 once and populates the cache; the next request does no D1 read", async () => {
    setLastActive(rig.raw, "u1", sqliteNow());
    const first = await auth(rig, "u1");
    expect(first).not.toBeInstanceOf(Response);
    expect(statusReads(rig.sqls)).toHaveLength(1);
    expect(lastActiveWrites(rig.sqls)).toHaveLength(0);
    const cached = parseAuthUserCache(rig.kv.store.get(authUserCacheKey("u1")) ?? null);
    expect(cached?.status).toBe("active");

    rig.sqls.length = 0;
    const second = await auth(rig, "u1");
    expect(second).not.toBeInstanceOf(Response);
    expect(rig.sqls).toHaveLength(0);
  });

  it("suspended user → 403 on a miss and is never cached", async () => {
    const res = await auth(rig, "sus");
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
    expect(rig.kv.store.has(authUserCacheKey("sus"))).toBe(false);
  });

  it("missing user → 403, not cached", async () => {
    const res = await auth(rig, "ghost");
    expect((res as Response).status).toBe(403);
    expect(rig.kv.store.has(authUserCacheKey("ghost"))).toBe(false);
  });

  it("a cached non-active entry is ignored (re-read from D1)", async () => {
    rig.kv.store.set(authUserCacheKey("u1"), JSON.stringify({ status: "suspended", last_active: null }));
    const res = await auth(rig, "u1");
    expect(res).not.toBeInstanceOf(Response);
    expect(statusReads(rig.sqls)).toHaveLength(1);
  });

  it("forced_logout still rejects a user whose active status is cached", async () => {
    rig.kv.store.set(authUserCacheKey("u1"), JSON.stringify({ status: "active", last_active: sqliteNow() }));
    rig.kv.store.set("forced_logout:u1", String(Math.floor(Date.now() / 1000) + 5));
    const res = await auth(rig, "u1");
    expect((res as Response).status).toBe(401);
  });

  it("a KV read failure on the cache key falls through to D1", async () => {
    const realGet = rig.kv.get;
    rig.kv.get = (async (key: string) => {
      if (key.startsWith("auth_user:")) throw new Error("kv down");
      return realGet(key);
    }) as typeof rig.kv.get;
    rig.raw.exec("UPDATE users SET status = 'suspended' WHERE id = 'u1'");
    const res = await auth(rig, "u1");
    expect((res as Response).status).toBe(403);
    expect(statusReads(rig.sqls)).toHaveLength(1);
  });

  it("skips the last_active UPDATE when it is < 5 min old, issues it when older", async () => {
    setLastActive(rig.raw, "u1", sqliteNow(Date.now() - 60_000));
    await auth(rig, "u1");
    expect(lastActiveWrites(rig.sqls)).toHaveLength(0);

    rig.kv.store.clear();
    rig.sqls.length = 0;
    setLastActive(rig.raw, "u1", sqliteTimestampHoursAgo(1));
    await auth(rig, "u1");
    expect(lastActiveWrites(rig.sqls)).toHaveLength(1);
    expect(lastActiveIsStale(lastActiveOf(rig.raw, "u1"))).toBe(false);
    // The cache carries the fresh stamp, so the next request writes nothing.
    const cached = parseAuthUserCache(rig.kv.store.get(authUserCacheKey("u1")) ?? null);
    expect(lastActiveIsStale(cached?.last_active ?? null)).toBe(false);
    rig.sqls.length = 0;
    await auth(rig, "u1");
    expect(rig.sqls).toHaveLength(0);
  });

  it("a cache hit with a stale last_active writes it and refreshes the entry", async () => {
    rig.kv.store.set(authUserCacheKey("u1"), JSON.stringify({ status: "active", last_active: sqliteTimestampHoursAgo(1) }));
    await auth(rig, "u1");
    expect(statusReads(rig.sqls)).toHaveLength(0);
    expect(lastActiveWrites(rig.sqls)).toHaveLength(1);
    const cached = parseAuthUserCache(rig.kv.store.get(authUserCacheKey("u1")) ?? null);
    expect(lastActiveIsStale(cached?.last_active ?? null)).toBe(false);
  });

  it("works outside a request scope (floating background promise)", async () => {
    const res = await requireAuth(await authReq("u1"), rig.env);
    expect(res).not.toBeInstanceOf(Response);
  });
});

describe.skipIf(!hasSqlite())("auth_user cache invalidation", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
    rig.kv.store.set(authUserCacheKey("u1"), JSON.stringify({ status: "active", last_active: sqliteNow() }));
  });
  afterEach(() => vi.useRealTimers());

  const patch = (body: unknown) => new Request("https://averrow.com/api/admin/users/u1", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it("admin PATCH suspension drops the entry AND stamps forced_logout", async () => {
    const res = await handleAdminUpdateUser(patch({ status: "suspended" }), rig.env, "u1", "root", "super_admin");
    expect(res.status).toBe(200);
    expect(rig.kv.store.has(authUserCacheKey("u1"))).toBe(false);
    expect(rig.kv.store.has("forced_logout:u1")).toBe(true);
    // The suspended user's next request is rejected.
    const out = await auth(rig, "u1");
    expect(out).toBeInstanceOf(Response);
  });

  it("admin PATCH reactivation drops the entry without stamping forced_logout", async () => {
    rig.kv.store.set(authUserCacheKey("sus"), JSON.stringify({ status: "active", last_active: null }));
    const res = await handleAdminUpdateUser(patch({ status: "active" }), rig.env, "sus", "root", "super_admin");
    expect(res.status).toBe(200);
    expect(rig.kv.store.has(authUserCacheKey("sus"))).toBe(false);
    expect(rig.kv.store.has("forced_logout:sus")).toBe(false);
  });

  it("admin force-logout drops the entry", async () => {
    const res = await handleForceLogout(new Request("https://averrow.com/x", { method: "POST" }), rig.env, "u1", "root");
    expect(res.status).toBe(200);
    expect(rig.kv.store.has(authUserCacheKey("u1"))).toBe(false);
  });

  it("writeForcedLogout (self-service session revocation) drops the entry", async () => {
    await writeForcedLogout(rig.env, "u1", { revokeSids: ["s1"] });
    expect(rig.kv.store.has(authUserCacheKey("u1"))).toBe(false);
  });
});
