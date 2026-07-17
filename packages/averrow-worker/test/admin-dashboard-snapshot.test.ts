/**
 * Tests for handlers/admin.ts — handleAdminDashboard (GET /api/admin/dashboard).
 *
 * Tier 2a P5. Locks the two load-bearing properties of the composite
 * snapshot:
 *   1. A partial-failure slice degrades to `null` — never a thrown 500.
 *      The frontend treats a null slice as "unknown", never "healthy".
 *   2. Independently-nullable composition: slices whose source is warm
 *      populate and shape correctly while slices whose source fails go
 *      null, in the SAME response.
 *
 * Each sub-handler is KV-cache-first (checks its own cache key before
 * touching D1), so we pre-warm specific sub-caches with canned bodies
 * and leave env.DB throwing — the composite then reads the warm slices
 * from KV and null-degrades the ones that fall through to the throwing
 * D1. This exercises the real shaping code without re-mocking every
 * sub-handler's full query set.
 */

import { describe, it, expect } from "vitest";
import { handleAdminDashboard } from "../src/handlers/admin";
import type { Env, UserRole } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";

/** Minimal AuthContext for the composite's RBAC branch. Only `role` is
 *  read by handleAdminDashboard; the rest satisfy the interface. */
function ctxWithRole(role: UserRole): AuthContext {
  return {
    userId: "usr_test",
    email: "test@averrow.com",
    role,
    orgId: null,
    orgRole: null,
    embeddedScope: undefined,
    enrollOnly: false,
  };
}
const superAdminCtx = () => ctxWithRole("super_admin");
const adminCtx = () => ctxWithRole("admin");

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

/** A prepared-statement stub whose every terminal (.first/.all/.run)
 *  rejects ASYNCHRONOUSLY. Rejecting from the terminal rather than
 *  throwing synchronously from .prepare() matters: it lets a
 *  sub-handler's `Promise.all([...])` array finish constructing (so
 *  every element is a real promise Promise.all attaches a handler to)
 *  before the rejections land — otherwise a mid-array synchronous throw
 *  orphans the already-created sibling promises into unhandled
 *  rejections. Models a D1 outage: reads fail, endpoint must not 500. */
function rejectingStmt() {
  const stmt = {
    bind: () => stmt,
    first: () => Promise.reject(new Error("D1 unavailable")),
    all: () => Promise.reject(new Error("D1 unavailable")),
    run: () => Promise.reject(new Error("D1 unavailable")),
  };
  return stmt;
}

/** env whose every D1 access fails — models a full outage so every
 *  slice must degrade to null (and the endpoint must NOT 500). */
function makeThrowingEnv(kv: MockKV): Env {
  const failingDb = {
    prepare: () => rejectingStmt(),
    withSession: () => ({ prepare: () => rejectingStmt() }),
  };
  return {
    DB: failingDb,
    CACHE: kv,
    AUDIT_DB: { prepare: () => rejectingStmt() },
    // Undefined admin key → fetchAnthropicUsageReport short-circuits to 0
    // with no network call.
  } as unknown as Env;
}

function req(): Request {
  return new Request("https://averrow.com/api/admin/dashboard", {
    headers: { Origin: "https://averrow.com" },
  });
}

interface SnapshotBody {
  success: boolean;
  data: {
    threat_health: unknown | null;
    budget: unknown | null;
    feeds: {
      at_risk_count: number;
      at_risk: Array<{
        feed_name: string;
        severity: "critical" | "high";
        verdict: { label: string };
        paused_reason: string | null;
      }>;
      totals_24h: unknown;
    } | null;
    pipeline: {
      worst_tone: string;
      needs_attention_count: number;
      total_pipelines: number;
      concerning: Array<{ id: string; severity: "critical" | "warning" }>;
    } | null;
    email_security: unknown | null;
    generated_at: string;
  };
}

async function bodyOf(res: Response): Promise<SnapshotBody> {
  return res.json() as Promise<SnapshotBody>;
}

