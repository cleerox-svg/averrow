/**
 * Appsec finding 1 (Medium): revoking a device only blocked its REFRESH; its
 * access token (no session id) kept API access for up to ACCESS_TOKEN_TTL.
 *
 * Fix pinned here:
 *   - access tokens minted at login (issueSession) and on refresh carry
 *     `sid` = sessions.id;
 *   - per-session revoke / revoke-others list the revoked sids in the
 *     existing `forced_logout:<user>` KV value, which requireAuth already
 *     reads — a revoked sid is rejected within TTL, the caller's own token
 *     keeps working, and there is no second KV read per request;
 *   - the legacy plain-number value is still enforced, logout-all still
 *     kills everything (and is backdated 1s so a sign-in in the same second
 *     survives).
 * Finding 2 (Low): read-only identities (auditor / preview presets) get 403
 * on the three session mutations and never touch forced_logout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { signJWT, verifyJWT, ACCESS_TOKEN_TTL, ABSOLUTE_SESSION_TTL } from "../src/lib/jwt";
import { hashToken } from "../src/lib/hash";
import { requireAuth, type AuthContext } from "../src/middleware/auth";
import { issueSession, handleRefreshToken } from "../src/handlers/auth";
import {
  handleRevokeOwnSession, handleRevokeOtherSessions, handleLogoutEverywhere,
} from "../src/handlers/account-sessions";
import {
  parseForcedLogout, isForcedOut, writeForcedLogout, REVOKED_SID_RETENTION,
} from "../src/lib/forced-logout";
import type { Env, UserRole } from "../src/types";

const SECRET = "test-secret-session-revocation";
const T0 = new Date("2026-10-05T12:00:00Z");
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

// ─── pure gate ──────────────────────────────────────────────────

describe("forced_logout value: parse + gate", () => {
  it("accepts the legacy plain number", () => {
    const st = parseForcedLogout("1000");
    expect(st).toEqual({ ts: 1000, sids: {} });
    expect(isForcedOut(st, 1000)).toBe(true);
    expect(isForcedOut(st, 1001)).toBe(false);
  });

  it("accepts the v2 JSON shape: ts gate and listed sids", () => {
    const st = parseForcedLogout(JSON.stringify({ ts: 1000, sids: { a: 5000 } }));
    expect(isForcedOut(st, 999, "zzz")).toBe(true);     // ts
    expect(isForcedOut(st, 2000, "a")).toBe(true);      // sid
    expect(isForcedOut(st, 2000, "b")).toBe(false);
    expect(isForcedOut(st, 2000, null)).toBe(false);    // sid-less tokens only face ts
    expect(isForcedOut(parseForcedLogout(JSON.stringify({ ts: null, sids: { a: 1 } })), 1, "a")).toBe(true);
  });

  it("missing / malformed values never reject (same as the old parseInt reader)", () => {
    expect(parseForcedLogout(null)).toBeNull();
    expect(isForcedOut(parseForcedLogout("{not json"), 1, "a")).toBe(false);
    expect(isForcedOut(parseForcedLogout("[1,2]"), 1, "a")).toBe(false);
    expect(isForcedOut(parseForcedLogout('{"sids":{"__proto__":1}}'), 1, "toString")).toBe(false);
  });
});

describe("writeForcedLogout", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps an existing legacy ts, adds sids, prunes expired ones, TTL covers the ts", async () => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    const now = sec(T0);
    const kv = fakeKv({ "forced_logout:u": String(now - 100) });
    const puts: Array<{ ttl?: number }> = [];
    const realPut = kv.put.bind(kv);
    kv.put = (async (k: string, v: string, o?: { expirationTtl?: number }) => {
      puts.push({ ttl: o?.expirationTtl }); return realPut(k, v, o);
    }) as typeof kv.put;
    const env = { CACHE: kv } as unknown as Env;

    await writeForcedLogout(env, "u", { revokeSids: ["s1"] });
    let st = parseForcedLogout(kv.store.get("forced_logout:u")!)!;
    expect(st.ts).toBe(now - 100);
    expect(st.sids.s1).toBe(now + REVOKED_SID_RETENTION);
    expect(puts[0]!.ttl).toBeGreaterThanOrEqual(ABSOLUTE_SESSION_TTL - 100);

    // Past s1's retention: a later write prunes it, keeps ts.
    vi.setSystemTime(new Date(T0.getTime() + (REVOKED_SID_RETENTION + 1) * 1000));
    await writeForcedLogout(env, "u", { revokeSids: ["s2"] });
    st = parseForcedLogout(kv.store.get("forced_logout:u")!)!;
    expect(Object.keys(st.sids)).toEqual(["s2"]);
    expect(st.ts).toBe(now - 100);
  });

  it("never lowers ts; sid-only entries expire after the access-token window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    const now = sec(T0);
    const kv = fakeKv();
    let ttl = 0;
    const realPut = kv.put.bind(kv);
    kv.put = (async (k: string, v: string, o?: { expirationTtl?: number }) => {
      ttl = o?.expirationTtl ?? 0; return realPut(k, v, o);
    }) as typeof kv.put;
    const env = { CACHE: kv } as unknown as Env;
    await writeForcedLogout(env, "u", { revokeSids: ["s1"] });
    expect(ttl).toBe(REVOKED_SID_RETENTION);
    expect(REVOKED_SID_RETENTION).toBeGreaterThanOrEqual(ACCESS_TOKEN_TTL);
    await writeForcedLogout(env, "u", { ts: now });
    await writeForcedLogout(env, "u", { ts: now - 50 });
    expect(parseForcedLogout(kv.store.get("forced_logout:u")!)!.ts).toBe(now);
  });
});

// ─── end to end over sqlite ─────────────────────────────────────

interface Rig {
  raw: SqliteDb;
  env: Env;
  kv: ReturnType<typeof fakeKv>;
}

function makeRig(): Rig {
  const raw = openDerivedDb(["users", "sessions", "org_members", "organizations"]);
  const kv = fakeKv();
  const env = {
    DB: d1FromSqlite(raw),
    AUDIT_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
    CACHE: kv,
    JWT_SECRET: SECRET,
  } as unknown as Env;
  raw.prepare("INSERT INTO users (id, email, name, role, status) VALUES ('u1', 'u1@example.com', 'U', 'analyst', 'active')").run();
  return { raw, env, kv };
}

async function addSession(rig: Rig, id: string, refresh: string): Promise<void> {
  rig.raw.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, issued_at, expires_at, auth_method)
     VALUES (?, 'u1', ?, datetime('now', '-1 hour'), datetime('now', '+7 days'), 'google_oauth')`,
  ).run(id, await hashToken(refresh));
}

const tokenFor = (sid: string | undefined, role: UserRole = "analyst", sub = "u1") =>
  signJWT({ sub, email: `${sub}@example.com`, role, ...(sid ? { sid } : {}) }, SECRET);

function authed(token: string, url = "https://x/api/auth/me", init: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (cookie) headers.set("Cookie", `radar_refresh=${cookie}`);
  return new Request(url, { ...init, headers });
}

async function authStatus(rig: Rig, token: string): Promise<number> {
  const ctx = await requireAuth(authed(token), rig.env);
  return ctx instanceof Response ? ctx.status : 200;
}

async function ctxFor(rig: Rig, token: string): Promise<AuthContext> {
  const ctx = await requireAuth(authed(token), rig.env);
  if (ctx instanceof Response) throw new Error(`auth failed ${ctx.status}`);
  return ctx;
}

describe.skipIf(!hasSqlite())("access tokens carry sid", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("login (issueSession) mints a token whose sid is the new sessions row", async () => {
    const res = await issueSession(new Request("https://x/api/auth/passkey/finish"), rig.env, "u1", "u1@example.com",
      "analyst", "https://x", "/v2/", "passkey", "json");
    const body = await res.json() as { data: { access_token: string } };
    const payload = await verifyJWT(body.data.access_token, SECRET);
    const rows = rig.raw.prepare("SELECT id FROM sessions WHERE user_id = 'u1'").all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(payload?.sid).toBe(rows[0]!.id);
    expect((await ctxFor(rig, body.data.access_token)).sessionId).toBe(rows[0]!.id);
  });

  it("refresh mints a token whose sid is the refreshed session", async () => {
    await addSession(rig, "s-r", "refresh-r");
    const res = await handleRefreshToken(
      new Request("https://x/api/auth/refresh", { method: "POST", headers: { Cookie: "radar_refresh=refresh-r" } }), rig.env);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { token: string } };
    expect((await verifyJWT(body.data.token, SECRET))?.sid).toBe("s-r");
  });

  it("refresh still honours a legacy plain-number stamp and the v2 ts", async () => {
    await addSession(rig, "s-r", "refresh-r");
    const req = () => new Request("https://x/api/auth/refresh", { method: "POST", headers: { Cookie: "radar_refresh=refresh-r" } });
    rig.kv.store.set("forced_logout:u1", String(Math.floor(Date.now() / 1000)));
    expect((await handleRefreshToken(req(), rig.env)).status).toBe(401);
    rig.kv.store.set("forced_logout:u1", JSON.stringify({ ts: Math.floor(Date.now() / 1000), sids: {} }));
    expect((await handleRefreshToken(req(), rig.env)).status).toBe(401);
  });
});

describe.skipIf(!hasSqlite())("revocation reaches live access tokens", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = makeRig();
    await addSession(rig, "s-cur", "refresh-cur");
    await addSession(rig, "s-b", "refresh-b");
    await addSession(rig, "s-c", "refresh-c");
  });
  afterEach(() => vi.useRealTimers());

  it("DELETE /sessions/:id: the revoked device's token is rejected; the caller's still works", async () => {
    const mine = await tokenFor("s-cur");
    const theirs = await tokenFor("s-b");
    const other = await tokenFor("s-c");
    expect(await authStatus(rig, theirs)).toBe(200);

    const res = await handleRevokeOwnSession(
      authed(mine, "https://x/api/auth/sessions/s-b", { method: "DELETE" }, "refresh-cur"),
      rig.env, await ctxFor(rig, mine), "s-b");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { revoked: number; revoked_current: boolean | null } };
    expect(body.data).toEqual({ revoked: 1, revoked_current: false });

    expect(await authStatus(rig, theirs)).toBe(401);
    expect(await authStatus(rig, mine)).toBe(200);
    expect(await authStatus(rig, other)).toBe(200);
  });

  it("DELETE refuses the caller's own session identified only by the token sid (no cookie)", async () => {
    const mine = await tokenFor("s-cur");
    const res = await handleRevokeOwnSession(
      authed(mine, "https://x/api/auth/sessions/s-cur", { method: "DELETE" }), rig.env, await ctxFor(rig, mine), "s-cur");
    expect(res.status).toBe(400);
    expect(await authStatus(rig, mine)).toBe(200);
  });

  it("DELETE with neither cookie nor sid: revokes, revoked_current is null (unknown)", async () => {
    const legacy = await tokenFor(undefined);
    const res = await handleRevokeOwnSession(
      authed(legacy, "https://x/api/auth/sessions/s-b", { method: "DELETE" }), rig.env, await ctxFor(rig, legacy), "s-b");
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { revoked_current: unknown } }).data.revoked_current).toBeNull();
  });

  it("revoke-others: every other sid is rejected, the current one is not", async () => {
    const mine = await tokenFor("s-cur");
    const b = await tokenFor("s-b");
    const c = await tokenFor("s-c");
    const res = await handleRevokeOtherSessions(
      authed(mine, "https://x/api/auth/sessions/revoke-others", { method: "POST" }, "refresh-cur"),
      rig.env, await ctxFor(rig, mine));
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { revoked: number } }).data.revoked).toBe(2);
    expect(await authStatus(rig, b)).toBe(401);
    expect(await authStatus(rig, c)).toBe(401);
    expect(await authStatus(rig, mine)).toBe(200);
    // And their refresh is dead too.
    const refresh = await handleRefreshToken(
      new Request("https://x/api/auth/refresh", { method: "POST", headers: { Cookie: "radar_refresh=refresh-b" } }), rig.env);
    expect(refresh.status).toBe(401);
  });

  it("revoke-others falls back to the token sid when the cookie is absent", async () => {
    const mine = await tokenFor("s-cur");
    const res = await handleRevokeOtherSessions(
      authed(mine, "https://x/api/auth/sessions/revoke-others", { method: "POST" }), rig.env, await ctxFor(rig, mine));
    expect(res.status).toBe(200);
    expect(await authStatus(rig, mine)).toBe(200);
    expect(await authStatus(rig, await tokenFor("s-b"))).toBe(401);
  });

  it("a per-session revoke keeps an existing legacy stamp in force", async () => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    const old = await tokenFor(undefined);                     // iat = T0
    rig.kv.store.set("forced_logout:u1", String(sec(T0)));     // legacy writer (e.g. admin force-logout)
    vi.setSystemTime(new Date(T0.getTime() + 5000));
    const mine = await tokenFor("s-cur");
    await handleRevokeOwnSession(
      authed(mine, "https://x/api/auth/sessions/s-b", { method: "DELETE" }, "refresh-cur"),
      rig.env, await ctxFor(rig, mine), "s-b");
    expect(parseForcedLogout(rig.kv.store.get("forced_logout:u1")!)!.ts).toBe(sec(T0));
    expect(await authStatus(rig, old)).toBe(401);
    expect(await authStatus(rig, mine)).toBe(200);
  });

  it("legacy plain-number stamp is still enforced by requireAuth", async () => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    const t = await tokenFor("s-cur");
    rig.kv.store.set("forced_logout:u1", String(sec(T0)));
    expect(await authStatus(rig, t)).toBe(401);
    vi.setSystemTime(new Date(T0.getTime() + 2000));
    expect(await authStatus(rig, await tokenFor("s-cur"))).toBe(200);
  });

  it("logout-all kills every token (sid and sid-less), yet a sign-in in the same second survives", async () => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    const legacyEarlier = await tokenFor(undefined);
    vi.setSystemTime(new Date(T0.getTime() + 3000));
    const mine = await tokenFor("s-cur");          // minted in the same second as logout-all
    const b = await tokenFor("s-b");
    const res = await handleLogoutEverywhere(
      authed(mine, "https://x/api/auth/logout-all", { method: "POST" }, "refresh-cur"), rig.env, await ctxFor(rig, mine));
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await authStatus(rig, legacyEarlier)).toBe(401);
    expect(await authStatus(rig, mine)).toBe(401);  // same second, caught by its sid
    expect(await authStatus(rig, b)).toBe(401);
    const live = rig.raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL").all()[0] as { n: number };
    expect(live.n).toBe(0);

    // Fresh sign-in within the same second: new session, new sid, iat = now > ts.
    const login = await issueSession(new Request("https://x/api/auth/passkey/finish"), rig.env, "u1", "u1@example.com",
      "analyst", "https://x", "/v2/", "passkey", "json");
    const fresh = (await login.json() as { data: { access_token: string } }).data.access_token;
    expect(await authStatus(rig, fresh)).toBe(200);
  });
});

describe.skipIf(!hasSqlite())("read-only identities can't mutate sessions (finding 2)", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = makeRig();
    for (const [id, role] of [["claude_ui_staff", "analyst"], ["claude_ui_tenant", "client"], ["svc", "analyst"]] as const) {
      rig.raw.prepare("INSERT INTO users (id, email, name, role, status) VALUES (?, ?, 'P', ?, 'active')").run(id, `${id}@x`, role);
    }
  });

  const callers: Array<{ name: string; userId: string; role: UserRole }> = [
    { name: "auditor (service account / staff preview JWT role)", userId: "svc", role: "auditor" },
    { name: "staff preview preset", userId: "claude_ui_staff", role: "auditor" },
    { name: "tenant preview preset (client role)", userId: "claude_ui_tenant", role: "client" },
  ];

  for (const c of callers) {
    it(`${c.name}: 403 on logout-all, revoke-others and DELETE; forced_logout untouched`, async () => {
      const t = await tokenFor(undefined, c.role, c.userId);
      const ctx = await ctxFor(rig, t);
      const r1 = await handleLogoutEverywhere(authed(t, "https://x/api/auth/logout-all", { method: "POST" }), rig.env, ctx);
      const r2 = await handleRevokeOtherSessions(authed(t, "https://x/api/auth/sessions/revoke-others", { method: "POST" }), rig.env, ctx);
      const r3 = await handleRevokeOwnSession(authed(t, "https://x/api/auth/sessions/x", { method: "DELETE" }), rig.env, ctx, "x");
      expect([r1.status, r2.status, r3.status]).toEqual([403, 403, 403]);
      expect(rig.kv.store.has(`forced_logout:${c.userId}`)).toBe(false);
      expect(await authStatus(rig, t)).toBe(200);
    });
  }
});
