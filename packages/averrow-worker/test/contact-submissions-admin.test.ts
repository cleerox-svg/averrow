// G33: staff read/handle endpoints for marketing contact/demo submissions.
//
// Part 1 pins the route guard (requireSales, same as /api/admin/sales-leads)
// with the handlers stubbed, using the harness from
// audit-routes-permission.test.ts: the guard runs for real against a signed
// JWT. Part 2 exercises the handlers against a mock D1.

import { describe, it, expect, vi } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { registerAdminRoutes } from "../src/routes/admin";
import { signJWT } from "../src/lib/jwt";
import type { Env, UserRole } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";

const handlerCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/handlers/contactSubmissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/handlers/contactSubmissions")>();
  const ok = async (): Promise<Response> => {
    handlerCalls.count++;
    return new Response(JSON.stringify({ success: true, data: "handler-reached" }), { status: 200 });
  };
  return {
    ...actual,
    handleListContactSubmissions: ok,
    handleUpdateContactSubmission: ok,
    __real: actual,
  };
});

const SECRET = "test-secret-contact-submissions";

function makeAuthEnv(): Env {
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
  const cache = { async get() { return null; }, async put() {} };
  return { JWT_SECRET: SECRET, DB: db, CACHE: cache } as unknown as Env;
}

async function requestAs(role: UserRole | null, method: string, path: string): Promise<Request> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (role) {
    const token = await signJWT({ sub: `user_${role}`, email: `${role}@averrow.local`, role }, SECRET, 300);
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request(`https://averrow.com${path}`, {
    method,
    headers,
    body: method === "PATCH" ? JSON.stringify({ handled: true }) : undefined,
  });
}

function buildRouter(): RouterType<IRequest> {
  const router = Router();
  registerAdminRoutes(router);
  return router;
}

const ROUTES: Array<[string, string]> = [
  ["GET", "/api/admin/contact-submissions"],
  ["GET", "/api/admin/contact-submissions?limit=500&status=open"],
  ["PATCH", "/api/admin/contact-submissions/abc-123"],
];
const ALLOWED: UserRole[] = ["super_admin", "admin", "sales"];
const DENIED: UserRole[] = ["analyst", "support", "billing", "auditor", "client"];

describe("contact-submissions admin routes are gated with requireSales", () => {
  for (const [method, path] of ROUTES) {
    for (const role of ALLOWED) {
      it(`${role} reaches ${method} ${path}`, async () => {
        const before = handlerCalls.count;
        const res = (await buildRouter().fetch(await requestAs(role, method, path), makeAuthEnv())) as Response;
        expect(res.status).toBe(200);
        expect(handlerCalls.count).toBe(before + 1);
      });
    }
    for (const role of DENIED) {
      it(`${role} gets 403 on ${method} ${path}`, async () => {
        const before = handlerCalls.count;
        const res = (await buildRouter().fetch(await requestAs(role, method, path), makeAuthEnv())) as Response;
        expect(res.status).toBe(403);
        expect(handlerCalls.count).toBe(before);
      });
    }
    it(`no token gets 401 on ${method} ${path}`, async () => {
      const before = handlerCalls.count;
      const res = (await buildRouter().fetch(await requestAs(null, method, path), makeAuthEnv())) as Response;
      expect(res.status).toBe(401);
      expect(handlerCalls.count).toBe(before);
    });
  }
});

// ─── Handlers ─────────────────────────────────────────────────────────

type Real = typeof import("../src/handlers/contactSubmissions");
async function real(): Promise<Real> {
  const mod = (await import("../src/handlers/contactSubmissions")) as unknown as { __real: Real };
  return mod.__real;
}

interface Call { sql: string; binds: unknown[] }

function makeDataEnv(opts: { changes?: number; missing?: boolean } = {}) {
  const calls: Call[] = [];
  const stmt = (sql: string) => {
    const call: Call = { sql, binds: [] };
    calls.push(call);
    return {
      bind(...args: unknown[]) {
        call.binds = args;
        return this;
      },
      async all<T>() {
        return { results: [{ id: "s1", name: "Dana" }] as unknown as T[] };
      },
      async first<T>() {
        if (/COUNT\(\*\)/.test(sql)) return { n: 7 } as unknown as T;
        return (opts.missing ? null : { id: "s1", handled_at: "2026-10-06" }) as unknown as T;
      },
      async run() {
        return { success: true, meta: { changes: opts.changes ?? 1 } };
      },
    };
  };
  const db = { prepare: stmt, withSession: () => ({ prepare: stmt }) };
  const audits: unknown[][] = [];
  const auditDb = {
    prepare() {
      return {
        bind(...args: unknown[]) {
          audits.push(args);
          return { async run() { return { success: true }; } };
        },
      };
    },
  };
  return { env: { DB: db, AUDIT_DB: auditDb } as unknown as Env, calls, audits };
}