describe("handleAdminDashboard — partial failure degrades to null, never 500", () => {
  it("returns 200 with every slice null when all sources fail", async () => {
    const kv = new MockKV();
    const env = makeThrowingEnv(kv);

    const res = await handleAdminDashboard(req(), env, superAdminCtx());
    expect(res.status).toBe(200);

    const body = await bodyOf(res);
    expect(body.success).toBe(true);
    expect(body.data.threat_health).toBeNull();
    expect(body.data.budget).toBeNull();
    expect(body.data.feeds).toBeNull();
    expect(body.data.pipeline).toBeNull();
    expect(body.data.email_security).toBeNull();
    expect(typeof body.data.generated_at).toBe("string");
  });

  it("caches the composite under a role-scoped key (super_admin → :sa)", async () => {
    const kv = new MockKV();
    const env = makeThrowingEnv(kv);
    await handleAdminDashboard(req(), env, superAdminCtx());
    expect(kv.store.has("admin:dashboard_snapshot:v1:sa")).toBe(true);
  });

  it("serves the cached composite on a warm hit without touching D1", async () => {
    const kv = new MockKV();
    const canned = {
      success: true,
      data: {
        threat_health: null,
        budget: null,
        feeds: null,
        pipeline: null,
        email_security: null,
        generated_at: "2026-07-11T00:00:00.000Z",
      },
    };
    kv.store.set("admin:dashboard_snapshot:v1:sa", JSON.stringify(canned));
    const env = makeThrowingEnv(kv); // DB throws if ever touched

    const res = await handleAdminDashboard(req(), env, superAdminCtx());
    const body = await bodyOf(res);
    expect(body.data.generated_at).toBe("2026-07-11T00:00:00.000Z");
  });
});

describe("handleAdminDashboard — independent nullability: warm slices populate, failing slices go null", () => {
  it("shapes threat_health/feeds/pipeline from warm sub-caches while budget/email null-degrade", async () => {
    const kv = new MockKV();

    // Pre-warm the three sub-handler caches the composite reads. Each
    // sub-handler returns json(JSON.parse(cached)) on a hit and never
    // touches D1 — so a throwing env.DB is safe for these slices.
    kv.store.set(
      "system_health",
      JSON.stringify({
        success: true,
        data: {
          threats: { total: 694_321, today: 40, week: 900 },
          agents: { total: 229, successes: 220, errors: 9 },
          feeds: { pulls: 266, ingested: 6245 },
          sessions: { count: 94 },
          migrations: { total: 45, last_run: null, last_name: null },
          audit: { count: 283 },
          trend: [{ day: "2026-07-10", count: 100 }],
          infrastructure: {},
        },
      }),
    );

    kv.store.set(
      "pipeline_status_v4",
      JSON.stringify({
        success: true,
        data: [
          { id: "geo", label: "Geo Enrichment", verdict: { tone: "failed", label: "GROWING" }, trend_direction: "up", count: 1200 },
          { id: "dns", label: "DNS Resolution", verdict: { tone: "success", label: "DRAINING" }, trend_direction: "down", count: 30 },
          { id: "classify", label: "Classification", verdict: { tone: "inactive", label: "STEADY" }, trend_direction: "flat", count: 5 },
        ],
      }),
    );

    kv.store.set(
      "metrics_feed_failures:v2",
      JSON.stringify({
        success: true,
        data: {
          totals_24h: { total_pulls: 100, total_success: 80, total_failed: 20, total_records: 5000, feeds_active: 12 },
          per_feed: [
            { feed_name: "greynoise", display_name: "GreyNoise", enabled: true, pulls: 30, paused_reason: null, failure_rate_pct: 90, pct_to_auto_pause: 80, verdict: { tone: "failed", label: "AT RISK" } },
            { feed_name: "abusech", display_name: "abuse.ch", enabled: true, pulls: 25, paused_reason: null, failure_rate_pct: 40, pct_to_auto_pause: 20, verdict: { tone: "failed", label: "CRITICAL" } },
            // Auto-paused from consecutive failures — enabled=0 but MUST
            // still escalate (this is the "OPERATIONAL while a feed is dead"
            // guard the VerdictBand exists to prevent).
            { feed_name: "certstream", display_name: "CertStream", enabled: false, pulls: 0, paused_reason: "auto:consecutive_failures", failure_rate_pct: 0, pct_to_auto_pause: 100, verdict: { tone: "inactive", label: "PAUSED" } },
            // Manually disabled by an operator — NOT a health signal.
            { feed_name: "manualoff", display_name: "Manual Off", enabled: false, pulls: 0, paused_reason: "operator: seasonal", failure_rate_pct: 0, pct_to_auto_pause: 0, verdict: { tone: "inactive", label: "PAUSED" } },
            { feed_name: "openphish", display_name: "OpenPhish", enabled: true, pulls: 40, paused_reason: null, failure_rate_pct: 0, pct_to_auto_pause: 0, verdict: { tone: "success", label: "HEALTHY" } },
          ],
          recent_errors: [],
          generated_at: "2026-07-11T00:00:00.000Z",
        },
      }),
    );

    const env = makeThrowingEnv(kv); // budget + email fall through to throwing D1

    const res = await handleAdminDashboard(req(), env, superAdminCtx());
    expect(res.status).toBe(200);
    const body = await bodyOf(res);

    // Warm slices populated + shaped.
    expect(body.data.threat_health).toEqual({
      threats: { total: 694_321, today: 40, week: 900 },
      agents_24h: { total: 229, successes: 220, errors: 9 },
      feeds_24h: { pulls: 266, ingested: 6245 },
      active_sessions: 94,
      trend_14d: [{ day: "2026-07-10", count: 100 }],
    });

    // Feeds: three signals survive the at-risk tiering —
    //   greynoise (pct_to_auto_pause 80)   → critical
    //   certstream (auto:consecutive_failures, enabled=0) → critical
    //   abusech (failure_rate 40, pulls>=10) → high
    // HEALTHY (openphish) and the MANUALLY-disabled feed (manualoff) are
    // both dropped — a deliberate operator pause is not a health signal.
    expect(body.data.feeds).not.toBeNull();
    expect(body.data.feeds!.at_risk_count).toBe(3);
    const byName = new Map(body.data.feeds!.at_risk.map((f) => [f.feed_name, f]));
    expect(byName.get("greynoise")!.severity).toBe("critical");
    expect(byName.get("abusech")!.severity).toBe("high");
    // The auto-paused (dead) feed must appear, marked critical.
    expect(byName.get("certstream")!.severity).toBe("critical");
    expect(byName.get("certstream")!.paused_reason).toBe("auto:consecutive_failures");
    // Healthy + manually-disabled feeds excluded.
    expect(byName.has("openphish")).toBe(false);
    expect(byName.has("manualoff")).toBe(false);
    // Critical rows sort ahead of high rows (20-cap keeps the worst).
    expect(body.data.feeds!.at_risk[body.data.feeds!.at_risk.length - 1].feed_name).toBe("abusech");

    // Pipeline: one GROWING (tone failed) → worst_tone critical, 1 needs-attention.
    expect(body.data.pipeline).not.toBeNull();
    expect(body.data.pipeline!.total_pipelines).toBe(3);
    expect(body.data.pipeline!.worst_tone).toBe("critical");
    expect(body.data.pipeline!.needs_attention_count).toBe(1);
    expect(body.data.pipeline!.concerning.map((p) => p.id)).toEqual(["geo"]);
    expect(body.data.pipeline!.concerning[0].severity).toBe("critical");

    // Failing sources → null, in the SAME response.
    expect(body.data.budget).toBeNull();
    expect(body.data.email_security).toBeNull();
  });
});

