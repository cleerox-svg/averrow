// PATCH /api/admin/takedowns/integrations/:kind — the operator auto-submit
// gate (takedown_providers.auto_submit_enabled) for the API integrations.
//
// Handler-level: validation (unknown kind 404, email kind 400, body 400),
// the role split (ON = super_admin only, OFF = admin or super_admin), missing
// provider row 409, the value-pinned UPDATE (concurrent change 409), the
// same-value no-op, the audit row and the minimal response
// `{ kind, auto_submit_enabled, changed }`.
// Router-level: requireAdmin — analyst (who can VIEW the integrations) and
// other staff get 403. The guard runs for real against a signed JWT.

import { describe, it, expect } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { handleAdminUpdateTakedownIntegration } from "../src/handlers/takedowns";
import { registerAdminRoutes } from "../src/routes/admin";
import { signJWT } from "../src/lib/jwt";
import type { Env, UserRole } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";

const SECRET = "test-secret-takedown-integration-auto-submit";

const ADMIN: AuthContext = {
  userId: "u-admin", email: "admin@averrow.local", role: "admin",
  orgId: null, orgRole: null, embeddedScope: undefined,
};
const SUPER: AuthContext = { ...ADMIN, userId: "u-super", email: "super@averrow.local", role: "super_admin" };

interface ProviderRow {
  id: number; provider_name: string; provider_type: string | null;
  abuse_email: string | null; abuse_url: string | null; abuse_api_url: string | null;
  abuse_api_type: string; auto_submit_enabled: number | null;
}

interface Captured { sql: string; binds: unknown[] }

function makeEnv(
  providers: ProviderRow[],
  vars: Record<string, string> = {},
  /** Runs between the handler's read and its UPDATE (simulates a racing writer). */
  beforeUpdate?: (rows: ProviderRow[]) => void,
) {
  const runs: Captured[] = [];
  const audits: Captured[] = [];
  const rows = providers.map((p) => ({ ...p }));

  const prepare = (sql: string) => {
    const exec = (binds: unknown[]) => ({
      async first<T>(): Promise<T | null> {
        if (sql.includes("FROM users")) return { status: "active" } as unknown as T;
        if (sql.includes("SELECT auto_submit_enabled FROM takedown_providers")) {
          const r = rows.filter((x) => x.abuse_api_type === binds[0]).sort((a, b) => a.id - b.id)[0];
          return (r ? { auto_submit_enabled: r.auto_submit_enabled } : null) as T | null;
        }
        // Web Risk monthly count.
        return { n: 0 } as unknown as T;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (sql.includes("FROM takedown_providers")) {
          return { results: [...rows].sort((a, b) => a.id - b.id) as unknown as T[] };
        }
        return { results: [] };
      },
      async run() {
        runs.push({ sql, binds });
        if (sql.includes("UPDATE takedown_providers")) {
          beforeUpdate?.(rows);
          // SET auto_submit_enabled = ?1 WHERE abuse_api_type = ?2 AND auto_submit_enabled IS ?3
          let changes = 0;
          for (const r of rows) {
            if (r.abuse_api_type === binds[1] && (r.auto_submit_enabled ?? null) === (binds[2] ?? null)) {
              r.auto_submit_enabled = binds[0] as number;
              changes++;
            }
          }
          return { success: true, meta: { changes } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    });
    return { bind: (...b: unknown[]) => exec(b), ...exec([]) };
  };

  const auditDb = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        async run() { audits.push({ sql, binds }); return { success: true }; },
      }),
    }),
  };

  const env = {
    ...vars,
    JWT_SECRET: SECRET,
    DB: { prepare },
    AUDIT_DB: auditDb,
    CACHE: { async get() { return null; }, async put() {} },
  } as unknown as Env;
  return { env, runs, audits, rows };
}

const NETBEACON: ProviderRow = {
  id: 7, provider_name: "NetBeacon", provider_type: "registrar", abuse_email: null,
  abuse_url: "https://netbeacon.org", abuse_api_url: "https://api.netbeacon.org",
  abuse_api_type: "netbeacon", auto_submit_enabled: 0,
};

