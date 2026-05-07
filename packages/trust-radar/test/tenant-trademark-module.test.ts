import { describe, it, expect } from "vitest";
import {
  handleGetTrademarkModuleSummary,
  handleGetBrandTrademarkFindings,
} from "../src/handlers/tenantTrademarkModule";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";
import type { OrgModule } from "../src/lib/entitlements";

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

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

interface DbResults {
  enabledModules: OrgModule[];
  brandSummaries?: Array<Record<string, unknown>>;
  assets?: Array<Record<string, unknown>>;
  findings?: Array<Record<string, unknown>>;
  brandRow?: { id: string } | null;
}

function makeDb(results: DbResults) {
  function allFor<T>(sql: string): { results: T[] } {
    if (sql.includes("FROM org_modules")) {
      return { results: results.enabledModules as unknown as T[] };
    }
    if (sql.includes("JOIN org_brands ob ON ob.brand_id = b.id") &&
        sql.includes("ob.is_primary DESC")) {
      return { results: (results.brandSummaries ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM trademark_assets")) {
      return { results: (results.assets ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM trademark_findings")) {
      return { results: (results.findings ?? []) as unknown as T[] };
    }
    return { results: [] };
  }

  function prepare(sql: string) {
    return {
      bind: () => ({
        all: async <T>() => allFor<T>(sql),
        first: async <T>() => {
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
  return new Request("https://averrow.com/api/orgs/42/modules/trademark", {
    headers: { Origin: "https://averrow.com" },
  });
}

const ENTITLED: OrgModule[] = [{
  module_key: "trademark",
  status: "active",
  activated_at: "2026-05-07T00:00:00Z",
  suspended_at: null,
  trial_ends_at: null,
  config_json: null,
}];

describe("handleGetTrademarkModuleSummary", () => {
  it("403s a member trying to read a different org", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetTrademarkModuleSummary(makeRequest(), env, "42", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("400s a non-numeric orgId", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetTrademarkModuleSummary(makeRequest(), env, "x", SUPER_ADMIN);
    expect(res.status).toBe(400);
  });

  it("403s when the org doesn't have trademark entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleGetTrademarkModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(403);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe("MODULE_NOT_ENTITLED");
  });

  it("super_admin bypasses the entitlement check", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      brandSummaries: [],
    }));
    const res = await handleGetTrademarkModuleSummary(makeRequest(), env, "42", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });

  it("rolls up classification + asset counts across brands", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandSummaries: [
        {
          brand_id: "b1", brand_name: "Acme", canonical_domain: "acme.com",
          assets_active: 3,
          findings_total: 8, findings_confirmed: 3, findings_likely: 2,
          findings_unknown: 3, findings_false_positive: 1, findings_high_critical: 4,
          contexts_covered: 3,
        },
        {
          brand_id: "b2", brand_name: "Beta", canonical_domain: "beta.io",
          assets_active: 1,
          findings_total: 4, findings_confirmed: 1, findings_likely: 1,
          findings_unknown: 2, findings_false_positive: 0, findings_high_critical: 1,
          contexts_covered: 2,
        },
      ],
    }));
    const res = await handleGetTrademarkModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { brands: unknown[]; totals: Record<string, number> };
    };
    expect(body.data.brands).toHaveLength(2);
    expect(body.data.totals.assets_active).toBe(4);
    expect(body.data.totals.findings_total).toBe(12);
    expect(body.data.totals.findings_confirmed).toBe(4);
    expect(body.data.totals.findings_high_critical).toBe(5);
  });
});

describe("handleGetBrandTrademarkFindings", () => {
  it("403s a member reading another org's brand", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetBrandTrademarkFindings(makeRequest(), env, "42", "b1", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("403s when the org doesn't have trademark entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleGetBrandTrademarkFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(403);
  });

  it("404s when the brand isn't bound to the caller's org", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: null,
    }));
    const res = await handleGetBrandTrademarkFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(404);
  });

  it("returns assets + findings for an entitled, owned brand", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: { id: "b1" },
      assets: [
        {
          id: "a1", brand_id: "b1", asset_type: "logo",
          asset_name: "Acme primary", asset_url: "https://acme.com/logo.png",
          asset_hash: "abc", phash: "ffaa00bb11223344",
          registration_country: "US", registration_number: "TM-12345",
          registration_date: "2020-01-01",
          status: "active", created_at: "2026-01-01",
        },
      ],
      findings: [
        {
          id: "f1", brand_id: "b1", asset_id: "a1",
          found_url: "https://fake.example/page",
          found_context: "website",
          found_image_url: "https://fake.example/logo.png",
          found_at: "2026-05-01",
          found_phash: "ffaa00bb11223345", match_distance: 1,
          match_confidence: 0.98,
          classification: "confirmed", classified_by: "ai",
          classification_confidence: 0.95, classification_reason: null,
          ai_assessment: null, ai_action: "escalate",
          severity: "HIGH", status: "active",
          first_seen: "2026-05-01", last_seen: "2026-05-01",
        },
      ],
    }));
    const res = await handleGetBrandTrademarkFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { assets: unknown[]; findings: unknown[] };
    };
    expect(body.data.assets).toHaveLength(1);
    expect(body.data.findings).toHaveLength(1);
  });

  it("super_admin bypasses entitlement and org-membership", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      brandRow: { id: "b1" },
      assets: [],
      findings: [],
    }));
    const res = await handleGetBrandTrademarkFindings(makeRequest(), env, "42", "b1", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });
});
