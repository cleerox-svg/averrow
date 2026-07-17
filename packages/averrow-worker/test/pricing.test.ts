import { describe, it, expect } from "vitest";
import {
  listPricingPlans,
  getPricingPlan,
  listModulePrices,
  listOrgPricingOverrides,
  getOrgPricingSummary,
  updatePricingPlan,
  updateModulePrice,
  createPricingOverride,
  revokePricingOverride,
} from "../src/lib/pricing";
import type { Env } from "../src/types";

interface DbResults {
  plans?:        Array<Record<string, unknown>>;
  planById?:     Record<string, Record<string, unknown>>;
  modulePrices?: Array<Record<string, unknown>>;
  orgRow?:       Record<string, unknown> | null;
  orgModules?:   Array<Record<string, unknown>>;
  overrides?:    Array<Record<string, unknown>>;
}

function makeDb(results: DbResults) {
  function allFor<T>(sql: string): { results: T[] } {
    if (sql.includes("FROM pricing_plans")) {
      return { results: (results.plans ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM module_prices")) {
      return { results: (results.modulePrices ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM org_modules")) {
      return { results: (results.orgModules ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM org_pricing_overrides")) {
      return { results: (results.overrides ?? []) as unknown as T[] };
    }
    return { results: [] };
  }
  function makeChain(sql: string, binds: unknown[] = []) {
    return {
      bind: (...nextBinds: unknown[]) => makeChain(sql, [...binds, ...nextBinds]),
      all:   async <T>() => allFor<T>(sql),
      first: async <T>() => {
        if (sql.includes("FROM pricing_plans") && sql.includes("WHERE id = ?")) {
          const planId = binds[0] as string;
          return ((results.planById ?? {})[planId] ?? null) as T | null;
        }
        if (sql.includes("FROM organizations") && sql.includes("plan_id")) {
          return (results.orgRow ?? null) as T | null;
        }
        return null;
      },
    };
  }
  function prepare(sql: string) {
    return makeChain(sql);
  }
  return { prepare };
}

function makeEnv(db: ReturnType<typeof makeDb>): Env {
  return { DB: db } as unknown as Env;
}

const PROFESSIONAL_RAW = {
  id: "professional",
  display_name: "Professional",
  monthly_price_cents: 149900,
  trial_days: 14,
  included_modules: '["domain","social","app_store"]',
  stripe_price_id: null,
  description: "Pro tier",
  is_active: 1,
  sort_order: 10,
};

describe("listPricingPlans / getPricingPlan", () => {
  it("returns active plans, parses included_modules JSON", async () => {
    const env = makeEnv(makeDb({ plans: [PROFESSIONAL_RAW] }));
    const plans = await listPricingPlans(env);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe("professional");
    expect(plans[0]?.included_modules).toEqual(["domain", "social", "app_store"]);
    expect(plans[0]?.is_active).toBe(true);
  });

  it("falls back to empty modules array on corrupt JSON", async () => {
    const env = makeEnv(makeDb({
      plans: [{ ...PROFESSIONAL_RAW, included_modules: "not-json" }],
    }));
    const plans = await listPricingPlans(env);
    expect(plans[0]?.included_modules).toEqual([]);
  });

  it("getPricingPlan returns null for missing plan", async () => {
    const env = makeEnv(makeDb({ planById: {} }));
    expect(await getPricingPlan(env, "missing")).toBeNull();
  });
});

describe("listModulePrices", () => {
  it("returns active modules with parsed types", async () => {
    const env = makeEnv(makeDb({
      modulePrices: [
        { module_key: "domain", display_name: "Domain", monthly_price_cents: 59900,
          stripe_price_id: null, is_active: 1 },
      ],
    }));
    const modules = await listModulePrices(env);
    expect(modules).toHaveLength(1);
    expect(modules[0]?.module_key).toBe("domain");
    expect(modules[0]?.is_active).toBe(true);
  });
});

describe("listOrgPricingOverrides", () => {
  it("returns overrides with parsed override_type", async () => {
    const env = makeEnv(makeDb({
      overrides: [{
        id: "ov1", org_id: 42, override_type: "tier_price",
        plan_id: "professional", module_key: null,
        custom_price_cents: 100000, discount_pct: null,
        reason: "Loyalty discount", set_by_user_id: "u1",
        effective_from: "2026-01-01", effective_until: null,
        created_at: "2026-01-01",
      }],
    }));
    const overrides = await listOrgPricingOverrides(env, 42);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.override_type).toBe("tier_price");
    expect(overrides[0]?.custom_price_cents).toBe(100000);
  });
});

describe("getOrgPricingSummary — effective price math", () => {
  it("baseline tier price with no overrides", async () => {
    const env = makeEnv(makeDb({
      orgRow: { plan_id: "professional", trial_ends_at: null, billing_status: "active" },
      planById: { professional: PROFESSIONAL_RAW },
      orgModules: [
        { module_key: "domain" }, { module_key: "social" }, { module_key: "app_store" },
      ],
      modulePrices: [
        { module_key: "domain", display_name: "Domain", monthly_price_cents: 59900, stripe_price_id: null, is_active: 1 },
      ],
      overrides: [],
    }));
    const s = await getOrgPricingSummary(env, 42);
    // All enabled modules are included in the plan → no per-module add-ons.
    expect(s.per_module_subscriptions).toHaveLength(0);
    // Baseline tier price kicks in.
    expect(s.effective_monthly_total_cents).toBe(149900);
    expect(s.billing_status).toBe("active");
  });

  it("tier_price override replaces baseline", async () => {
    const env = makeEnv(makeDb({
      orgRow: { plan_id: "professional", trial_ends_at: null, billing_status: "active" },
      planById: { professional: PROFESSIONAL_RAW },
      orgModules: [],
      modulePrices: [],
      overrides: [{
        id: "ov1", org_id: 42, override_type: "tier_price",
        plan_id: "professional", module_key: null,
        custom_price_cents: 99900, discount_pct: null,
        reason: "Negotiated", set_by_user_id: null,
        effective_from: "2026-01-01", effective_until: null,
        created_at: "2026-01-01",
      }],
    }));
    const s = await getOrgPricingSummary(env, 42);
    expect(s.effective_monthly_total_cents).toBe(99900);
  });

  it("discount_percent override applied after subtotal", async () => {
    const env = makeEnv(makeDb({
      orgRow: { plan_id: "professional", trial_ends_at: null, billing_status: "active" },
      planById: { professional: PROFESSIONAL_RAW },
      orgModules: [],
      modulePrices: [],
      overrides: [{
        id: "ov1", org_id: 42, override_type: "discount_percent",
        plan_id: null, module_key: null,
        custom_price_cents: null, discount_pct: 10,
        reason: "Annual prepay", set_by_user_id: null,
        effective_from: "2026-01-01", effective_until: null,
        created_at: "2026-01-01",
      }],
    }));
    const s = await getOrgPricingSummary(env, 42);
    // 149900 * 0.90 = 134910
    expect(s.effective_monthly_total_cents).toBe(134910);
  });

  it("a-la-carte add-ons summed and module_price overrides applied", async () => {
    const env = makeEnv(makeDb({
      orgRow: { plan_id: "professional", trial_ends_at: null, billing_status: "active" },
      planById: { professional: PROFESSIONAL_RAW },
      // dark_web is NOT in Professional's included_modules → it's à-la-carte
      orgModules: [{ module_key: "dark_web" }],
      modulePrices: [
        { module_key: "dark_web", display_name: "Dark Web", monthly_price_cents: 79900, stripe_price_id: null, is_active: 1 },
      ],
      overrides: [{
        id: "ov1", org_id: 42, override_type: "module_price",
        plan_id: null, module_key: "dark_web",
        custom_price_cents: 50000, discount_pct: null,
        reason: "Custom dark-web rate", set_by_user_id: null,
        effective_from: "2026-01-01", effective_until: null,
        created_at: "2026-01-01",
      }],
    }));
    const s = await getOrgPricingSummary(env, 42);
    expect(s.per_module_subscriptions).toHaveLength(1);
    expect(s.per_module_subscriptions[0]?.module_key).toBe("dark_web");
    // tier 149900 + module override 50000 = 199900
    expect(s.effective_monthly_total_cents).toBe(199900);
  });

  it("returns billing_status='unbilled' when org has no plan", async () => {
    const env = makeEnv(makeDb({
      orgRow: { plan_id: null, trial_ends_at: null, billing_status: "unbilled" },
      orgModules: [],
      modulePrices: [],
      overrides: [],
    }));
    const s = await getOrgPricingSummary(env, 42);
    expect(s.plan).toBeNull();
    expect(s.effective_monthly_total_cents).toBe(0);
    expect(s.billing_status).toBe("unbilled");
  });
});

// ─── Write-side helpers ─────────────────────────────────────────

interface CapturedRun { sql: string; binds: unknown[] }

function makeCapturingDb(results: DbResults, captured: CapturedRun[]) {
  function allFor<T>(sql: string): { results: T[] } {
    if (sql.includes("FROM pricing_plans"))         return { results: (results.plans ?? []) as unknown as T[] };
    if (sql.includes("FROM module_prices"))         return { results: (results.modulePrices ?? []) as unknown as T[] };
    if (sql.includes("FROM org_modules"))           return { results: (results.orgModules ?? []) as unknown as T[] };
    if (sql.includes("FROM org_pricing_overrides")) return { results: (results.overrides ?? []) as unknown as T[] };
    return { results: [] };
  }
  function makeChain(sql: string, binds: unknown[] = []) {
    return {
      bind: (...next: unknown[]) => makeChain(sql, [...binds, ...next]),
      run:   async () => { captured.push({ sql, binds }); return { success: true }; },
      all:   async <T>() => allFor<T>(sql),
      first: async <T>() => {
        if (sql.includes("FROM pricing_plans") && sql.includes("WHERE id = ?")) {
          const planId = binds[0] as string;
          return ((results.planById ?? {})[planId] ?? null) as T | null;
        }
        if (sql.includes("FROM module_prices") && sql.includes("WHERE module_key = ?")) {
          const key = binds[0] as string;
          const row = (results.modulePrices ?? []).find((m) => (m as { module_key: string }).module_key === key);
          return (row ?? null) as T | null;
        }
        return null;
      },
    };
  }
  return { prepare: (sql: string) => makeChain(sql) };
}

describe("updatePricingPlan", () => {
  it("emits an UPDATE with only the fields provided", async () => {
    const captured: CapturedRun[] = [];
    const env = { DB: makeCapturingDb({
      planById: { professional: { ...PROFESSIONAL_RAW, monthly_price_cents: 100000, display_name: "Pro Discounted" } },
    }, captured) } as unknown as Env;

    const result = await updatePricingPlan(env, "professional", {
      monthly_price_cents: 100000,
      display_name: "Pro Discounted",
    });
    expect(result?.monthly_price_cents).toBe(100000);
    expect(result?.display_name).toBe("Pro Discounted");

    const updateCall = captured.find((c) => c.sql.includes("UPDATE pricing_plans"));
    expect(updateCall).toBeDefined();
    expect(updateCall?.sql).toContain("display_name = ?");
    expect(updateCall?.sql).toContain("monthly_price_cents = ?");
    // Only the two fields + updated_at clause; trial_days etc. left untouched.
    expect(updateCall?.sql).not.toContain("trial_days = ?");
    expect(updateCall?.sql).not.toContain("included_modules = ?");
  });

  it("serializes included_modules as JSON when patched", async () => {
    const captured: CapturedRun[] = [];
    const env = { DB: makeCapturingDb({
      planById: { professional: PROFESSIONAL_RAW },
    }, captured) } as unknown as Env;

    await updatePricingPlan(env, "professional", {
      included_modules: ["domain", "social"],
    });
    const updateCall = captured.find((c) => c.sql.includes("UPDATE pricing_plans"));
    const moduleArg = updateCall?.binds[0];
    expect(moduleArg).toBe('["domain","social"]');
  });

  it("noop patch returns current plan without an UPDATE call", async () => {
    const captured: CapturedRun[] = [];
    const env = { DB: makeCapturingDb({
      planById: { professional: PROFESSIONAL_RAW },
    }, captured) } as unknown as Env;

    await updatePricingPlan(env, "professional", {});
    expect(captured.find((c) => c.sql.includes("UPDATE pricing_plans"))).toBeUndefined();
  });
});

describe("updateModulePrice", () => {
  it("updates and returns the refreshed row", async () => {
    const captured: CapturedRun[] = [];
    const env = { DB: makeCapturingDb({
      modulePrices: [
        { module_key: "domain", display_name: "Domain", monthly_price_cents: 49900,
          stripe_price_id: null, is_active: 1 },
      ],
    }, captured) } as unknown as Env;

    const result = await updateModulePrice(env, "domain", { monthly_price_cents: 49900 });
    expect(result?.monthly_price_cents).toBe(49900);
    expect(captured.find((c) => c.sql.includes("UPDATE module_prices"))).toBeDefined();
  });
});

describe("createPricingOverride", () => {
  it("inserts a tier_price override", async () => {
    const captured: CapturedRun[] = [];
    const env = { DB: makeCapturingDb({}, captured) } as unknown as Env;
    const id = await createPricingOverride(env, {
      org_id: 42, override_type: "tier_price",
      plan_id: "professional", custom_price_cents: 100000,
      reason: "Loyalty",
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    const insert = captured.find((c) => c.sql.includes("INSERT INTO org_pricing_overrides"));
    expect(insert).toBeDefined();
    expect(insert?.binds[2]).toBe("tier_price");
    expect(insert?.binds[3]).toBe("professional");
    expect(insert?.binds[5]).toBe(100000);
  });

  it("rejects tier_price without plan_id", async () => {
    const captured: CapturedRun[] = [];
    const env = { DB: makeCapturingDb({}, captured) } as unknown as Env;
    await expect(createPricingOverride(env, {
      org_id: 42, override_type: "tier_price",
      custom_price_cents: 100000, reason: "x",
    })).rejects.toThrow(/plan_id/);
  });

  it("rejects discount_percent outside 0-100", async () => {
    const captured: CapturedRun[] = [];
    const env = { DB: makeCapturingDb({}, captured) } as unknown as Env;
    await expect(createPricingOverride(env, {
      org_id: 42, override_type: "discount_percent",
      discount_pct: 150, reason: "x",
    })).rejects.toThrow(/between 0 and 100/);
  });
});

describe("revokePricingOverride", () => {
  it("emits an UPDATE that stamps effective_until = now", async () => {
    const captured: CapturedRun[] = [];
    const env = { DB: makeCapturingDb({}, captured) } as unknown as Env;
    await revokePricingOverride(env, "ov-abc");
    const upd = captured.find((c) => c.sql.includes("UPDATE org_pricing_overrides"));
    expect(upd).toBeDefined();
    expect(upd?.sql).toContain("effective_until = datetime('now')");
    expect(upd?.binds).toEqual(["ov-abc"]);
  });
});
