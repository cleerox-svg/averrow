import { describe, it, expect } from "vitest";
import {
  handleGetThreatActorModuleSummary,
  handleGetThreatActorDetail,
} from "../src/handlers/tenantThreatActorModule";
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
  actorSummaries?: Array<Record<string, unknown>>;
  actorProfile?: Record<string, unknown> | null;
  threats?: Array<Record<string, unknown>>;
  infrastructure?: Array<Record<string, unknown>>;
  targetedBrands?: Array<Record<string, unknown>>;
}

function makeDb(results: DbResults) {
  function allFor<T>(sql: string): { results: T[] } {
    if (sql.includes("FROM org_modules")) {
      return { results: results.enabledModules as unknown as T[] };
    }
    if (sql.includes("WITH org_actors AS")) {
      return { results: (results.actorSummaries ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM threat_attributions attr") && sql.includes("JOIN threats t")) {
      return { results: (results.threats ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM threat_actor_infrastructure")) {
      return { results: (results.infrastructure ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM threat_actor_targets tat") && sql.includes("JOIN brands b")) {
      return { results: (results.targetedBrands ?? []) as unknown as T[] };
    }
    return { results: [] };
  }

  function prepare(sql: string) {
    return {
      bind: () => ({
        all: async <T>() => allFor<T>(sql),
        first: async <T>() => {
          if (sql.includes("FROM threat_actors") && sql.includes("WHERE id = ?")) {
            return (results.actorProfile ?? null) as T | null;
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
  return new Request("https://averrow.com/api/orgs/42/modules/threat-actor", {
    headers: { Origin: "https://averrow.com" },
  });
}

const ENTITLED: OrgModule[] = [{
  module_key: "threat_actor",
  status: "active",
  activated_at: "2026-05-07T00:00:00Z",
  suspended_at: null,
  trial_ends_at: null,
  config_json: null,
}];

describe("handleGetThreatActorModuleSummary", () => {
  it("403s a member trying to read a different org", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetThreatActorModuleSummary(makeRequest(), env, "42", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("400s a non-numeric orgId", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetThreatActorModuleSummary(makeRequest(), env, "x", SUPER_ADMIN);
    expect(res.status).toBe(400);
  });

  it("403s when the org doesn't have threat_actor entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleGetThreatActorModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(403);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe("MODULE_NOT_ENTITLED");
  });

  it("super_admin bypasses the entitlement check", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      actorSummaries: [],
    }));
    const res = await handleGetThreatActorModuleSummary(makeRequest(), env, "42", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });

  it("computes totals: actor_count, threat_count, countries, high_confidence", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      actorSummaries: [
        {
          actor_id: "a1", name: "APT28", aliases: '["Fancy Bear"]',
          affiliation: "GRU", country_code: "RU", capability: "espionage",
          status: "active", attribution_confidence: "confirmed",
          threat_count_for_org: 12, brands_targeted_for_org: 2,
          last_seen_for_org: "2026-05-01",
        },
        {
          actor_id: "a2", name: "Lazarus", aliases: null,
          affiliation: "DPRK", country_code: "KP", capability: "financial",
          status: "active", attribution_confidence: "high",
          threat_count_for_org: 4, brands_targeted_for_org: 1,
          last_seen_for_org: "2026-04-20",
        },
        {
          actor_id: "a3", name: "Charming Kitten", aliases: null,
          affiliation: "MOIS", country_code: "IR", capability: "espionage",
          status: "dormant", attribution_confidence: "medium",
          threat_count_for_org: 1, brands_targeted_for_org: 1,
          last_seen_for_org: null,
        },
      ],
    }));
    const res = await handleGetThreatActorModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { actors: unknown[]; totals: Record<string, number> };
    };
    expect(body.data.actors).toHaveLength(3);
    expect(body.data.totals.actor_count).toBe(3);
    expect(body.data.totals.threat_count).toBe(17);
    expect(body.data.totals.countries_count).toBe(3);   // RU, KP, IR
    expect(body.data.totals.high_confidence_actors).toBe(2); // confirmed + high
  });
});

describe("handleGetThreatActorDetail", () => {
  it("403s a member from another org", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetThreatActorDetail(makeRequest(), env, "42", "a1", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("403s when the org doesn't have threat_actor entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleGetThreatActorDetail(makeRequest(), env, "42", "a1", ORG_42_MEMBER);
    expect(res.status).toBe(403);
  });

  it("404s when the actor doesn't exist", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      actorProfile: null,
    }));
    const res = await handleGetThreatActorDetail(makeRequest(), env, "42", "missing", ORG_42_MEMBER);
    expect(res.status).toBe(404);
  });

  it("returns actor profile + tenant-scoped threats + infrastructure + targeted brands", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      actorProfile: {
        id: "a1", name: "APT28", aliases: '["Fancy Bear"]',
        affiliation: "GRU", country_code: "RU", capability: "espionage",
        primary_ttps: '["spear-phishing","credential-harvesting"]',
        description: "Russian state-sponsored actor.",
        first_seen: "2018-01-01", last_seen: "2026-05-01",
        status: "active", attribution_confidence: "confirmed",
      },
      threats: [
        {
          id: "t1", threat_type: "phishing",
          malicious_url: "https://fake.example", malicious_domain: "fake.example",
          target_brand_id: "b1", brand_name: "Acme",
          country_code: "RU", severity: "high", status: "active",
          first_seen: "2026-05-01", last_seen: "2026-05-01",
          attribution_confidence: "high", attribution_source: "otx",
          observed_at: "2026-05-01",
        },
      ],
      infrastructure: [
        { id: "i1", asn: "AS49505", ip_range: "203.0.113.0/24", domain: null,
          hosting_provider: "Selectel", country_code: "RU",
          confidence: "high", first_observed: "2024-01-01", last_observed: "2026-05-01" },
      ],
      targetedBrands: [
        { brand_id: "b1", brand_name: "Acme", canonical_domain: "acme.com",
          first_targeted: "2024-01-01", last_targeted: "2026-05-01" },
      ],
    }));
    const res = await handleGetThreatActorDetail(makeRequest(), env, "42", "a1", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        actor: { id: string; name: string };
        threats: unknown[];
        infrastructure: unknown[];
        targeted_brands: unknown[];
      };
    };
    expect(body.data.actor.id).toBe("a1");
    expect(body.data.actor.name).toBe("APT28");
    expect(body.data.threats).toHaveLength(1);
    expect(body.data.infrastructure).toHaveLength(1);
    expect(body.data.targeted_brands).toHaveLength(1);
  });

  it("super_admin bypasses entitlement when reading actor detail", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      actorProfile: {
        id: "a1", name: "APT28", aliases: null,
        affiliation: null, country_code: null, capability: null,
        primary_ttps: null, description: null,
        first_seen: null, last_seen: null,
        status: "active", attribution_confidence: "medium",
      },
      threats: [], infrastructure: [], targetedBrands: [],
    }));
    const res = await handleGetThreatActorDetail(makeRequest(), env, "42", "a1", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });
});
