import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordUsage,
  getMonthlyUsage,
  getMonthlyUsageAcrossModules,
  type UsageRollupRow,
} from "../src/lib/module-usage";
import type { Env } from "../src/types";

class MockKV {
  store = new Map<string, string>();
  deletes: string[] = [];
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.store.delete(key);
  }
}

interface CapturedRun {
  sql: string;
  binds: unknown[];
}

interface CapturedAll<T> {
  sql: string;
  binds: unknown[];
  results: T[];
}

function makeDb(allResults: UsageRollupRow[]) {
  const runs: CapturedRun[] = [];
  const alls: CapturedAll<UsageRollupRow>[] = [];

  function prepare(sql: string) {
    return {
      bind: (...binds: unknown[]) => ({
        run: async () => {
          runs.push({ sql, binds });
          return { success: true } as unknown;
        },
        all: async <T>() => {
          alls.push({ sql, binds, results: allResults });
          return { results: allResults as unknown as T[] };
        },
      }),
    };
  }
  return { prepare, runs, alls };
}

function makeEnv(kv: MockKV, allResults: UsageRollupRow[] = []): { env: Env; db: ReturnType<typeof makeDb> } {
  const db = makeDb(allResults);
  const env = { CACHE: kv, DB: db } as unknown as Env;
  return { env, db };
}

const ORG_ID = 42;

describe("module-usage — recordUsage", () => {
  let kv: MockKV;
  beforeEach(() => {
    kv = new MockKV();
  });

  it("UPSERTs into org_usage_daily and busts both per-module + all-modules cache keys", async () => {
    const { env, db } = makeEnv(kv);
    await recordUsage(env, ORG_ID, "domain", "lookalikes_detected", 3);
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]!.sql).toContain("INSERT INTO org_usage_daily");
    expect(db.runs[0]!.binds[0]).toBe(ORG_ID);
    expect(db.runs[0]!.binds[1]).toBe("domain");
    expect(db.runs[0]!.binds[2]).toBe("lookalikes_detected");
    expect(db.runs[0]!.binds[4]).toBe(3);
    expect(kv.deletes).toHaveLength(2);
    expect(kv.deletes.some((k) => k.includes("domain"))).toBe(true);
    expect(kv.deletes.some((k) => k.includes(".all."))).toBe(true);
  });

  it("defaults delta to 1 when omitted", async () => {
    const { env, db } = makeEnv(kv);
    await recordUsage(env, ORG_ID, "social", "impersonators_detected");
    expect(db.runs[0]!.binds[4]).toBe(1);
  });

  it("no-ops when delta is 0 — no DB write, no cache bust", async () => {
    const { env, db } = makeEnv(kv);
    await recordUsage(env, ORG_ID, "trademark", "matches_detected", 0);
    expect(db.runs).toHaveLength(0);
    expect(kv.deletes).toHaveLength(0);
  });
});

describe("module-usage — getMonthlyUsage", () => {
  it("returns rollup rows for a single module", async () => {
    const fixture: UsageRollupRow[] = [
      { module_key: "domain", metric_key: "lookalikes_detected", day: "2026-05-01", value: 12 },
      { module_key: "domain", metric_key: "takedowns_submitted", day: "2026-05-01", value: 4 },
    ];
    const kv = new MockKV();
    const { env } = makeEnv(kv, fixture);
    const out = await getMonthlyUsage(env, ORG_ID, "domain");
    expect(out).toHaveLength(2);
    expect(out[0]?.metric_key).toBe("lookalikes_detected");
    expect(out[0]?.value).toBe(12);
  });

  it("uses KV cache on the second call (no second DB hit)", async () => {
    const fixture: UsageRollupRow[] = [
      { module_key: "social", metric_key: "impersonators_detected", day: "2026-05-01", value: 7 },
    ];
    const kv = new MockKV();
    const { env, db } = makeEnv(kv, fixture);
    await getMonthlyUsage(env, ORG_ID, "social");
    await getMonthlyUsage(env, ORG_ID, "social");
    // First call writes to KV, second call hits KV — DB only ran once.
    expect(db.alls).toHaveLength(1);
  });
});

describe("module-usage — getMonthlyUsageAcrossModules", () => {
  it("returns rollup rows across all modules for the org", async () => {
    const fixture: UsageRollupRow[] = [
      { module_key: "domain", metric_key: "lookalikes_detected", day: "2026-05-01", value: 12 },
      { module_key: "social", metric_key: "impersonators_detected", day: "2026-05-01", value: 7 },
      { module_key: "dark_web", metric_key: "mentions_detected", day: "2026-05-01", value: 3 },
    ];
    const kv = new MockKV();
    const { env } = makeEnv(kv, fixture);
    const out = await getMonthlyUsageAcrossModules(env, ORG_ID);
    expect(out).toHaveLength(3);
    const moduleKeys = out.map((r) => r.module_key).sort();
    expect(moduleKeys).toEqual(["dark_web", "domain", "social"]);
  });
});
