import { describe, it, expect, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import {
  runExecutiveMonitorBatch,
  resolveAlertUserForOrg,
  loadActiveExecutivesRotating,
  type ExecutiveBatchRow,
  type ExecutiveMonitorBatchDeps,
} from "../src/scanners/executive-monitor-batch";
import type { ExecutiveImpersonationCandidate } from "../src/scanners/executive-monitor";
import type { Env } from "../src/types";

// The batch is exercised entirely through injected deps, so no real D1 /
// KV is touched — env is an inert stub (createAlertFn is mocked and never
// dereferences env.DB in a way that matters).
const env = {} as unknown as Env;

function exec(id: string, over: Partial<ExecutiveBatchRow> = {}): ExecutiveBatchRow {
  return {
    id,
    brand_id: "brand-shared",
    org_id: 1, // org A
    full_name: "Jane Doe",
    official_handles: JSON.stringify({ twitter: "janedoe" }),
    watch_platforms: JSON.stringify(["twitter", "instagram"]),
    ...over,
  };
}

function candidate(
  over: Partial<ExecutiveImpersonationCandidate> = {},
): ExecutiveImpersonationCandidate {
  return {
    execId: "e1",
    platform: "twitter",
    handle: "janedoe1",
    exists: true,
    score: 0.8,
    severity: "HIGH",
    signals: ["handle is a name permutation"],
    isOfficialHandle: false,
    profileUrl: "https://twitter.com/janedoe1",
    ...over,
  };
}

/** Build a deps object with sensible passing defaults, overridable. */
function mkDeps(
  over: Partial<ExecutiveMonitorBatchDeps> = {},
): ExecutiveMonitorBatchDeps & { createAlertFn: ReturnType<typeof vi.fn> } {
  const createAlertFn = vi.fn(async () => "alert-id");
  return {
    loadExecutives: async () => [exec("e1")],
    scan: async () => [candidate()],
    resolveAlertUser: async () => "userA-owner",
    isDuplicateAlert: async () => false,
    createAlertFn: createAlertFn as unknown as ExecutiveMonitorBatchDeps["createAlertFn"],
    ...over,
  } as ExecutiveMonitorBatchDeps & { createAlertFn: ReturnType<typeof vi.fn> };
}

describe("runExecutiveMonitorBatch — alert creation", () => {
  it("creates one alert per non-official candidate with the Stage-4 details shape", async () => {
    const deps = mkDeps();
    const stats = await runExecutiveMonitorBatch(env, deps);

    expect(stats.executives_processed).toBe(1);
    expect(stats.candidates_found).toBe(1);
    expect(stats.alerts_created).toBe(1);
    expect(deps.createAlertFn).toHaveBeenCalledTimes(1);

    const [, params] = deps.createAlertFn.mock.calls[0]!;
    expect(params.alertType).toBe("executive_impersonation");
    expect(params.brandId).toBe("brand-shared");
    expect(params.userId).toBe("userA-owner");
    expect(params.sourceType).toBe("executive_monitor");
    // Details must carry exactly what the triage rule + future UI read.
    expect(params.details).toMatchObject({
      executive_id: "e1",
      score: 0.8,
      handle: "janedoe1",
      platform: "twitter",
      profile_url: "https://twitter.com/janedoe1",
      is_official_handle: false,
    });
  });

  it("never alerts on the exec's own official handle", async () => {
    const deps = mkDeps({
      scan: async () => [candidate({ isOfficialHandle: true, handle: "janedoe" })],
    });
    const stats = await runExecutiveMonitorBatch(env, deps);

    expect(stats.candidates_found).toBe(1);
    expect(stats.skipped_official).toBe(1);
    expect(stats.alerts_created).toBe(0);
    expect(deps.createAlertFn).not.toHaveBeenCalled();
  });

  it("suppresses a duplicate candidate (dedup guard) without creating an alert", async () => {
    const deps = mkDeps({ isDuplicateAlert: async () => true });
    const stats = await runExecutiveMonitorBatch(env, deps);

    expect(stats.skipped_dedup).toBe(1);
    expect(stats.alerts_created).toBe(0);
    expect(deps.createAlertFn).not.toHaveBeenCalled();
  });

  it("counts a null createAlert return (tier-gated brand) as not-created", async () => {
    const deps = mkDeps({
      createAlertFn: vi.fn(async () => null) as unknown as ExecutiveMonitorBatchDeps["createAlertFn"],
    });
    const stats = await runExecutiveMonitorBatch(env, deps);
    expect(stats.candidates_found).toBe(1);
    expect(stats.alerts_created).toBe(0);
  });

  it("processes multiple candidates across the surfaced set", async () => {
    const deps = mkDeps({
      scan: async () => [
        candidate({ handle: "janedoe1", platform: "twitter" }),
        candidate({ handle: "jane_doe", platform: "instagram" }),
        candidate({ handle: "janedoe", platform: "twitter", isOfficialHandle: true }),
      ],
    });
    const stats = await runExecutiveMonitorBatch(env, deps);

    expect(stats.candidates_found).toBe(3);
    expect(stats.skipped_official).toBe(1);
    expect(stats.alerts_created).toBe(2);
    expect(deps.createAlertFn).toHaveBeenCalledTimes(2);
  });
});

// ─── FIX 1 regression: cross-org PII isolation ───────────────────
// Exec registered by org A under a brand ALSO monitored by org B. The
// alert (whose title/summary embed the exec's name) must route to a user
// in org A, NEVER org B. Routing is keyed by the exec's org_id, not the
// shared brand_id.
describe("runExecutiveMonitorBatch — routes strictly within the exec's own org (no cross-org leak)", () => {
  it("routes the alert to the exec's OWN org (org A), never a co-monitoring org (org B)", async () => {
    // Simulate the real org_members resolver: org A (id 1) → its own owner,
    // org B (id 2) → org B's owner. A brand-scoped bug would have returned
    // org B's user; keying on org_id makes that impossible.
    const usersByOrg: Record<number, string> = { 1: "userA-owner", 2: "userB-owner" };
    const resolveAlertUser = vi.fn(async (_env: Env, orgId: number) => usersByOrg[orgId] ?? null);

    const deps = mkDeps({
      // exec belongs to org A (org_id 1) but its brand is co-monitored by org B.
      loadExecutives: async () => [exec("execA", { org_id: 1, brand_id: "brand-shared" })],
      resolveAlertUser: resolveAlertUser as unknown as ExecutiveMonitorBatchDeps["resolveAlertUser"],
    });

    const stats = await runExecutiveMonitorBatch(env, deps);

    // The resolver was asked for the EXEC'S org_id (1), NOT the brand id.
    expect(resolveAlertUser).toHaveBeenCalledWith(env, 1);
    expect(resolveAlertUser).not.toHaveBeenCalledWith(env, "brand-shared");

    expect(stats.alerts_created).toBe(1);
    const [, params] = deps.createAlertFn.mock.calls[0]!;
    expect(params.userId).toBe("userA-owner");
    expect(params.userId).not.toBe("userB-owner");
  });

  it("creates NO alert when the exec's own org has no resolvable user (never falls back cross-org)", async () => {
    const deps = mkDeps({
      loadExecutives: async () => [exec("execA", { org_id: 42 })],
      resolveAlertUser: async () => null, // org 42 has no active member
    });

    const stats = await runExecutiveMonitorBatch(env, deps);

    expect(stats.candidates_found).toBe(1);
    expect(stats.skipped_no_org_user).toBe(1);
    expect(stats.alerts_created).toBe(0);
    expect(deps.createAlertFn).not.toHaveBeenCalled();
  });
});

// ─── FIX 2 regression: full-body per-exec error isolation ────────
// A throw ANYWHERE in the per-exec body (scan, dedup, createAlert, …) must
// not abort the batch — later execs are still processed and stats.errors
// reflects the failure.
describe("runExecutiveMonitorBatch — per-exec error isolation covers the whole body", () => {
  it("isolates a scan() failure — remaining execs still processed", async () => {
    let call = 0;
    const deps = mkDeps({
      loadExecutives: async () => [exec("e1"), exec("e2")],
      scan: async () => {
        call += 1;
        if (call === 1) throw new Error("probe timeout");
        return [candidate({ execId: "e2" })];
      },
    });
    const stats = await runExecutiveMonitorBatch(env, deps);

    expect(stats.executives_processed).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.alerts_created).toBe(1);
  });

  it("isolates a createAlert() / D1 throw on one exec — the batch continues", async () => {
    let alertCall = 0;
    const createAlertFn = vi.fn(async () => {
      alertCall += 1;
      if (alertCall === 1) throw new Error("D1_ERROR: transient write failure");
      return "alert-id";
    });
    const deps = mkDeps({
      loadExecutives: async () => [exec("e1", { id: "e1" }), exec("e2", { id: "e2" })],
      scan: async (e) => [candidate({ execId: e.id })],
      createAlertFn: createAlertFn as unknown as ExecutiveMonitorBatchDeps["createAlertFn"],
    });

    const stats = await runExecutiveMonitorBatch(env, deps);

    // e1's createAlert threw → counted as an error, but e2 was still handled.
    expect(stats.executives_processed).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.alerts_created).toBe(1);
    expect(createAlertFn).toHaveBeenCalledTimes(2);
  });

  it("isolates an isDuplicateAlert() throw on one exec — the batch continues", async () => {
    let dupCall = 0;
    const deps = mkDeps({
      loadExecutives: async () => [exec("e1"), exec("e2")],
      scan: async (e) => [candidate({ execId: e.id })],
      isDuplicateAlert: async () => {
        dupCall += 1;
        if (dupCall === 1) throw new Error("D1_ERROR: transient read failure");
        return false;
      },
    });

    const stats = await runExecutiveMonitorBatch(env, deps);
    expect(stats.executives_processed).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.alerts_created).toBe(1);
  });
});

