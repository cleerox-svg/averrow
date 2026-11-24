// PATCH /api/admin/takedowns/integrations/:kind — the operator auto-submit
// gate (takedown_providers.auto_submit_enabled) for the API integrations.
//
// Handler-level: validation (unknown kind 404, email kind 400, body 400),
// missing provider row 409, the UPDATE + audit row, and the response shape
// (the same IntegrationHealth item the GET returns).
// Router-level: requireAdmin — admin / super_admin reach the handler,
// analyst (who can VIEW the integrations) and other staff get 403. The
// guard runs for real against a signed JWT.

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

interface ProviderRow {
  id: number; provider_name: string; provider_type: string | null;
  abuse_email: string | null; abuse_url: string | null; abuse_api_url: string | null;
  abuse_api_type: string; auto_submit_enabled: number;
}

interface Captured { sql: string; binds: unknown[] }

function makeEnv(providers: ProviderRow[], vars: Record<string, string> = {}) {
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
          let changes = 0;
          for (const r of rows) {
            if (r.abuse_api_type === binds[1]) { r.auto_submit_enabled = binds[0] as number; changes++; }
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

async function call(env: Env, kind: string, body: unknown) {
  const res = await handleAdminUpdateTakedownIntegration(patchReq(kind, body), env, kind, ADMIN);
  const json = await res.json() as { success: boolean; data?: Record<string, unknown>; error?: string };
  return { status: res.status, json };
}

describe("handleAdminUpdateTakedownIntegration", () => {
  it("turns auto-submit on, writes one audit row, and returns the updated integration item", async () => {
    const { env, runs, audits, rows } = makeEnv([NETBEACON], { NETBEACON_API_KEY: "k", TAKEDOWN_SEND_MODE: "live" });
    const { status, json } = await call(env, "api_netbeacon", { auto_submit_enabled: true });
    expect(status).toBe(200);
    expect(json.success).toBe(true);

    const upd = runs.filter((r) => r.sql.includes("UPDATE takedown_providers"));
    expect(upd).toHaveLength(1);
    expect(upd[0]!.binds).toEqual([1, "netbeacon"]);
    expect(rows[0]!.auto_submit_enabled).toBe(1);

    expect(audits).toHaveLength(1);
    const b = audits[0]!.binds;
    // (id, user_id, action, resource_type, resource_id, details, ip, ua, outcome)
    expect(b[1]).toBe("u-admin");
    expect(b[2]).toBe("takedown_integration_auto_submit");
    expect(b[3]).toBe("takedown_integration");
    expect(b[4]).toBe("api_netbeacon");
    expect(JSON.parse(b[5] as string)).toEqual({
      kind: "api_netbeacon", abuse_api_type: "netbeacon", from: false, to: true,
    });

    const item = json.data!;
    expect(item.kind).toBe("api_netbeacon");
    expect(item.auto_submit_enabled).toBe(true);
    expect(item.status).toBe("live");
    const config = item.config as Record<string, unknown>;
    expect(config.auto_submit_editable).toBe(true);
    expect(config.credential_secrets).toEqual(["NETBEACON_API_KEY"]);
    expect((config.provider as Record<string, unknown>).auto_submit_enabled).toBe(true);
    expect((config.provider as Record<string, unknown>).id).toBe(7);
  });

  it("turns auto-submit off and records from/to", async () => {
    const { env, audits } = makeEnv([{ ...NETBEACON, auto_submit_enabled: 1 }], { NETBEACON_API_KEY: "k" });
    const { status, json } = await call(env, "api_netbeacon", { auto_submit_enabled: false });
    expect(status).toBe(200);
    expect(json.data!.auto_submit_enabled).toBe(false);
    expect(json.data!.status).toBe("disabled");
    expect(JSON.parse(audits[0]!.binds[5] as string)).toMatchObject({ from: true, to: false });
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

  for (const role of ["admin", "super_admin"] as UserRole[]) {
    it(`${role} reaches the handler and the gate flips`, async () => {
      const { env, rows } = makeEnv([NETBEACON]);
      const res = (await buildRouter().fetch(
        patchReq("api_netbeacon", { auto_submit_enabled: true }, await tokenFor(role)), env)) as Response;
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { kind: string } };
      expect(json.data.kind).toBe("api_netbeacon");
      expect(rows[0]!.auto_submit_enabled).toBe(1);
    });
  }

  it("is not shadowed by PATCH /api/admin/takedowns/:id (that route never sees the integrations path)", async () => {
    const { env, runs } = makeEnv([NETBEACON]);
    const res = (await buildRouter().fetch(
      patchReq("api_netbeacon", { auto_submit_enabled: true }, await tokenFor("admin")), env)) as Response;
    expect(res.status).toBe(200);
    expect(runs.some((r) => r.sql.includes("takedown_requests"))).toBe(false);
  });
});
