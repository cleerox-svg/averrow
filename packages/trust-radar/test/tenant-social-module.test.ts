import { describe, it, expect } from "vitest";
import {
  handleGetSocialModuleSummary,
  handleGetBrandSocialFindings,
} from "../src/handlers/tenantSocialModule";
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
  profiles?: Array<Record<string, unknown>>;
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
    if (sql.includes("FROM social_profiles")) {
      return { results: (results.profiles ?? []) as unknown as T[] };
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
  return new Request("https://averrow.com/api/orgs/42/modules/social", {
    headers: { Origin: "https://averrow.com" },
  });
}

const ENTITLED: OrgModule[] = [{
  module_key: "social",
  status: "active",
  activated_at: "2026-05-07T00:00:00Z",
  suspended_at: null,
  trial_ends_at: null,
  config_json: null,
}];

describe("handleGetSocialModuleSummary", () => {
  it("403s a member trying to read a different org", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetSocialModuleSummary(makeRequest(), env, "42", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("400s a non-numeric orgId", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetSocialModuleSummary(makeRequest(), env, "x", SUPER_ADMIN);
    expect(res.status).toBe(400);
  });

  it("403s when the org doesn't have social entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleGetSocialModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(403);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe("MODULE_NOT_ENTITLED");
  });

  it("super_admin bypasses the entitlement check", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      brandSummaries: [],
    }));
    const res = await handleGetSocialModuleSummary(makeRequest(), env, "42", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });

  it("rolls up classification + severity counts across brands", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandSummaries: [
        {
          brand_id: "b1", brand_name: "Acme", canonical_domain: "acme.com",
          profiles_total: 12, profiles_official: 2, profiles_legitimate: 3,
          profiles_suspicious: 4, profiles_impersonation: 2, profiles_parked: 1,
          profiles_high_critical: 5,
        },
        {
          brand_id: "b2", brand_name: "Beta", canonical_domain: "beta.io",
          profiles_total: 8, profiles_official: 1, profiles_legitimate: 2,
          profiles_suspicious: 3, profiles_impersonation: 1, profiles_parked: 1,
          profiles_high_critical: 2,
        },
      ],
    }));
    const res = await handleGetSocialModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: { brands: unknown[]; totals: Record<string, number> };
    };
    expect(body.data.brands).toHaveLength(2);
    expect(body.data.totals.profiles_total).toBe(20);
    expect(body.data.totals.profiles_impersonation).toBe(3);
    expect(body.data.totals.profiles_suspicious).toBe(7);
    expect(body.data.totals.profiles_high_critical).toBe(7);
  });
});

describe("handleGetBrandSocialFindings", () => {
  it("403s a member reading another org's brand", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetBrandSocialFindings(makeRequest(), env, "42", "b1", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("403s when the org doesn't have social entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleGetBrandSocialFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(403);
  });

  it("404s when the brand isn't bound to the caller's org", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: null,
    }));
    const res = await handleGetBrandSocialFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(404);
  });

  it("returns profile rows for an entitled, owned brand", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: { id: "b1" },
      profiles: [
        {
          id: "sp1", brand_id: "b1", platform: "twitter", handle: "fakeacme",
          profile_url: "https://twitter.com/fakeacme",
          display_name: "Acme Support",
          bio: "We help you", avatar_url: null,
          followers_count: 1234, verified: 0,
          classification: "impersonation", classified_by: "ai",
          classification_confidence: 0.85,
          classification_reason: "Display name impersonates Acme",
          ai_assessment: null,
          impersonation_score: 0.85,
          impersonation_signals: null,
          severity: "HIGH",
          status: "active",
          created_at: "2026-05-01",
        },
      ],
    }));
    const res = await handleGetBrandSocialFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { profiles: unknown[] } };
    expect(body.data.profiles).toHaveLength(1);
  });

  it("super_admin bypasses entitlement and org-membership", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      brandRow: { id: "b1" },
      profiles: [],
    }));
    const res = await handleGetBrandSocialFindings(makeRequest(), env, "42", "b1", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });
});