// ─── resolveAlertUserForOrg — locks the org_members join ─────────
describe("resolveAlertUserForOrg", () => {
  // Fake D1 for the org_members routing query: returns the seeded user for
  // the bound org_id, null otherwise.
  function mkOrgEnv(byOrg: Record<number, string | null>): Env {
    const db = {
      prepare(_sql: string) {
        return {
          _bound: [] as unknown[],
          bind(...args: unknown[]) {
            this._bound = args;
            return this;
          },
          async first<T>() {
            const orgId = this._bound[0] as number;
            const uid = byOrg[orgId] ?? null;
            return (uid ? { user_id: uid } : null) as T;
          },
        };
      },
    };
    return { DB: db as unknown as D1Database } as unknown as Env;
  }

  it("returns a user belonging to the requested org (org A), never another org (org B)", async () => {
    const env2 = mkOrgEnv({ 1: "userA-owner", 2: "userB-owner" });
    expect(await resolveAlertUserForOrg(env2, 1)).toBe("userA-owner");
    expect(await resolveAlertUserForOrg(env2, 2)).toBe("userB-owner");
  });

  it("returns null when the org has no active member (→ caller drops, no cross-org fallback)", async () => {
    const env2 = mkOrgEnv({ 1: "userA-owner" });
    expect(await resolveAlertUserForOrg(env2, 99)).toBeNull();
  });
});