describe("handleAdminDashboard — pipeline worst_tone: benign GeoIP must not degrade the band", () => {
  function warmPipeline(kv: MockKV, pipes: unknown[]): void {
    kv.store.set("pipeline_status_v4", JSON.stringify({ success: true, data: pipes }));
  }

  it("benign GeoIP SETUP (unconfigured reference dataset) keeps worst_tone ok", async () => {
    const kv = new MockKV();
    // GeoIP is an OPTIONAL binding — a permanently-unconfigured dataset
    // emits tone 'pending' / label 'SETUP'. All real backlogs are healthy.
    warmPipeline(kv, [
      { id: "geoip", label: "GeoIP Database", verdict: { tone: "pending", label: "SETUP" }, trend_direction: "unknown", count: 0 },
      { id: "geo", label: "Geo Enrichment", verdict: { tone: "success", label: "DRAINING" }, trend_direction: "down", count: 10 },
      { id: "dns", label: "DNS Resolution", verdict: { tone: "inactive", label: "STEADY" }, trend_direction: "flat", count: 3 },
    ]);
    const env = makeThrowingEnv(kv);

    const body = await bodyOf(await handleAdminDashboard(req(), env, superAdminCtx()));
    expect(body.data.pipeline).not.toBeNull();
    // Pre-fix bug: tones.has('pending') → worst_tone 'warning' forever.
    expect(body.data.pipeline!.worst_tone).toBe("ok");
    expect(body.data.pipeline!.needs_attention_count).toBe(0);
    expect(body.data.pipeline!.concerning.length).toBe(0);
    expect(body.data.pipeline!.total_pipelines).toBe(3);
  });

  it("GeoIP STALE 7-14d (tone pending) is benign — worst_tone stays ok", async () => {
    const kv = new MockKV();
    warmPipeline(kv, [
      { id: "geoip", label: "GeoIP Database", verdict: { tone: "pending", label: "STALE" }, trend_direction: "flat", count: 3_760_000 },
    ]);
    const env = makeThrowingEnv(kv);
    const body = await bodyOf(await handleAdminDashboard(req(), env, superAdminCtx()));
    expect(body.data.pipeline!.worst_tone).toBe("ok");
    expect(body.data.pipeline!.needs_attention_count).toBe(0);
  });

  it("genuinely EMPTY GeoIP (tone failed) IS a signal — critical", async () => {
    const kv = new MockKV();
    warmPipeline(kv, [
      { id: "geoip", label: "GeoIP Database", verdict: { tone: "failed", label: "EMPTY" }, trend_direction: "flat", count: 0 },
    ]);
    const env = makeThrowingEnv(kv);
    const body = await bodyOf(await handleAdminDashboard(req(), env, superAdminCtx()));
    expect(body.data.pipeline!.worst_tone).toBe("critical");
    expect(body.data.pipeline!.needs_attention_count).toBe(1);
    expect(body.data.pipeline!.concerning[0].id).toBe("geoip");
    expect(body.data.pipeline!.concerning[0].severity).toBe("critical");
  });

  it("a REAL backlog STALE (tone pending, non-reference) still degrades to warning", async () => {
    const kv = new MockKV();
    warmPipeline(kv, [
      { id: "geo", label: "Geo Enrichment", verdict: { tone: "pending", label: "STALE" }, trend_direction: "unknown", count: 500 },
    ]);
    const env = makeThrowingEnv(kv);
    const body = await bodyOf(await handleAdminDashboard(req(), env, superAdminCtx()));
    expect(body.data.pipeline!.worst_tone).toBe("warning");
    expect(body.data.pipeline!.needs_attention_count).toBe(1);
    expect(body.data.pipeline!.concerning[0].severity).toBe("warning");
  });
});

