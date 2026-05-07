import { describe, it, expect, beforeEach } from "vitest";
import {
  handleListTenantModules,
  handleAdminModuleAction,
} from "../src/handlers/tenantModules";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";
import type { OrgModule } from "../src/lib/entitlements";
import type { UsageMetricDef, UsageRollupRow } from "../src/lib/module-usage";

// ── Auth contexts ────────────────────────────────────────────────

const SUPER_ADMIN: AuthContext = {
  userId: "u-super",
  email: "super@averrow.local",
  role: "super_admin",
  orgId: null,
  orgRole: null,
  embeddedScope: undefined,
};

const ORG_42_MEMBER: AuthContext = {
  userId: "u-tenant",
  email: "tenant@example.com",
  role: "client",
  orgId: "42",
  orgRole: "analyst",
  embeddedScope: undefined,
};

const OTHER_ORG_MEMBER: AuthContext = {
  userId: "u-other",
  email: "other@example.com",
  role: "client",
  orgId: "99",
  orgRole: "analyst",
  embeddedScope: undefined,
};

// ── Mocks ────────────────────────────────────────────────────────

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface DbAllResults {
  enabledModules: OrgModule[];
  metricDefs: UsageMetricDef[];
  usageRows: UsageRollupRow[];
}

interface CapturedRun {
  sql: string;
  binds: unknown[];
}

function makeDb(results: DbAllResults) {
  const runs: CapturedRun[] = [];

  function allFor<T>(sql: string): { results: T[] } {
    if (sql.includes("FROM org_modules")) {
      return { results: results.enabledModules as unknown as T[] };
    }
    if (sql.includes("FROM module_metric_definitions")) {
      return { results: results.metricDefs as unknown as T[] };
    }
    if (sql.includes("FROM org_usage_daily")) {
      return { results: results.usageRows as unknown as T[] };
    }
    return { results: [] };
  }

  function prepare(sql: string) {
    return {
      // Bound path — tenantModules + entitlements + module-usage variants
      bind: (...binds: unknown[]) => ({
        run: async () => {
          runs.push({ sql, binds });
          return { success: true };
        },
        all: async <T>() => allFor<T>(sql),
        // first() is used by the takedown_authorizations lookup added
        // when the modules endpoint started surfacing the authorization
        // summary. Always returns null in this mock — the modules
        // endpoint tolerates a null authorization (renders signed=false).
        first: async <T>() => null as T | null,
      }),
      all: async <T>() => allFor<T>(sql),
    };
  }
  return { prepare, runs };
}

function makeEnv(kv: MockKV, db: ReturnType<typeof makeDb>): Env {
  return { CACHE: kv, DB: db } as unknown as Env;
}

function makeRequest(method: string = "GET", body?: unknown): Request {
  return new Request("https://averrow.com/api/orgs/42/modules", {
    method,
    headers: { Origin: "https://averrow.com", "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : null,
  });
}

// ─── Tests: handleListTenantModules ──────────────────────────────

describe("handleListTenantModules", () => {
  let kv: MockKV;
  let db: ReturnType<typeof makeDb>;
  let env: Env;

  beforeEach(() => {
    kv = new MockKV();
    db = makeDb({ enabledModules: [], metricDefs: [], usageRows: [] });
    env = makeEnv(kv, db);
  });

  it("403s a member trying to read a different org's modules", async () => {
    const res = await handleListTenantModules(makeRequest(), env, "42", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("400s an invalid orgId param", async () => {
    const res = await handleListTenantModules(makeRequest(), env, "not-a-number", SUPER_ADMIN);
    expect(res.status).toBe(400);
  });

  it("returns one row per canonical module — entitled and not_entitled mixed", async () => {
    db = makeDb({
      enabledModules: [
        {
          module_key: "domain",
          status: "active",
          activated_at: "2026-01-01T00:00:00Z",
          suspended_at: null,
          trial_ends_at: null,
          config_json: null,
        },
      ],
      metricDefs: [
        { module_key: "domain", metric_key: "lookalikes_detected", label: "Lookalikes", unit: "count", is_billable: 0, description: null },
        { module_key: "social", metric_key: "impersonators_detected", label: "Impersonators", unit: "count", is_billable: 0, description: null },
      ],
      usageRows: [
        { module_key: "domain", metric_key: "lookalikes_detected", day: "2026-05-01", value: 7 },
      ],
    });
    env = makeEnv(kv, db);

    const res = await handleListTenantModules(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: {
        modules: Array<{ module_key: string; status: string; metrics: Array<{ metric_key: string; value_this_month: number }> }>;
        takedown_authorization: { signed: boolean };
      };
    };
    expect(body.success).toBe(true);
    // 7 modules in total — one per MODULE_KEYS row
    expect(body.data.modules).toHaveLength(7);
    const domain = body.data.modules.find((m) => m.module_key === "domain");
    expect(domain?.status).toBe("active");
    expect(domain?.metrics[0]?.value_this_month).toBe(7);
    const social = body.data.modules.find((m) => m.module_key === "social");
    expect(social?.status).toBe("not_entitled");
    expect(social?.metrics[0]?.value_this_month).toBe(0);
    // No authorization in mock → signed:false summary lights up the
    // tenant client's "sign authorization" CTA on the takedowns page.
    expect(body.data.takedown_authorization.signed).toBe(false);
  });

  it("super_admin can read any org's modules", async () => {
    const res = await handleListTenantModules(makeRequest(), env, "42", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });
});

// ─── Tests: handleAdminModuleAction ──────────────────────────────

describe("handleAdminModuleAction", () => {
  let kv: MockKV;
  let db: ReturnType<typeof makeDb>;
  let env: Env;

  beforeEach(() => {
    kv = new MockKV();
    db = makeDb({ enabledModules: [], metricDefs: [], usageRows: [] });
    env = makeEnv(kv, db);
  });

  it("403s a non-super-admin caller", async () => {
    const res = await handleAdminModuleAction(
      makeRequest("POST", { module_key: "domain", action: "activate" }),
      env, "42", ORG_42_MEMBER,
    );
    expect(res.status).toBe(403);
  });

  it("400s an unknown module_key", async () => {
    const res = await handleAdminModuleAction(
      makeRequest("POST", { module_key: "not_a_real_module", action: "activate" }),
      env, "42", SUPER_ADMIN,
    );
    expect(res.status).toBe(400);
  });

  it("400s when action is neither activate nor suspend", async () => {
    const res = await handleAdminModuleAction(
      makeRequest("POST", { module_key: "domain", action: "wat" }),
      env, "42", SUPER_ADMIN,
    );
    expect(res.status).toBe(400);
  });

  it("activates a module and runs the UPSERT", async () => {
    const res = await handleAdminModuleAction(
      makeRequest("POST", { module_key: "domain", action: "activate" }),
      env, "42", SUPER_ADMIN,
    );
    expect(res.status).toBe(200);
    expect(db.runs.some((r) => r.sql.includes("INSERT INTO org_modules"))).toBe(true);
  });

  it("suspends a module via UPDATE", async () => {
    const res = await handleAdminModuleAction(
      makeRequest("POST", { module_key: "domain", action: "suspend" }),
      env, "42", SUPER_ADMIN,
    );
    expect(res.status).toBe(200);
    expect(db.runs.some((r) => r.sql.includes("UPDATE org_modules"))).toBe(true);
  });
});
