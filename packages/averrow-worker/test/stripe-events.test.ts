import { describe, it, expect } from "vitest";
import {
  mapSubscriptionStatus,
  syncOrgFromSubscription,
  cancelOrgFromSubscription,
  markOrgPastDue,
  clearOrgPastDue,
  type StripeSubscription,
} from "../src/lib/stripe-events";
import type { Env } from "../src/types";

interface CapturedRun { sql: string; binds: unknown[] }

interface DbStub {
  // What the prepare(...).first() should return for each SELECT family
  orgRow?:    { id: number } | null;
  planRow?:   { id: string; included_modules: string } | null;
  moduleRow?: { module_key: string } | null;
}

function makeEnv(stub: DbStub, captured: CapturedRun[]): Env {
  function makeChain(sql: string, binds: unknown[] = []) {
    return {
      bind: (...next: unknown[]) => makeChain(sql, [...binds, ...next]),
      run:   async () => { captured.push({ sql, binds }); return { success: true }; },
      all:   async () => ({ results: [] }),
      first: async () => {
        if (sql.includes("FROM organizations") && sql.includes("stripe_customer_id")) {
          return stub.orgRow ?? null;
        }
        if (sql.includes("FROM pricing_plans") && sql.includes("stripe_price_id")) {
          return stub.planRow ?? null;
        }
        if (sql.includes("FROM module_prices") && sql.includes("stripe_price_id")) {
          return stub.moduleRow ?? null;
        }
        return null;
      },
    };
  }
  return { DB: { prepare: (sql: string) => makeChain(sql) } } as unknown as Env;
}

describe("mapSubscriptionStatus", () => {
  it("maps Stripe statuses onto our billing_status enum", () => {
    expect(mapSubscriptionStatus("trialing")).toBe("trialing");
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("past_due")).toBe("past_due");
    expect(mapSubscriptionStatus("unpaid")).toBe("past_due");
    expect(mapSubscriptionStatus("paused")).toBe("past_due");
    expect(mapSubscriptionStatus("canceled")).toBe("cancelled");
    expect(mapSubscriptionStatus("incomplete_expired")).toBe("cancelled");
    expect(mapSubscriptionStatus("incomplete")).toBe("unbilled");
    expect(mapSubscriptionStatus("anything_else")).toBe("unbilled");
  });
});

const MAKE_SUB = (overrides: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id: "sub_123",
  customer: "cus_acme",
  status: "active",
  trial_end: null,
  items: { data: [{ id: "si_1", price: { id: "price_professional" } }] },
  ...overrides,
});

