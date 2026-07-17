import { describe, it, expect, beforeEach } from "vitest";
import {
  handleGetDomainModuleSummary,
  handleGetBrandDomainFindings,
} from "../src/handlers/tenantDomainModule";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";
import type { OrgModule } from "../src/lib/entitlements";

// ── Auth contexts ──────────────────────────────────────────────

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

// ── Mocks ──────────────────────────────────────────────────────

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
  enabledModules: OrgModule[];   // for entitlements lookup
  brandSummaries?: Array<Record<string, unknown>>;
  lookalikes?: Array<Record<string, unknown>>;
  certs?: Array<Record<string, unknown>>;
  brandRow?: { id: string } | null;
}

function makeDb(results: DbAllResults) {
  function allFor<T>(sql: string): { results: T[] } {
    if (sql.includes("FROM org_modules")) {
      return { results: results.enabledModules as unknown as T[] };
    }
    if (sql.includes("JOIN org_brands ob ON ob.brand_id = b.id") &&
        sql.includes("ob.is_primary DESC")) {
      // Domain module summary aggregate query
      return { results: (results.brandSummaries ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM lookalike_domains")) {
      return { results: (results.lookalikes ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM ct_certificates")) {
      return { results: (results.certs ?? []) as unknown as T[] };
    }
    return { results: [] };
  }

  function prepare(sql: string) {
    return {
      bind: () => ({
        all: async <T>() => allFor<T>(sql),
        first: async <T>() => {
          // Brand-ownership lookup for the drill-down endpoint
          if (sql.includes("FROM brands b") && sql.includes("JOIN org_brands ob")) {
            return (results.brandRow ?? null) as T | null;
          }
          if (sql.includes("FROM brands WHERE id =")) {
            return (results.brandRow ?? null) as T | null;
          }
          return null;
        },
      }),
    };
  }
  return { prepare };
}

function makeEnv(kv: MockKV, db: ReturnType<typeof makeDb>): Env {
  return { CACHE: kv, DB: db } as unknown as Env;
}

function makeRequest(): Request {
  return new Request("https://averrow.com/api/orgs/42/modules/domain", {
    headers: { Origin: "https://averrow.com" },
  });
}

const ENTITLED: OrgModule[] = [{
  module_key: "domain",
  status: "active",
  activated_at: "2026-05-07T00:00:00Z",
  suspended_at: null,
  trial_ends_at: null,
  config_json: null,
}];

// ─── Tests: handleGetDomainModuleSummary ──────────────────────

describe("handleGetDomainModuleSummary", () => {
  it("403s a member trying to read a different org's domain module", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetDomainModuleSummary(makeRequest(), env, "42", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("400s a non-numeric orgId", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetDomainModuleSummary(makeRequest(), env, "not-a-number", SUPER_ADMIN);
    expect(res.status).toBe(400);
  });

  it("403s when the org doesn't have the domain module entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleGetDomainModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(403);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe("MODULE_NOT_ENTITLED");
  });

  it("super_admin bypasses the entitlement check", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      brandSummaries: [],
    }));
    const res = await handleGetDomainModuleSummary(makeRequest(), env, "42", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });

  it("rolls up totals across brands", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandSummaries: [
        {
          brand_id: "b1", brand_name: "Acme", canonical_domain: "acme.com",
          lookalikes_total: 10, lookalikes_registered: 3, lookalikes_critical: 1, lookalikes_high: 2, lookalikes_taken_down: 0,
          certs_total: 5, certs_suspicious: 1, certs_new: 1, certs_malicious: 0,
        },
        {
          brand_id: "b2", brand_name: "Beta", canonical_domain: "beta.io",
          lookalikes_total: 20, lookalikes_registered: 7, lookalikes_critical: 0, lookalikes_high: 4, lookalikes_taken_down: 1,
          certs_total: 8, certs_suspicious: 2, certs_new: 0, certs_malicious: 1,
        },
      ],
    }));
    const res = await handleGetDomainModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: { brands: unknown[]; totals: Record<string, number> };
    };
    expect(body.data.brands).toHaveLength(2);
    expect(body.data.totals.lookalikes_total).toBe(30);
    expect(body.data.totals.lookalikes_registered).toBe(10);
    expect(body.data.totals.lookalikes_critical).toBe(1);
    expect(body.data.totals.lookalikes_high).toBe(6);
    expect(body.data.totals.certs_suspicious).toBe(3);
    expect(body.data.totals.certs_malicious).toBe(1);
  });
});

// ─── Tests: handleGetBrandDomainFindings ──────────────────────

describe("handleGetBrandDomainFindings", () => {
  it("403s a member reading another org's brand findings", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetBrandDomainFindings(makeRequest(), env, "42", "b1", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("403s when the org doesn't have the domain module entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleGetBrandDomainFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(403);
  });

  it("404s when the brand isn't bound to the caller's org", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: null,
    }));
    const res = await handleGetBrandDomainFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(404);
  });

  it("returns lookalike + cert rows for an entitled, owned brand", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: { id: "b1" },
      lookalikes: [
        {
          id: "ld1", brand_id: "b1", domain: "acm3.com",
          permutation_type: "homoglyph", registered: 1,
          resolves_to: "1.2.3.4", has_mx: 1, has_web: 1,
          first_seen: "2026-05-01", last_checked: "2026-05-07",
          threat_level: "HIGH", ai_assessment: null, status: "monitoring",
          created_at: "2026-05-01",
        },
      ],
      certs: [
        {
          id: "ct1", brand_id: "b1", domain: "acm3.com",
          issuer: "Let's Encrypt", suspicious: 1, ai_assessment: null,
          status: "new", created_at: "2026-05-07",
        },
      ],
    }));
    const res = await handleGetBrandDomainFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { lookalikes: unknown[]; certs: unknown[] };
    };
    expect(body.data.lookalikes).toHaveLength(1);
    expect(body.data.certs).toHaveLength(1);
  });

  it("super_admin bypasses both entitlement and org-membership", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      brandRow: { id: "b1" },
      lookalikes: [],
      certs: [],
    }));
    const res = await handleGetBrandDomainFindings(makeRequest(), env, "42", "b1", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });
});