describe("handleBudgetConfigPatch — busts both dashboard snapshot cache keys", () => {
  it("deletes :sa and :admin snapshot entries on a successful config patch", async () => {
    const { handleBudgetConfigPatch } = await import("../src/handlers/budget");
    const kv = new MockKV();
    // Seed both role-scoped snapshots as if warmed by prior loads.
    kv.store.set("admin:dashboard_snapshot:v1:sa", JSON.stringify({ success: true, data: {} }));
    kv.store.set("admin:dashboard_snapshot:v1:admin", JSON.stringify({ success: true, data: {} }));

    // Minimal DB stub: budget config UPDATE .run() succeeds, config SELECT
    // .first() returns a row. Only updateConfig's statements are exercised.
    const okStmt = {
      bind() { return this; },
      run() { return Promise.resolve({ success: true }); },
      first() { return Promise.resolve({ monthly_limit_usd: 500, soft_pct: 70, hard_pct: 85, emergency_pct: 95 }); },
      all() { return Promise.resolve({ results: [] }); },
    };
    const env = {
      DB: { prepare: () => okStmt },
      CACHE: kv,
    } as unknown as Env;

    const patchReq = new Request("https://averrow.com/api/admin/budget/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "https://averrow.com" },
      body: JSON.stringify({ monthly_limit_usd: 500 }),
    });

    const res = await handleBudgetConfigPatch(patchReq, env);
    expect(res.status).toBe(200);
    // Both snapshot keys must be gone so the next dashboard load recomputes.
    expect(kv.store.has("admin:dashboard_snapshot:v1:sa")).toBe(false);
    expect(kv.store.has("admin:dashboard_snapshot:v1:admin")).toBe(false);
  });
});