function patchReq(kind: string, body: unknown, token?: string): Request {
  return new Request(`https://averrow.com/api/admin/takedowns/integrations/${kind}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(env: Env, kind: string, body: unknown, ctx: AuthContext = SUPER) {
  const res = await handleAdminUpdateTakedownIntegration(patchReq(kind, body), env, kind, ctx);
  const json = await res.json() as { success: boolean; data?: Record<string, unknown>; error?: string };
  return { status: res.status, json };
}

const updates = (runs: Captured[]) => runs.filter((r) => r.sql.includes("UPDATE takedown_providers"));

describe("handleAdminUpdateTakedownIntegration", () => {
  it("super_admin turns auto-submit ON: pinned UPDATE, one audit row, minimal response", async () => {
    const { env, runs, audits, rows } = makeEnv([NETBEACON], { NETBEACON_API_KEY: "k", TAKEDOWN_SEND_MODE: "live" });
    const { status, json } = await call(env, "api_netbeacon", { auto_submit_enabled: true }, SUPER);
    expect(status).toBe(200);
    expect(json).toEqual({ success: true, data: { kind: "api_netbeacon", auto_submit_enabled: true, changed: true } });

    const upd = updates(runs);
    expect(upd).toHaveLength(1);
    expect(upd[0]!.sql).toMatch(/WHERE abuse_api_type = \? AND auto_submit_enabled IS \?/);
    expect(upd[0]!.binds).toEqual([1, "netbeacon", 0]); // pinned to the value read
    expect(rows[0]!.auto_submit_enabled).toBe(1);

    expect(audits).toHaveLength(1);
    const b = audits[0]!.binds;
    // (id, user_id, action, resource_type, resource_id, details, ip, ua, outcome)
    expect(b[1]).toBe("u-super");
    expect(b[2]).toBe("takedown_integration_auto_submit");
    expect(b[3]).toBe("takedown_integration");
    expect(b[4]).toBe("api_netbeacon");
    expect(JSON.parse(b[5] as string)).toEqual({
      kind: "api_netbeacon", abuse_api_type: "netbeacon", from: false, to: true,
    });
  });

  it("admin (not super_admin) turning it ON → 403, nothing written or audited", async () => {
    const { env, runs, audits, rows } = makeEnv([NETBEACON]);
    const { status, json } = await call(env, "api_netbeacon", { auto_submit_enabled: true }, ADMIN);
    expect(status).toBe(403);
    expect(json).toEqual({ success: false, error: "Only a super admin can turn on auto-submit" });
    expect(updates(runs)).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(rows[0]!.auto_submit_enabled).toBe(0);
  });

  it("admin CAN turn it OFF (kill switch) and the audit records from/to", async () => {
    const { env, audits, rows } = makeEnv([{ ...NETBEACON, auto_submit_enabled: 1 }], { NETBEACON_API_KEY: "k" });
    const { status, json } = await call(env, "api_netbeacon", { auto_submit_enabled: false }, ADMIN);
    expect(status).toBe(200);
    expect(json.data).toEqual({ kind: "api_netbeacon", auto_submit_enabled: false, changed: true });
    expect(rows[0]!.auto_submit_enabled).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.binds[1]).toBe("u-admin");
    expect(JSON.parse(audits[0]!.binds[5] as string)).toMatchObject({ from: true, to: false });
  });

  it("super_admin can turn it OFF too", async () => {
    const { env, rows } = makeEnv([{ ...NETBEACON, auto_submit_enabled: 1 }]);
    const { status, json } = await call(env, "api_netbeacon", { auto_submit_enabled: false }, SUPER);
    expect(status).toBe(200);
    expect(json.data!.changed).toBe(true);
    expect(rows[0]!.auto_submit_enabled).toBe(0);
  });

  for (const [label, current, next, ctx] of [
    ["OFF → OFF by admin", 0, false, ADMIN],
    ["ON → ON by super_admin", 1, true, SUPER],
  ] as Array<[string, number, boolean, AuthContext]>) {
    it(`same-value request (${label}) is a no-op: 200 changed:false, no UPDATE, no audit`, async () => {
      const { env, runs, audits } = makeEnv([{ ...NETBEACON, auto_submit_enabled: current }]);
      const { status, json } = await call(env, "api_netbeacon", { auto_submit_enabled: next }, ctx);
      expect(status).toBe(200);
      expect(json.data).toEqual({ kind: "api_netbeacon", auto_submit_enabled: next, changed: false });
      expect(updates(runs)).toHaveLength(0);
      expect(audits).toHaveLength(0);
    });
  }

  it("concurrent change between read and UPDATE → 409, no audit", async () => {
    // Read sees 1 (on); a racing writer flips it to 0 before our pinned UPDATE.
    const { env, audits, rows } = makeEnv(
      [{ ...NETBEACON, auto_submit_enabled: 1 }], {},
      (r) => { r[0]!.auto_submit_enabled = 0; },
    );
    const { status, json } = await call(env, "api_netbeacon", { auto_submit_enabled: false }, ADMIN);
    expect(status).toBe(409);
    expect(json.error).toBe("Auto-submit changed concurrently — reload and try again");
    expect(audits).toHaveLength(0);
    expect(rows[0]!.auto_submit_enabled).toBe(0);
  });

  it("a NULL stored flag reads as off and the pinned UPDATE still matches it (IS NULL)", async () => {
    const { env, runs, rows } = makeEnv([{ ...NETBEACON, auto_submit_enabled: null }]);
    const { status, json } = await call(env, "api_netbeacon", { auto_submit_enabled: true }, SUPER);
    expect(status).toBe(200);
    expect(json.data!.changed).toBe(true);
    expect(updates(runs)[0]!.binds).toEqual([1, "netbeacon", null]);
    expect(rows[0]!.auto_submit_enabled).toBe(1);
  });

  it("unknown kind → 404, nothing written", async () => {
    const { env, runs, audits } = makeEnv([NETBEACON]);
    const { status, json } = await call(env, "api_nope", { auto_submit_enabled: true });
    expect(status).toBe(404);
    expect(json.success).toBe(false);
    expect(runs).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  for (const kind of ["email_send", "email_draft", "followup_email_draft"]) {
    it(`${kind} → 400 (only API integrations have an auto-submit gate)`, async () => {
      const { env, runs } = makeEnv([NETBEACON]);
      const { status, json } = await call(env, kind, { auto_submit_enabled: true });
      expect(status).toBe(400);
      expect(json.error).toBe("Auto-submit is only configurable for API integrations");
      expect(runs).toHaveLength(0);
    });
  }

  const BAD_BODIES: Array<[string, unknown]> = [
    ["missing field", {}],
    ["number 1", { auto_submit_enabled: 1 }],
    ["string 'true'", { auto_submit_enabled: "true" }],
    ["null", { auto_submit_enabled: null }],
    ["extra field", { auto_submit_enabled: true, abuse_email: "x@y.z" }],
    ["array body", [true]],
    ["bare boolean", true],
    ["invalid JSON", "{not json"],
  ];
  for (const [label, body] of BAD_BODIES) {
    it(`body ${label} → 400, nothing written`, async () => {
      const { env, runs, audits } = makeEnv([NETBEACON]);
      const { status, json } = await call(env, "api_netbeacon", body);
      expect(status).toBe(400);
      expect(json.success).toBe(false);
      expect(runs).toHaveLength(0);
      expect(audits).toHaveLength(0);
    });
  }

  it("no provider row for the integration → 409, nothing written", async () => {
    const { env, runs, audits } = makeEnv([NETBEACON]); // no web_risk row
    const { status, json } = await call(env, "api_web_risk", { auto_submit_enabled: true });
    expect(status).toBe(409);
    expect(json.error).toBe("No provider row for this integration");
    expect(runs).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});

describe("PATCH /api/admin/takedowns/integrations/:kind — requireAdmin route gate", () => {
  function buildRouter(): RouterType<IRequest> {
    const router = Router();
    registerAdminRoutes(router);
    return router;
  }
  async function tokenFor(role: UserRole): Promise<string> {
    return signJWT({ sub: `user_${role}`, email: `${role}@averrow.local`, role }, SECRET, 300);
  }

  it("no token → 401", async () => {
    const { env, runs } = makeEnv([NETBEACON]);
    const res = (await buildRouter().fetch(patchReq("api_netbeacon", { auto_submit_enabled: true }), env)) as Response;
    expect(res.status).toBe(401);
    expect(runs).toHaveLength(0);
  });

  for (const role of ["analyst", "sales", "support", "billing", "auditor", "client"] as UserRole[]) {
    it(`${role} → 403, nothing written`, async () => {
      const { env, runs } = makeEnv([NETBEACON]);
      const res = (await buildRouter().fetch(
        patchReq("api_netbeacon", { auto_submit_enabled: true }, await tokenFor(role)), env)) as Response;
      expect(res.status).toBe(403);
      expect(runs.filter((r) => r.sql.includes("takedown_providers"))).toHaveLength(0);
    });
  }

  it("super_admin turns it ON through the router", async () => {
    const { env, rows } = makeEnv([NETBEACON]);
    const res = (await buildRouter().fetch(
      patchReq("api_netbeacon", { auto_submit_enabled: true }, await tokenFor("super_admin")), env)) as Response;
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { kind: string; changed: boolean } };
    expect(json.data).toEqual({ kind: "api_netbeacon", auto_submit_enabled: true, changed: true });
    expect(rows[0]!.auto_submit_enabled).toBe(1);
  });

  it("admin passes the route gate but turning it ON → 403 from the handler", async () => {
    const { env, rows } = makeEnv([NETBEACON]);
    const res = (await buildRouter().fetch(
      patchReq("api_netbeacon", { auto_submit_enabled: true }, await tokenFor("admin")), env)) as Response;
    expect(res.status).toBe(403);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("Only a super admin can turn on auto-submit");
    expect(rows[0]!.auto_submit_enabled).toBe(0);
  });

  for (const role of ["admin", "super_admin"] as UserRole[]) {
    it(`${role} turns it OFF through the router (kill switch)`, async () => {
      const { env, rows } = makeEnv([{ ...NETBEACON, auto_submit_enabled: 1 }]);
      const res = (await buildRouter().fetch(
        patchReq("api_netbeacon", { auto_submit_enabled: false }, await tokenFor(role)), env)) as Response;
      expect(res.status).toBe(200);
      expect(rows[0]!.auto_submit_enabled).toBe(0);
    });
  }

  it("is not shadowed by PATCH /api/admin/takedowns/:id (that route never sees the integrations path)", async () => {
    const { env, runs } = makeEnv([{ ...NETBEACON, auto_submit_enabled: 1 }]);
    const res = (await buildRouter().fetch(
      patchReq("api_netbeacon", { auto_submit_enabled: false }, await tokenFor("admin")), env)) as Response;
    expect(res.status).toBe(200);
    expect(runs.some((r) => r.sql.includes("takedown_requests"))).toBe(false);
  });
});
