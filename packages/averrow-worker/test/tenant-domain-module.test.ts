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
  // Every prepared statement's SQL, in issue order, so tests can assert
  // the shape of the query itself (which columns the tenant surface is
  // allowed to select) and not just the mocked rows echoed back.
  const capturedSql: string[] = [];
  // Every bound parameter list, so tests can assert the org/brand
  // scoping predicates are bound rather than interpolated.
  const capturedBinds: unknown[][] = [];

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
    capturedSql.push(sql);
    return {
      bind: (...args: unknown[]) => (capturedBinds.push(args), {
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
  return { prepare, capturedSql, capturedBinds };
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

// ─── Tests: page-analysis evidence on the tenant payload ───────
//
// Lane 3 Phase 3 step 15. The per-brand findings SELECT is an explicit
// column list, so a new column is invisible to the tenant surface until
// it is named there. These lock the exposed set — and, just as
// importantly, the one field that must NOT be exposed.

/** Every page_* column the tenant findings SELECT is required to carry. */
const EXPOSED_PAGE_COLUMNS = [
  "page_fetched_at",
  "page_http_status",
  "page_phishing_score",
  "page_signals",
  "page_anti_bot_wall",
  "page_ai_signals",
  "page_score_delta",
  "page_generator",
  "page_exfil_sink",
  "page_exfil_sink_id",
] as const;

/** A fully-populated page-analysis row as the scorer would persist it. */
const ANALYZED_LOOKALIKE = {
  id: "ld1", brand_id: "b1", domain: "acm3.com",
  permutation_type: "homoglyph", registered: 1,
  resolves_to: "1.2.3.4", has_mx: 1, has_web: 1,
  first_seen: "2026-05-01", last_checked: "2026-05-07",
  threat_level: "HIGH", ai_assessment: null, status: "monitoring",
  created_at: "2026-05-01",
  page_fetched_at: "2026-09-20T04:00:00Z",
  page_http_status: 200,
  page_phishing_score: 75,
  page_signals: '["credential_form","offdomain_form_exfil"]',
  page_anti_bot_wall: "turnstile",
  page_ai_signals: '["covert_exfil_sink","todo_comment"]',
  page_score_delta: 20,
  page_generator: "Lovable",
  page_exfil_sink: "api.telegram.org",
  page_exfil_sink_id: "7654321:AAF",
};

describe("handleGetBrandDomainFindings — page-analysis evidence", () => {
  function findingsSql(db: ReturnType<typeof makeDb>): string {
    const sql = db.capturedSql.find(
      (s) => s.includes("FROM lookalike_domains") && s.includes("SELECT"),
    );
    expect(sql).toBeDefined();
    return sql as string;
  }

  it("selects every exposed page_* column", async () => {
    const db = makeDb({ enabledModules: ENTITLED, brandRow: { id: "b1" }, lookalikes: [] });
    await handleGetBrandDomainFindings(makeRequest(), makeEnv(new MockKV(), db), "42", "b1", ORG_42_MEMBER);
    const sql = findingsSql(db);
    for (const col of EXPOSED_PAGE_COLUMNS) {
      expect(sql, `findings SELECT is missing ${col}`).toContain(col);
    }
  });

  it("never selects page_evidence — attacker-controlled literals stay staff-only", async () => {
    const db = makeDb({ enabledModules: ENTITLED, brandRow: { id: "b1" }, lookalikes: [] });
    await handleGetBrandDomainFindings(makeRequest(), makeEnv(new MockKV(), db), "42", "b1", ORG_42_MEMBER);
    expect(findingsSql(db)).not.toContain("page_evidence");
  });

  it("keeps the widened SELECT brand-scoped and parameter-bound", async () => {
    const db = makeDb({ enabledModules: ENTITLED, brandRow: { id: "b1" }, lookalikes: [] });
    await handleGetBrandDomainFindings(makeRequest(), makeEnv(new MockKV(), db), "42", "b1", ORG_42_MEMBER);
    const sql = findingsSql(db);
    // Same predicate as before the widening: one bound brand_id, no
    // extra JOIN, so the wider column list gains no cross-org reach.
    expect(sql).toContain("WHERE brand_id = ?");
    expect(sql).not.toContain("'");
    expect(db.capturedBinds.some((b) => b[0] === "b1")).toBe(true);
  });

  it("round-trips the page-analysis fields onto the response rows", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: { id: "b1" },
      lookalikes: [ANALYZED_LOOKALIKE],
    }));
    const res = await handleGetBrandDomainFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { lookalikes: Record<string, unknown>[] } };
    const row = body.data.lookalikes[0];
    for (const col of EXPOSED_PAGE_COLUMNS) {
      expect(row).toHaveProperty(col);
    }
    expect(row.page_phishing_score).toBe(75);
    expect(row.page_score_delta).toBe(20);
    expect(row.page_anti_bot_wall).toBe("turnstile");
    expect(JSON.parse(row.page_ai_signals as string)).toEqual(
      ["covert_exfil_sink", "todo_comment"],
    );
    expect(row.page_exfil_sink).toBe("api.telegram.org");
    // Surfacing only: Phase 3 promotes nothing. The shadow delta is
    // reported alongside the score, never folded into it.
    expect(row.page_phishing_score).not.toBe(95);
  });

  it("tolerates a never-scanned row — every page_* field null", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: { id: "b1" },
      lookalikes: [{
        ...ANALYZED_LOOKALIKE,
        ...Object.fromEntries(EXPOSED_PAGE_COLUMNS.map((c) => [c, null])),
      }],
    }));
    const res = await handleGetBrandDomainFindings(makeRequest(), env, "42", "b1", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { lookalikes: Record<string, unknown>[] } };
    const row = body.data.lookalikes[0];
    // `page_fetched_at === null` is the "never scanned" marker the SPA
    // needs to distinguish from "checked and clean" (spec §3.5).
    expect(row.page_fetched_at).toBeNull();
    expect(row.page_phishing_score).toBeNull();
    expect(row.domain).toBe("acm3.com");
  });
});
