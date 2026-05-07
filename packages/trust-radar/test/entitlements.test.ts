import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isModuleEnabled,
  listEnabledModules,
  requireModule,
  ModuleNotEntitledError,
  MODULE_KEYS,
  type OrgModule,
} from "../src/lib/entitlements";
import type { Env } from "../src/types";

// ── Minimal in-memory KV mock ─────────────────────────────────────
// Same shape as test/cached-count.test.ts — entitlements.ts goes
// through cachedValue, which uses CACHE.get/put/delete only.
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

// ── D1 mock — drives the SELECT result entitlements.ts issues ─────
function makeDb(rows: OrgModule[]) {
  return {
    prepare: () => ({
      bind: () => ({
        all: async <T>() => ({ results: rows as unknown as T[] }),
      }),
    }),
  };
}

function makeEnv(kv: MockKV, rows: OrgModule[]): Env {
  return { CACHE: kv, DB: makeDb(rows) } as unknown as Env;
}

const ORG_ID = 42;

const fixtureActive: OrgModule = {
  module_key: "domain",
  status: "active",
  activated_at: "2026-01-01T00:00:00Z",
  suspended_at: null,
  trial_ends_at: null,
  config_json: null,
};

const fixtureTrialFuture: OrgModule = {
  module_key: "social",
  status: "trial",
  activated_at: "2026-05-01T00:00:00Z",
  suspended_at: null,
  trial_ends_at: "2099-12-31T00:00:00Z",
  config_json: null,
};

const fixtureTrialExpired: OrgModule = {
  module_key: "dark_web",
  status: "trial",
  activated_at: "2025-01-01T00:00:00Z",
  suspended_at: null,
  trial_ends_at: "2025-02-01T00:00:00Z",
  config_json: null,
};

describe("entitlements — listEnabledModules", () => {
  let kv: MockKV;

  beforeEach(() => {
    kv = new MockKV();
  });

  it("returns active modules", async () => {
    const env = makeEnv(kv, [fixtureActive]);
    const out = await listEnabledModules(env, ORG_ID);
    expect(out).toHaveLength(1);
    expect(out[0]?.module_key).toBe("domain");
  });

  it("returns trial modules whose trial hasn't expired", async () => {
    const env = makeEnv(kv, [fixtureTrialFuture]);
    const out = await listEnabledModules(env, ORG_ID);
    expect(out).toHaveLength(1);
    expect(out[0]?.module_key).toBe("social");
  });

  it("filters trial modules whose trial has expired", async () => {
    const env = makeEnv(kv, [fixtureTrialExpired]);
    const out = await listEnabledModules(env, ORG_ID);
    expect(out).toHaveLength(0);
  });

  it("returns empty list when org has no entitlements", async () => {
    const env = makeEnv(kv, []);
    const out = await listEnabledModules(env, ORG_ID);
    expect(out).toHaveLength(0);
  });
});

describe("entitlements — isModuleEnabled", () => {
  it("returns true for an active module", async () => {
    const env = makeEnv(new MockKV(), [fixtureActive]);
    expect(await isModuleEnabled(env, ORG_ID, "domain")).toBe(true);
  });

  it("returns false when the org has a different module", async () => {
    const env = makeEnv(new MockKV(), [fixtureActive]);
    expect(await isModuleEnabled(env, ORG_ID, "social")).toBe(false);
  });

  it("returns false for an expired trial module", async () => {
    const env = makeEnv(new MockKV(), [fixtureTrialExpired]);
    expect(await isModuleEnabled(env, ORG_ID, "dark_web")).toBe(false);
  });
});

describe("entitlements — requireModule", () => {
  it("resolves silently when entitled", async () => {
    const env = makeEnv(new MockKV(), [fixtureActive]);
    await expect(requireModule(env, ORG_ID, "domain")).resolves.toBeUndefined();
  });

  it("throws ModuleNotEntitledError when not entitled", async () => {
    const env = makeEnv(new MockKV(), []);
    await expect(requireModule(env, ORG_ID, "domain")).rejects.toBeInstanceOf(
      ModuleNotEntitledError,
    );
  });

  it("error carries org id + module key for handler-side 403 mapping", async () => {
    const env = makeEnv(new MockKV(), []);
    try {
      await requireModule(env, ORG_ID, "trademark");
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as ModuleNotEntitledError;
      expect(e).toBeInstanceOf(ModuleNotEntitledError);
      expect(e.orgId).toBe(ORG_ID);
      expect(e.moduleKey).toBe("trademark");
    }
  });
});

describe("entitlements — MODULE_KEYS canonical list", () => {
  it("includes all 7 v3 modules in lockstep with the seed migration", () => {
    expect(MODULE_KEYS).toEqual([
      "domain",
      "social",
      "app_store",
      "dark_web",
      "abuse_mailbox",
      "trademark",
      "threat_actor",
    ]);
  });
});
