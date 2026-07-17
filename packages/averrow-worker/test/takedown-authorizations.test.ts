import { describe, it, expect, beforeEach } from "vitest";
import {
  getActiveAuthorization,
  isModuleAuthorized,
  requireAuthorizationForModule,
  recordSignedAuthorization,
  revokeAuthorization,
  TakedownNotAuthorizedError,
  type AuthorizationScope,
} from "../src/lib/takedown-authorizations";
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
  sql:   string;
  binds: unknown[];
}

interface RawAuthRow {
  id:                 string;
  org_id:             number;
  agreement_version:  string;
  status:             string;
  signed_at:          string;
  signed_by_user_id:  string;
  signed_ip:          string | null;
  signed_user_agent:  string | null;
  scope_json:         string;
  revoked_at:         string | null;
  revoked_by_user_id: string | null;
  revoked_reason:     string | null;
  created_at:         string;
  updated_at:         string;
}

function makeDb(firstResult: RawAuthRow | null = null) {
  const runs:   CapturedRun[] = [];
  const batches: CapturedRun[][] = [];

  function prepare(sql: string) {
    return {
      bind: (...binds: unknown[]) => ({
        run: async () => {
          runs.push({ sql, binds });
          return { success: true };
        },
        first: async <T>() => firstResult as unknown as T,
      }),
    };
  }
  return {
    prepare,
    runs,
    batches,
    async batch(stmts: Array<{ sql: string; binds: unknown[]; run: () => Promise<unknown> }>) {
      // Stmts come back from prepare(...).bind(...) above which exposes
      // .sql/.binds via closure capture; in our tests we just track each
      // batch's stmt count. Actual writes are mocked to no-op.
      const recorded: CapturedRun[] = [];
      for (const s of stmts) {
        await s.run();
      }
      batches.push(recorded);
      return [];
    },
  };
}

function makeEnv(kv: MockKV, db: ReturnType<typeof makeDb>): Env {
  return { CACHE: kv, DB: db } as unknown as Env;
}

const ORG_ID = 42;

const baseScope: AuthorizationScope = {
  modules: ["domain", "social", "trademark"],
  max_takedowns_per_month: 500,
  escalation: "auto_resubmit_on_pivot",
  auto_followup_breached_sla_hours: 48,
  high_risk_requires_per_takedown_approval: true,
};

const fixtureRow: RawAuthRow = {
  id:                 "auth-abc",
  org_id:             ORG_ID,
  agreement_version:  "msa-2026-05",
  status:             "active",
  signed_at:          "2026-05-07T00:00:00Z",
  signed_by_user_id:  "u-owner",
  signed_ip:          "1.2.3.4",
  signed_user_agent:  "Mozilla/5.0",
  scope_json:         JSON.stringify(baseScope),
  revoked_at:         null,
  revoked_by_user_id: null,
  revoked_reason:     null,
  created_at:         "2026-05-07T00:00:00Z",
  updated_at:         "2026-05-07T00:00:00Z",
};

describe("getActiveAuthorization", () => {
  let kv: MockKV;
  beforeEach(() => {
    kv = new MockKV();
  });

  it("returns null when no row exists", async () => {
    const env = makeEnv(kv, makeDb(null));
    expect(await getActiveAuthorization(env, ORG_ID)).toBeNull();
  });

  it("parses scope_json into the structured scope shape", async () => {
    const env = makeEnv(kv, makeDb(fixtureRow));
    const auth = await getActiveAuthorization(env, ORG_ID);
    expect(auth).not.toBeNull();
    expect(auth!.scope.modules).toEqual(["domain", "social", "trademark"]);
    expect(auth!.scope.escalation).toBe("auto_resubmit_on_pivot");
    expect(auth!.scope.high_risk_requires_per_takedown_approval).toBe(true);
  });

  it("falls back to a most-restrictive scope when scope_json is corrupt", async () => {
    const env = makeEnv(kv, makeDb({ ...fixtureRow, scope_json: "not-json" }));
    const auth = await getActiveAuthorization(env, ORG_ID);
    expect(auth!.scope.modules).toEqual([]);
    expect(auth!.scope.escalation).toBe("manual_only");
    // mode 'off' is the true most-restrictive posture: Sparrow Phase G
    // refuses every auto-submit. (The legacy high_risk boolean is false
    // under 'off' because the per-takedown approval gate only applies in
    // semi_auto.)
    expect(auth!.scope.mode).toBe("off");
    expect(auth!.scope.high_risk_requires_per_takedown_approval).toBe(false);
  });
});

describe("isModuleAuthorized", () => {
  it("returns true for a covered module", async () => {
    const env = makeEnv(new MockKV(), makeDb(fixtureRow));
    expect(await isModuleAuthorized(env, ORG_ID, "domain")).toBe(true);
  });

  it("returns false for an uncovered module", async () => {
    const env = makeEnv(new MockKV(), makeDb(fixtureRow));
    expect(await isModuleAuthorized(env, ORG_ID, "dark_web")).toBe(false);
  });

  it("returns false when no authorization exists", async () => {
    const env = makeEnv(new MockKV(), makeDb(null));
    expect(await isModuleAuthorized(env, ORG_ID, "domain")).toBe(false);
  });
});

describe("requireAuthorizationForModule", () => {
  it("resolves with the authorization when covered", async () => {
    const env = makeEnv(new MockKV(), makeDb(fixtureRow));
    const auth = await requireAuthorizationForModule(env, ORG_ID, "domain");
    expect(auth.org_id).toBe(ORG_ID);
  });

  it("throws TakedownNotAuthorizedError(no_authorization) when none signed", async () => {
    const env = makeEnv(new MockKV(), makeDb(null));
    await expect(
      requireAuthorizationForModule(env, ORG_ID, "domain"),
    ).rejects.toBeInstanceOf(TakedownNotAuthorizedError);
  });

  it("throws TakedownNotAuthorizedError(module_not_in_scope) when signed but module excluded", async () => {
    const env = makeEnv(new MockKV(), makeDb(fixtureRow));
    try {
      await requireAuthorizationForModule(env, ORG_ID, "abuse_mailbox");
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as TakedownNotAuthorizedError;
      expect(e).toBeInstanceOf(TakedownNotAuthorizedError);
      expect(e.reason).toBe("module_not_in_scope");
      expect(e.moduleKey).toBe("abuse_mailbox");
    }
  });
});

describe("revokeAuthorization", () => {
  it("issues an UPDATE and busts cache", async () => {
    const kv = new MockKV();
    // Pre-fill cache to confirm bust
    await kv.put("cv:takedown_auth.org.42.active", JSON.stringify({ t: Date.now(), v: { id: "x" } }));
    const db = makeDb(fixtureRow);
    const env = makeEnv(kv, db);
    await revokeAuthorization(env, ORG_ID, { revokedByUserId: "u-revoker", reason: "tenant request" });
    expect(db.runs.some((r) => r.sql.includes("UPDATE takedown_authorizations") && r.sql.includes("'revoked'"))).toBe(true);
    expect(kv.deletes).toContain("cv:takedown_auth.org.42.active");
  });
});