const CTX = { userId: "user_sales", role: "sales" } as unknown as AuthContext;

describe("handleListContactSubmissions", () => {
  it("lists newest first, never selects ip_address, and caps limit at 100", async () => {
    const { handleListContactSubmissions } = await real();
    const { env, calls } = makeDataEnv();
    const res = await handleListContactSubmissions(
      new Request("https://averrow.com/api/admin/contact-submissions?limit=500&offset=20"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; total: number; limit: number; offset: number };
    expect(body).toMatchObject({ success: true, total: 7, limit: 100, offset: 20 });
    const list = calls.find((c) => /ORDER BY/.test(c.sql))!;
    expect(list.sql).toMatch(/ORDER BY created_at DESC/);
    expect(list.sql).not.toMatch(/ip_address/);
    expect(list.binds).toEqual([100, 20]);
  });

  it("filters open/handled and rejects an unknown status", async () => {
    const { handleListContactSubmissions } = await real();
    const open = makeDataEnv();
    await handleListContactSubmissions(new Request("https://averrow.com/x?status=open"), open.env);
    expect(open.calls.every((c) => /handled_at IS NULL/.test(c.sql))).toBe(true);
    const bad = await handleListContactSubmissions(new Request("https://averrow.com/x?status=1;DROP"), makeDataEnv().env);
    expect(bad.status).toBe(400);
  });
});

describe("handleUpdateContactSubmission", () => {
  const patch = (body: unknown) =>
    new Request("https://averrow.com/api/admin/contact-submissions/s1", {
      method: "PATCH",
      body: JSON.stringify(body),
    });

  it("marks handled with the caller as handled_by and writes audit_log", async () => {
    const { handleUpdateContactSubmission } = await real();
    const { env, calls, audits } = makeDataEnv();
    const res = await handleUpdateContactSubmission(patch({ handled: true }), env, CTX, "s1");
    expect(res.status).toBe(200);
    const upd = calls.find((c) => /^\s*UPDATE/.test(c.sql))!;
    expect(upd.binds).toEqual(["user_sales", "s1"]);
    expect(audits[0]).toContain("contact_submission_handled");
  });

  it("reopens with handled:false", async () => {
    const { handleUpdateContactSubmission } = await real();
    const { env, calls, audits } = makeDataEnv();
    await handleUpdateContactSubmission(patch({ handled: false }), env, CTX, "s1");
    const upd = calls.find((c) => /^\s*UPDATE/.test(c.sql))!;
    expect(upd.sql).toMatch(/handled_at = NULL/);
    expect(audits[0]).toContain("contact_submission_reopened");
  });

  it("400s on a non-boolean `handled`", async () => {
    const { handleUpdateContactSubmission } = await real();
    const res = await handleUpdateContactSubmission(patch({ handled: "yes" }), makeDataEnv().env, CTX, "s1");
    expect(res.status).toBe(400);
  });

  it("404s on an unknown id", async () => {
    const { handleUpdateContactSubmission } = await real();
    const { env, audits } = makeDataEnv({ changes: 0, missing: true });
    const res = await handleUpdateContactSubmission(patch({ handled: true }), env, CTX, "nope");
    expect(res.status).toBe(404);
    expect(audits).toHaveLength(0);
  });

  it("only touches a row whose state changes (handled_at guard in the WHERE)", async () => {
    const { handleUpdateContactSubmission } = await real();
    const h = makeDataEnv();
    await handleUpdateContactSubmission(patch({ handled: true }), h.env, CTX, "s1");
    expect(h.calls.find((c) => /^\s*UPDATE/.test(c.sql))!.sql).toMatch(/AND handled_at IS NULL/);
    const r = makeDataEnv();
    await handleUpdateContactSubmission(patch({ handled: false }), r.env, CTX, "s1");
    expect(r.calls.find((c) => /^\s*UPDATE/.test(c.sql))!.sql).toMatch(/AND handled_at IS NOT NULL/);
  });

  it("a PATCH that changes nothing returns the row and writes no audit row", async () => {
    const { handleUpdateContactSubmission } = await real();
    const { env, audits } = makeDataEnv({ changes: 0 });
    const res = await handleUpdateContactSubmission(patch({ handled: true }), env, CTX, "s1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe("s1");
    expect(audits).toHaveLength(0);
  });
});