describe("handleAdminDashboard — RBAC: threat_health is super_admin-only", () => {
  /** Pre-warm the three sub-caches that the composite reads on a hit
   *  (system_health / pipeline / feeds). Budget + email fall through to
   *  the throwing D1 in both role cases, so they null-degrade identically
   *  and don't confound the role comparison. */
  function warmSlices(kv: MockKV): void {
    kv.store.set(
      "system_health",
      JSON.stringify({
        success: true,
        data: {
          threats: { total: 100, today: 5, week: 20 },
          agents: { total: 10, successes: 9, errors: 1 },
          feeds: { pulls: 12, ingested: 300 },
          sessions: { count: 3 },
          trend: [{ day: "2026-07-10", count: 7 }],
        },
      }),
    );
    kv.store.set(
      "pipeline_status_v4",
      JSON.stringify({
        success: true,
        data: [
          { id: "geo", label: "Geo Enrichment", verdict: { tone: "failed", label: "GROWING" }, trend_direction: "up", count: 42 },
        ],
      }),
    );
    kv.store.set(
      "metrics_feed_failures:v2",
      JSON.stringify({
        success: true,
        data: {
          totals_24h: { total_pulls: 10, total_success: 8, total_failed: 2, feeds_active: 4 },
          per_feed: [
            { feed_name: "greynoise", display_name: "GreyNoise", enabled: true, pulls: 30, paused_reason: null, failure_rate_pct: 90, pct_to_auto_pause: 80, verdict: { tone: "failed", label: "AT RISK" } },
          ],
        },
      }),
    );
  }

  it("super_admin: threat_health is populated (and cached under :sa)", async () => {
    const kv = new MockKV();
    warmSlices(kv);
    const env = makeThrowingEnv(kv);

    const res = await handleAdminDashboard(req(), env, superAdminCtx());
    expect(res.status).toBe(200);
    const body = await bodyOf(res);

    expect(body.data.threat_health).toEqual({
      threats: { total: 100, today: 5, week: 20 },
      agents_24h: { total: 10, successes: 9, errors: 1 },
      feeds_24h: { pulls: 12, ingested: 300 },
      active_sessions: 3,
      trend_14d: [{ day: "2026-07-10", count: 7 }],
    });
    // The four requireAdmin-boundary slices are unaffected by the gate.
    expect(body.data.feeds).not.toBeNull();
    expect(body.data.pipeline).not.toBeNull();

    expect(kv.store.has("admin:dashboard_snapshot:v1:sa")).toBe(true);
    expect(kv.store.has("admin:dashboard_snapshot:v1:admin")).toBe(false);
  });

  it("plain admin: threat_health is null even with a warm system_health cache; other slices still populate", async () => {
    const kv = new MockKV();
    warmSlices(kv);
    const env = makeThrowingEnv(kv);

    const res = await handleAdminDashboard(req(), env, adminCtx());
    expect(res.status).toBe(200);
    const body = await bodyOf(res);

    // The boundary: a plain admin never receives threat_health, even though
    // its source cache is warm and would have populated it for super_admin.
    expect(body.data.threat_health).toBeNull();

    // The four requireAdmin / requireStaff slices are unchanged for admins.
    expect(body.data.feeds).not.toBeNull();
    expect(body.data.feeds!.at_risk_count).toBe(1);
    expect(body.data.pipeline).not.toBeNull();
    expect(body.data.pipeline!.total_pipelines).toBe(1);

    // Admins cache under a distinct key — no cross-role leakage.
    expect(kv.store.has("admin:dashboard_snapshot:v1:admin")).toBe(true);
    expect(kv.store.has("admin:dashboard_snapshot:v1:sa")).toBe(false);
  });

  it("cache isolation: a super_admin-warmed cache is never served to a plain admin", async () => {
    const kv = new MockKV();
    // Simulate a super_admin having already populated the snapshot with a
    // threat_health slice under the :sa key.
    kv.store.set(
      "admin:dashboard_snapshot:v1:sa",
      JSON.stringify({
        success: true,
        data: {
          threat_health: { threats: { total: 1, today: 1, week: 1 }, agents_24h: { total: 0, successes: 0, errors: 0 }, feeds_24h: { pulls: 0, ingested: 0 }, active_sessions: 0, trend_14d: [] },
          budget: null, feeds: null, pipeline: null, email_security: null,
          generated_at: "2026-07-11T00:00:00.000Z",
        },
      }),
    );
    const env = makeThrowingEnv(kv);

    const res = await handleAdminDashboard(req(), env, adminCtx());
    const body = await bodyOf(res);
    // The admin computed a fresh snapshot under :admin — it did NOT read the
    // super_admin's :sa entry, so no threat_health leaked.
    expect(body.data.threat_health).toBeNull();
    expect(body.data.generated_at).not.toBe("2026-07-11T00:00:00.000Z");
  });
});
