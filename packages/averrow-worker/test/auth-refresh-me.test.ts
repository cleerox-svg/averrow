/**
 * Page-load perf (PR 1/5): POST /api/auth/refresh carries the full
 * /api/auth/me payload as `data.me`, so a cold SPA load can skip the serial
 * GET /api/auth/me. Pinned here:
 *   - `data.me` is deep-equal to what /me returns for the same session's
 *     token (same shape, same values), with or without an org membership;
 *   - `passkey_required` mirrors the scope of the token the refresh just
 *     issued (true for an enrollment-scoped admin rotation);
 *   - the payload is always the cookie session's user, never the body's;
 *   - the back-compat `token` / `expires_in` / `user` fields are unchanged;
 *   - /me's own response is unchanged (404 for a missing user).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { verifyJWT, ACCESS_TOKEN_TTL } from "../src/lib/jwt";
import { hashToken } from "../src/lib/hash";
import { handleRefreshToken, handleMe, buildMePayload } from "../src/handlers/auth";
import type { Env } from "../src/types";

const SECRET = "test-secret-refresh-me";

interface Rig { raw: SqliteDb; env: Env }

function makeRig(): Rig {
  const raw = openDerivedDb(["users", "sessions", "org_members", "organizations", "org_brands", "passkeys"]);
  const env = {
    DB: d1FromSqlite(raw),
    AUDIT_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
    CACHE: fakeKv(),
    JWT_SECRET: SECRET,
  } as unknown as Env;
  return { raw, env };
}

function addUser(rig: Rig, id: string, role: string, extra: { display_name?: string } = {}): void {
  rig.raw.prepare(
    "INSERT INTO users (id, email, name, role, status, display_name) VALUES (?, ?, 'Plain Name', ?, 'active', ?)",
  ).run(id, `${id}@example.com`, role, extra.display_name ?? null);
}

async function addSession(rig: Rig, id: string, userId: string, refresh: string, method: string): Promise<void> {
  rig.raw.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, issued_at, expires_at, auth_method)
     VALUES (?, ?, ?, datetime('now', '-1 hour'), datetime('now', '+7 days'), ?)`,
  ).run(id, userId, await hashToken(refresh), method);
}

function refreshReq(refresh: string, body?: string): Request {
  return new Request("https://averrow.com/api/auth/refresh", {
    method: "POST",
    headers: { Cookie: `radar_refresh=${refresh}`, "Content-Type": "application/json" },
    ...(body ? { body } : {}),
  });
}

interface RefreshBody {
  success: boolean;
  data: {
    token: string;
    expires_in: number;
    user: { id: string; email: string; role: string };
    me?: Record<string, unknown>;
  };
}

async function refresh(rig: Rig, token: string, body?: string): Promise<RefreshBody> {
  const res = await handleRefreshToken(refreshReq(token, body), rig.env);
  expect(res.status).toBe(200);
  return (await res.json()) as RefreshBody;
}

async function meFor(rig: Rig, userId: string, enrollOnly: boolean): Promise<Record<string, unknown>> {
  const res = await handleMe(new Request("https://averrow.com/api/auth/me"), rig.env, userId, enrollOnly);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe.skipIf(!hasSqlite())("POST /api/auth/refresh returns the /me payload", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("staff user, no org: me equals /me, organization null, passkey_required false", async () => {
    addUser(rig, "u1", "analyst", { display_name: "Display" });
    rig.raw.prepare("INSERT INTO passkeys (id, user_id, credential_id, public_key) VALUES ('pk1', 'u1', 'c1', 'k1')").run();
    await addSession(rig, "s1", "u1", "r1", "google_oauth");

    const body = await refresh(rig, "r1");
    // Back-compat fields untouched.
    expect(body.data.expires_in).toBe(ACCESS_TOKEN_TTL);
    expect(body.data.user).toEqual({ id: "u1", email: "u1@example.com", role: "analyst" });
    const claims = await verifyJWT(body.data.token, SECRET);
    expect(claims?.scope).toBeUndefined();

    const me = body.data.me!;
    expect(me).toBeDefined();
    expect(me).toEqual(await meFor(rig, "u1", false));
    expect(Object.keys(me)).toEqual(Object.keys(await meFor(rig, "u1", false)));
    expect(me.name).toBe("Display");
    expect(me.passkey_count).toBe(1);
    expect(me.passkey_required).toBe(false);
    expect(me.organization).toBeNull();
  });

  it("enrollment-scoped admin rotation: passkey_required true, matching the issued token's scope", async () => {
    addUser(rig, "a1", "admin");
    await addSession(rig, "s2", "a1", "r2", "google_oauth");

    const body = await refresh(rig, "r2");
    const claims = await verifyJWT(body.data.token, SECRET);
    expect(claims?.scope).toBe("passkey_enroll");
    expect(body.data.me!.passkey_required).toBe(true);
    expect(body.data.me).toEqual(await meFor(rig, "a1", true));
  });

  it("admin signed in with a passkey: full token, passkey_required false", async () => {
    addUser(rig, "a2", "admin");
    await addSession(rig, "s3", "a2", "r3", "passkey");
    const body = await refresh(rig, "r3");
    expect((await verifyJWT(body.data.token, SECRET))?.scope).toBeUndefined();
    expect(body.data.me!.passkey_required).toBe(false);
  });

  it("client with an active org: organization populated and JWT org claims unchanged", async () => {
    addUser(rig, "c1", "client");
    rig.raw.prepare("INSERT INTO organizations (id, name, slug, plan) VALUES (7, 'Acme', 'acme', 'professional')").run();
    rig.raw.prepare("INSERT INTO org_members (org_id, user_id, role, status) VALUES (7, 'c1', 'admin', 'active')").run();
    await addSession(rig, "s4", "c1", "r4", "google_oauth");

    const body = await refresh(rig, "r4");
    const claims = await verifyJWT(body.data.token, SECRET);
    expect(claims?.org_id).toBe("7");
    expect(claims?.org_role).toBe("admin");
    expect(body.data.me!.organization).toEqual({ id: 7, name: "Acme", slug: "acme", plan: "professional", role: "admin" });
    expect(body.data.me).toEqual(await meFor(rig, "c1", false));
  });

  it("ignores any user id in the request body — payload is the cookie session's user", async () => {
    addUser(rig, "u1", "analyst");
    addUser(rig, "victim", "super_admin");
    await addSession(rig, "s5", "u1", "r5", "google_oauth");
    const body = await refresh(rig, "r5", JSON.stringify({ user_id: "victim", userId: "victim", sub: "victim" }));
    expect(body.data.me!.id).toBe("u1");
    expect(body.data.me!.email).toBe("u1@example.com");
  });

  it("omits me (and still refreshes) when the payload build fails", async () => {
    addUser(rig, "u1", "analyst");
    await addSession(rig, "s6", "u1", "r6", "google_oauth");
    rig.raw.exec("DROP TABLE passkeys"); // makes the /me user SELECT throw
    const body = await refresh(rig, "r6");
    expect(body.success).toBe(true);
    expect(body.data.token).toBeTruthy();
    expect(body.data).not.toHaveProperty("me");
  });
});

describe.skipIf(!hasSqlite())("GET /api/auth/me is unchanged", () => {
  let rig: Rig;
  beforeEach(() => { rig = makeRig(); });

  it("returns the documented key set in order", async () => {
    addUser(rig, "u1", "analyst");
    const data = await meFor(rig, "u1", false);
    expect(Object.keys(data)).toEqual([
      "id", "email", "name", "role", "status", "created_at", "last_login", "last_active",
      "display_name", "timezone", "theme_preference", "accent_preference", "base_preference",
      "passkey_count", "passkey_required", "organization",
    ]);
    expect(data.name).toBe("Plain Name");
  });

  it("404s for a missing user; buildMePayload returns null", async () => {
    const res = await handleMe(new Request("https://averrow.com/api/auth/me"), rig.env, "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: "User not found" });
    expect(await buildMePayload(rig.env, "nope", false)).toBeNull();
  });
});
