// SECURITY_AUDIT_2026-07-12 O1 regression guard.
//
// The MCP service-account JWT (handleMintServiceJwt) used to mint
// role='super_admin', giving the two GET-only probe tools (smoke_test,
// assert_endpoint) full platform privilege if the token leaked. Commit
// b0e5f99 re-scoped it to the read-only global `auditor` role and
// shortened the TTL from 90d to 30d. This file locks that invariant so a
// future edit can't silently re-widen the service account.
//
// Harness note: mirrors the D1 stub + signed-request pattern used by
// test/tenant-org-member-guard.test.ts.

import { describe, it, expect } from "vitest";
import { handleMintServiceJwt, uiPreviewDbRole } from "../src/handlers/auth";
import { verifyJWT } from "../src/lib/jwt";
import { requireAdmin, requireSuperAdmin, requireStaff, isAuthContext } from "../src/middleware/auth";
import { signJWT } from "../src/lib/jwt";
import type { Env } from "../src/types";

const SECRET = "test-secret-service-jwt-scope";
const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

// ─── D1 stub for handleMintServiceJwt's three sequential calls ──────
// 1. INSERT OR IGNORE INTO users (...) -> .run()
// 2. UPDATE users SET role = ? WHERE id = ? AND role != ? -> .run()
// 3. SELECT status FROM users WHERE id = ? -> .first()
//
// Records every bind() call so the INSERT/UPDATE placeholder role can be
// asserted without depending on statement text parsing.
function makeEnv(): { env: Env; binds: unknown[][] } {
  const binds: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          binds.push(args);
          return {
            async run() {
              return { success: true };
            },
            async first<T>() {
              if (sql.includes("SELECT status")) {
                return { status: "active" } as unknown as T;
              }
              return null;
            },
          };
        },
      };
    },
  };
  const env = { JWT_SECRET: SECRET, DB: db } as unknown as Env;
  return { env, binds };
}

describe("handleMintServiceJwt — O1 regression guard", () => {
  it("mints a JWT carrying role 'auditor', never 'super_admin'", async () => {
    const { env } = makeEnv();
    const req = new Request("https://averrow.com/api/internal/auth/mint-service-jwt", {
      method: "POST",
      headers: { Origin: "https://averrow.com" },
    });

    const res = await handleMintServiceJwt(req, env);
    expect(res.status).toBe(200);

    const body = await res.json<{ success: boolean; data: { jwt: string; expires_at: string; ttl_seconds: number; user_id: string } }>();
    expect(body.success).toBe(true);

    const payload = await verifyJWT(body.data.jwt, SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.role).toBe("auditor");
    expect(payload?.role).not.toBe("super_admin");
  });

  it("sets a 30-day TTL (not the old 90-day TTL)", async () => {
    const { env } = makeEnv();
    const req = new Request("https://averrow.com/api/internal/auth/mint-service-jwt", { method: "POST" });

    const res = await handleMintServiceJwt(req, env);
    const body = await res.json<{ data: { ttl_seconds: number; expires_at: string } }>();

    expect(body.data.ttl_seconds).toBe(THIRTY_DAYS_SECONDS);
    expect(body.data.ttl_seconds).not.toBe(60 * 60 * 24 * 90);

    const expiresAtMs = new Date(body.data.expires_at).getTime();
    const expectedMs = Date.now() + THIRTY_DAYS_SECONDS * 1000;
    // Allow a few seconds of test-execution slack.
    expect(Math.abs(expiresAtMs - expectedMs)).toBeLessThan(10_000);
  });

  it("embeds the same 30-day expiry in the JWT's own exp claim", async () => {
    const { env } = makeEnv();
    const req = new Request("https://averrow.com/api/internal/auth/mint-service-jwt", { method: "POST" });

    const res = await handleMintServiceJwt(req, env);
    const body = await res.json<{ data: { jwt: string } }>();
    const payload = await verifyJWT(body.data.jwt, SECRET);

    expect(payload).not.toBeNull();
    const ttl = (payload!.exp as number) - (payload!.iat as number);
    expect(ttl).toBe(THIRTY_DAYS_SECONDS);
  });

  it("stores the DB row under the CHECK-valid 'analyst' placeholder, never 'auditor' or 'super_admin'", async () => {
    const { env, binds } = makeEnv();
    const req = new Request("https://averrow.com/api/internal/auth/mint-service-jwt", { method: "POST" });

    await handleMintServiceJwt(req, env);

    // Every bound role value across the INSERT + UPDATE calls must be the
    // CHECK-valid placeholder ('analyst'), matching uiPreviewDbRole("auditor").
    const placeholder = uiPreviewDbRole("auditor");
    expect(placeholder).toBe("analyst");

    const boundRoleValues = binds
      .flat()
      .filter((v): v is string => typeof v === "string")
      .filter((v) => v === "analyst" || v === "auditor" || v === "super_admin");

    expect(boundRoleValues.length).toBeGreaterThan(0);
    expect(boundRoleValues.every((v) => v === "analyst")).toBe(true);
    expect(boundRoleValues).not.toContain("super_admin");
    expect(boundRoleValues).not.toContain("auditor");
  });

  it("503s (does not mint) when the service account row is not active", async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async run() {
                return { success: true };
              },
              async first<T>() {
                if (sql.includes("SELECT status")) {
                  return { status: "suspended" } as unknown as T;
                }
                return null;
              },
            };
          },
        };
      },
    };
    const env = { JWT_SECRET: SECRET, DB: db } as unknown as Env;
    const req = new Request("https://averrow.com/api/internal/auth/mint-service-jwt", { method: "POST" });

    const res = await handleMintServiceJwt(req, env);
    expect(res.status).toBe(503);
    const body = await res.json<{ success: boolean }>();
    expect(body.success).toBe(false);
  });
});

// ─── RBAC downgrade: auditor passes requireStaff, fails admin gates ──
// The O1 fix's safety property depends on this holding: the minted
// `auditor` role must clear requireStaff (so the MCP probes still work)
// but be rejected by requireAdmin / requireSuperAdmin (so a leaked token
// can't reach admin-only mutation surfaces). role-permissions-level
// coverage already exists in test/auditor-role.test.ts; this exercises
// the actual middleware guards end-to-end against a signed JWT.

function makeGuardEnv(): Env {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first<T>() {
              return { status: "active" } as unknown as T;
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };
  const cache = {
    async get() {
      return null;
    },
    async put() {},
  };
  return { JWT_SECRET: SECRET, DB: db, CACHE: cache } as unknown as Env;
}

async function auditorRequest(): Promise<Request> {
  const token = await signJWT(
    { sub: "service_account_mcp", email: "service-mcp@averrow.local", role: "auditor" },
    SECRET,
    300,
  );
  return new Request("https://averrow.com/api/internal/probe", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("auditor role — MCP service JWT downgrade holds against real guards", () => {
  it("passes requireStaff", async () => {
    const env = makeGuardEnv();
    const result = await requireStaff(await auditorRequest(), env);
    expect(isAuthContext(result)).toBe(true);
  });

  it("FAILS requireAdmin (403)", async () => {
    const env = makeGuardEnv();
    const result = await requireAdmin(await auditorRequest(), env);
    expect(isAuthContext(result)).toBe(false);
    expect((result as Response).status).toBe(403);
  });

  it("FAILS requireSuperAdmin (403)", async () => {
    const env = makeGuardEnv();
    const result = await requireSuperAdmin(await auditorRequest(), env);
    expect(isAuthContext(result)).toBe(false);
    expect((result as Response).status).toBe(403);
  });
});
