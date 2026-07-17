import { describe, it, expect } from "vitest";
import {
  handleGetAppStoreModuleSummary,
  handleGetBrandAppStoreFindings,
} from "../src/handlers/tenantAppStoreModule";
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
  listings?: Array<Record<string, unknown>>;
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
    if (sql.includes("FROM app_store_listings")) {
      return { results: (results.listings ?? []) as unknown as T[] };
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
  return new Request("https://averrow.com/api/orgs/42/modules/app-store", {
    headers: { Origin: "https://averrow.com" },
  });
}

const ENTITLED: OrgModule[] = [{
  module_key: "app_store",
  status: "active",
  activated_at: "2026-05-07T00:00:00Z",
  suspended_at: null,
  trial_ends_at: null,
  config_json: null,
}];

describe("handleGetAppStoreModuleSummary", () => {
  it("403s a member trying to read a different org", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetAppStoreModuleSummary(makeRequest(), env, "42", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("400s a non-numeric orgId", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetAppStoreModuleSummary(makeRequest(), env, "x", SUPER_ADMIN);
    expect(res.status).toBe(400);
  });

  it("403s when the org doesn't have app_store entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleGetAppStoreModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(403);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe("MODULE_NOT_ENTITLED");
  });

  it("super_admin bypasses the entitlement check", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      brandSummaries: [],
    }));
    const res = await handleGetAppStoreModuleSummary(makeRequest(), env, "42", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });

  it("rolls up classification + severity counts across brands", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandSummaries: [
        {
          brand_id: "b1", brand_name: "Acme", canonical_domain: "acme.com",
          apps_total: 8, apps_official: 2, apps_legitimate: 1,
          apps_suspicious: 3, apps_impersonation: 2, apps_high_critical: 4,
          stores_covered: 3,
        },
        {
          brand_id: "b2", brand_name: "Beta", canonical_domain: "beta.io",
          apps_total: 5, apps_official: 1, apps_legitimate: 2,
          apps_suspicious: 1, apps_impersonation: 1, apps_high_critical: 2,
          stores_covered: 2,
        },
      ],
    }));
    const res = await handleGetAppStoreModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { brands: unknown[]; totals: Record<string, number> };
    };
    expect(body.data.brands).toHaveLength(2);
    expect(body.data.totals.apps_total).toBe(13);
    expect(body.data.totals.apps_impersonation).toBe(3);
    expect(body.data.totals.apps_high_critical).toBe(6);
  });
});

describe("handleGetBrandAppStoreFindings", () => {
  it("403s a member reading another org's brand", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetBrandAppStoreFindings(makeRequest(), env, "42", "b1", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("403s when the org doesn't have app_store entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleGetBrandAppStoreFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(403);
  });

  it("404s when the brand isn't bound to the caller's org", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: null,
    }));
    const res = await handleGetBrandAppStoreFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(404);
  });

  it("returns listing rows for an entitled, owned brand", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: { id: "b1" },
      listings: [
        {
          id: "al1", brand_id: "b1", store: "google_play",
          app_id: "com.fakeacme", bundle_id: null,
          app_name: "Acme - Phishing",
          developer_name: "Random Dev",
          developer_id: null, app_url: "https://play.google.com/store/apps/details?id=com.fakeacme",
          icon_url: null, rating: 2.4, rating_count: 12, release_date: "2026-04-01",
          classification: "impersonation", classified_by: "ai",
          classification_confidence: 0.9, classification_reason: null,
          ai_assessment: null, impersonation_score: 0.9,
          severity: "HIGH", status: "active",
          created_at: "2026-05-01",
        },
      ],
    }));
    const res = await handleGetBrandAppStoreFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { listings: unknown[] } };
    expect(body.data.listings).toHaveLength(1);
  });

  it("super_admin bypasses entitlement and org-membership", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      brandRow: { id: "b1" },
      listings: [],
    }));
    const res = await handleGetBrandAppStoreFindings(makeRequest(), env, "42", "b1", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });
});