// ─── FIX 4 regression: wrap-around SELECT must carry org_id ──────
// When the registry exceeds EXEC_BATCH_LIMIT and the cursor is past the
// tail, execs are pulled via the wrap-around top-up query. That fill SELECT
// previously omitted org_id, so wrapped execs got org_id === undefined →
// resolved to no in-org user → were silently dropped. Assert the fill path
// carries org_id.
describe("loadActiveExecutivesRotating — wrap-around carries org_id (FIX 4)", () => {
  // Fake D1 + KV. Cursor is 'zzz' (past every id), so the primary
  // (id > cursor) query returns nothing and the fill (no id filter) query
  // returns the registry — the wrap path under test.
  function mkRotationEnv(rows: ExecutiveBatchRow[], cursor: string) {
    const kv = new Map<string, string>([["exec_monitor:rotation_cursor", cursor]]);
    const db = {
      prepare(sql: string) {
        const isPrimary = sql.includes("id > ?"); // primary = id > cursor
        return {
          bind(..._b: unknown[]) {
            return this;
          },
          async all<T>() {
            // Primary returns nothing (cursor past end); fill returns all.
            if (isPrimary) return { results: [] as T[] };
            return { results: rows as unknown as T[] };
          },
        };
      },
    };
    const env2 = {
      DB: db as unknown as D1Database,
      CACHE: {
        async get(k: string) {
          return kv.get(k) ?? null;
        },
        async put(k: string, v: string) {
          kv.set(k, v);
        },
      },
    } as unknown as Env;
    return env2;
  }

  it("wrapped execs retain org_id (not undefined) so they route to their org", async () => {
    const rows: ExecutiveBatchRow[] = [
      {
        id: "e-wrap-1",
        brand_id: "brand-x",
        org_id: 7,
        full_name: "Wrap One",
        official_handles: null,
        watch_platforms: null,
      },
    ];
    const env2 = mkRotationEnv(rows, "zzz");

    const loaded = await loadActiveExecutivesRotating(env2, 10);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.org_id).toBe(7);
    expect(loaded[0]!.org_id).not.toBeUndefined();
  });
});