describe("syncOrgFromSubscription", () => {
  it("returns null when org isn't bound to the customer", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv({ orgRow: null }, captured);
    const result = await syncOrgFromSubscription(env, MAKE_SUB());
    expect(result).toBeNull();
  });

  it("syncs plan + included_modules + status='active'", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv({
      orgRow: { id: 42 },
      planRow: { id: "professional", included_modules: '["domain","social","app_store"]' },
    }, captured);

    const result = await syncOrgFromSubscription(env, MAKE_SUB({ status: "active" }));
    expect(result).not.toBeNull();
    expect(result?.org_id).toBe(42);
    expect(result?.billing_status).toBe("active");
    expect(result?.plan_id).toBe("professional");
    expect(result?.enabled_modules.sort()).toEqual(["app_store", "domain", "social"]);

    // organizations row was UPDATEd
    const orgUpdate = captured.find((c) => c.sql.includes("UPDATE organizations"));
    expect(orgUpdate).toBeDefined();
    expect(orgUpdate?.binds[0]).toBe("sub_123");           // stripe_subscription_id
    expect(orgUpdate?.binds[1]).toBe("professional");      // plan_id
    expect(orgUpdate?.binds[3]).toBe("active");            // billing_status

    // org_modules entries were UPSERTed (one per included module)
    const moduleUpserts = captured.filter((c) => c.sql.includes("INSERT INTO org_modules"));
    expect(moduleUpserts.length).toBe(3);
    moduleUpserts.forEach((c) => expect(c.binds[2]).toBe("active")); // status='active'

    // Modules NOT in the new set get suspended
    const suspend = captured.find((c) => c.sql.includes("UPDATE org_modules") && c.sql.includes("suspended"));
    expect(suspend).toBeDefined();
  });

  it("flags status='trial' on trialing subscriptions + stamps trial_ends_at", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv({
      orgRow: { id: 42 },
      planRow: { id: "professional", included_modules: '["domain"]' },
    }, captured);
    const trialEndUnix = 1700000000;
    const result = await syncOrgFromSubscription(env, MAKE_SUB({
      status: "trialing", trial_end: trialEndUnix,
    }));
    expect(result?.billing_status).toBe("trialing");
    expect(result?.trial_ends_at).toContain("2023-11");

    const moduleUpsert = captured.find((c) => c.sql.includes("INSERT INTO org_modules"));
    expect(moduleUpsert?.binds[2]).toBe("trial");
  });

  it("merges plan-included modules + à-la-carte modules from separate subscription items", async () => {
    const captured: CapturedRun[] = [];
    let firstCalls = 0;
    const env: Env = {
      DB: {
        prepare: (sql: string) => {
          const helper = (binds: unknown[] = []) => ({
            bind: (...next: unknown[]) => helper([...binds, ...next]),
            run: async () => { captured.push({ sql, binds }); return { success: true }; },
            all: async () => ({ results: [] }),
            first: async () => {
              if (sql.includes("FROM organizations")) return { id: 42 };
              if (sql.includes("FROM pricing_plans") && sql.includes("stripe_price_id")) {
                firstCalls++;
                // First lookup is for price_pro → plan; second is for
                // price_dwm which is NOT a plan (returns null).
                if (binds[0] === "price_pro") {
                  return { id: "professional", included_modules: '["domain","social"]' };
                }
                return null;
              }
              if (sql.includes("FROM module_prices") && sql.includes("stripe_price_id")) {
                if (binds[0] === "price_dwm") return { module_key: "dark_web" };
                return null;
              }
              return null;
            },
          });
          return helper();
        },
      },
    } as unknown as Env;

    const sub: StripeSubscription = {
      id: "sub_123",
      customer: "cus_acme",
      status: "active",
      trial_end: null,
      items: {
        data: [
          { id: "si_1", price: { id: "price_pro" } },
          { id: "si_2", price: { id: "price_dwm" } },
        ],
      },
    };

    const result = await syncOrgFromSubscription(env, sub);
    expect(result?.enabled_modules.sort()).toEqual(["dark_web", "domain", "social"]);
    expect(firstCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("cancelOrgFromSubscription", () => {
  it("flips billing_status to cancelled + suspends all active modules", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv({ orgRow: { id: 42 } }, captured);
    const result = await cancelOrgFromSubscription(env, MAKE_SUB());
    expect(result?.billing_status).toBe("cancelled");

    const orgUpdate = captured.find((c) => c.sql.includes("UPDATE organizations") && c.sql.includes("cancelled"));
    expect(orgUpdate).toBeDefined();

    const moduleSuspend = captured.find((c) => c.sql.includes("UPDATE org_modules") && c.sql.includes("suspended"));
    expect(moduleSuspend).toBeDefined();
  });

  it("returns null when org not found", async () => {
    const env = makeEnv({ orgRow: null }, []);
    expect(await cancelOrgFromSubscription(env, MAKE_SUB())).toBeNull();
  });
});

describe("markOrgPastDue / clearOrgPastDue", () => {
  it("markOrgPastDue updates billing_status", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv({ orgRow: { id: 42 } }, captured);
    const r = await markOrgPastDue(env, "cus_acme");
    expect(r?.org_id).toBe(42);
    const upd = captured.find((c) => c.sql.includes("UPDATE organizations") && c.sql.includes("past_due"));
    expect(upd).toBeDefined();
  });

  it("clearOrgPastDue only flips when WHERE billing_status='past_due'", async () => {
    const captured: CapturedRun[] = [];
    const env = makeEnv({ orgRow: { id: 42 } }, captured);
    await clearOrgPastDue(env, "cus_acme");
    const upd = captured.find((c) => c.sql.includes("UPDATE organizations") && c.sql.includes("billing_status = 'active'"));
    expect(upd).toBeDefined();
    // The SQL includes the guard so we don't accidentally flip e.g. cancelled → active
    expect(upd?.sql).toContain("billing_status = 'past_due'");
  });
});
