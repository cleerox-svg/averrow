// Internal-secret mirrors of the IdP backfills + the allowlisted index
// ANALYZE (POST /api/internal/backfills/idp-impersonation,
// /api/internal/backfills/idp-lure-topup, /api/internal/db/analyze).
//
// Exercised through the real Worker entry (src/index.ts `fetch`), so the
// route wiring, the S3.2 blanket internal-POST guard and each route's own
// timingSafeBearerEq check are all under test — not just the handlers.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class extends Error {} }));
vi.mock("../src/handlers/admin/idpBackfill", async (orig) => {
  const m = await orig<typeof import("../src/handlers/admin/idpBackfill")>();
  return {
    ...m,
    runIdpImpersonationBackfill: vi.fn(m.runIdpImpersonationBackfill),
    runIdpLureTopupBackfill: vi.fn(m.runIdpLureTopupBackfill),
  };
});

import worker from "../src/index";
import {
  runIdpImpersonationBackfill,
  runIdpLureTopupBackfill,
  handleBackfillIdpImpersonation,
  INTERNAL_BACKFILL_ACTOR,
  IDP_BACKFILL_THREAT_CURSOR_KEY,
  IDP_BACKFILL_LOOKALIKE_CURSOR_KEY,
  IDP_LURE_TOPUP_CURSOR_KEY,
} from "../src/handlers/admin/idpBackfill";
import { ANALYZE_TARGETS, ANALYZE_COOLDOWN_S, analyzeCooldownKey, isAnalyzeTable } from "../src/handlers/admin/dbAnalyze";

const SECRET = "test-internal-secret";
const BASE = "https://averrow.com";
const PATHS = [
  "/api/internal/backfills/idp-impersonation",
  "/api/internal/backfills/idp-lure-topup",
  "/api/internal/db/analyze?table=lookalike_domains",
] as const;

interface AuditRow { userId: unknown; action: unknown; details: Record<string, unknown>; outcome: unknown }

function makeEnv(opts: { failDb?: boolean } = {}) {
  const kv = new Map<string, string>([
    [IDP_BACKFILL_THREAT_CURSOR_KEY, "10"], [IDP_BACKFILL_LOOKALIKE_CURSOR_KEY, "20"], [IDP_LURE_TOPUP_CURSOR_KEY, "30"],
  ]);
  const audits: AuditRow[] = [];
  const sql: string[] = [];
  const env = {
    AVERROW_INTERNAL_SECRET: SECRET,
    CACHE: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => { kv.set(k, v); },
      delete: async (k: string) => { kv.delete(k); },
    },
    AUDIT_DB: {
      prepare: () => ({
        bind: (...a: unknown[]) => ({
          run: async () => {
            audits.push({ userId: a[1], action: a[2], details: JSON.parse(String(a[5] ?? "{}")) as Record<string, unknown>, outcome: a[8] });
          },
        }),
      }),
    },
    DB: {
      prepare: (s: string) => {
        sql.push(s);
        const stmt = {
          bind: () => stmt,
          all: async () => {
            if (opts.failDb) throw new Error("D1_ERROR: secret detail");
            return { results: [] };
          },
          run: async () => {
            if (opts.failDb) throw new Error("D1_ERROR: secret detail");
            return { success: true, meta: { rows_read: 3, rows_written: 1 } };
          },
        };
        return stmt;
      },
      batch: async () => [],
    },
  } as unknown as Env;
  return { env, kv, audits, sql };
}

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function call(path: string, init: { method?: string; auth?: string | null } = {}, env = makeEnv().env): Promise<Response> {
  const headers = new Headers();
  if (init.auth !== null) headers.set("Authorization", init.auth ?? `Bearer ${SECRET}`);
  return worker.fetch(new Request(`${BASE}${path}`, { method: init.method ?? "POST", headers }), env, execCtx);
}

beforeEach(() => {
  vi.mocked(runIdpImpersonationBackfill).mockClear();
  vi.mocked(runIdpLureTopupBackfill).mockClear();
});

describe("internal IdP maintenance routes — auth", () => {
  for (const path of PATHS) {
    it(`${path}: missing secret → 401`, async () => {
      const h = makeEnv();
      const res = await call(path, { auth: null }, h.env);
      expect(res.status).toBe(401);
      expect(h.sql).toEqual([]);
      expect(h.audits).toEqual([]);
    }, 60_000);

    it(`${path}: wrong secret → 401`, async () => {
      const h = makeEnv();
      expect((await call(path, { auth: "Bearer nope" }, h.env)).status).toBe(401);
      expect((await call(path, { auth: SECRET }, h.env)).status).toBe(401); // no Bearer prefix
      expect(h.sql).toEqual([]);
    }, 60_000);

    it(`${path}: GET never runs the mutation (401 unauthenticated, 404 authenticated)`, async () => {
      const h = makeEnv();
      expect((await call(path, { method: "GET", auth: null }, h.env)).status).toBe(401);
      expect((await call(path, { method: "GET" }, h.env)).status).toBe(404);
      expect(h.sql).toEqual([]);
      expect(h.audits).toEqual([]);
    }, 60_000);
  }

  it("an unset AVERROW_INTERNAL_SECRET fails closed", async () => {
    const h = makeEnv();
    (h.env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET = undefined;
    const res = await call("/api/internal/backfills/idp-impersonation", { auth: "Bearer undefined" }, h.env);
    expect(res.status).toBe(401);
  }, 60_000);
});

describe("internal IdP backfills — happy path", () => {
  it("idp-impersonation calls the shared core with the internal actor and audits it", async () => {
    const h = makeEnv();
    const res = await call("/api/internal/backfills/idp-impersonation?limit=5000", {}, h.env);
    expect(res.status).toBe(200);
    expect(runIdpImpersonationBackfill).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runIdpImpersonationBackfill).mock.calls[0]![2]).toEqual(INTERNAL_BACKFILL_ACTOR);
    expect(h.audits.map((a) => a.action)).toEqual(["backfill_idp_impersonation_started", "backfill_idp_impersonation"]);
    for (const a of h.audits) {
      expect(a.userId).toBeNull();
      expect(a.details.actor).toBe("internal");
    }
    expect(h.audits[0]!.details.limit).toBe(1000); // same cap as the admin route
  }, 60_000);

  it("idp-lure-topup calls the shared core with the internal actor; brands capped at 200", async () => {
    const h = makeEnv();
    const res = await call("/api/internal/backfills/idp-lure-topup?brands=999", {}, h.env);
    expect(res.status).toBe(200);
    expect(vi.mocked(runIdpLureTopupBackfill).mock.calls[0]![2]).toEqual(INTERNAL_BACKFILL_ACTOR);
    expect(h.audits[0]!.details).toMatchObject({ actor: "internal", brands: 200 });
  }, 60_000);

  it("?reset=1 clears only that route's cursors and audits as internal", async () => {
    const h = makeEnv();
    const res = await call("/api/internal/backfills/idp-lure-topup?reset=1", {}, h.env);
    expect(((await res.json()) as { data: { reset: boolean } }).data.reset).toBe(true);
    expect(h.kv.has(IDP_LURE_TOPUP_CURSOR_KEY)).toBe(false);
    expect(h.kv.get(IDP_BACKFILL_THREAT_CURSOR_KEY)).toBe("10");
    expect(h.audits).toEqual([
      { userId: null, action: "backfill_idp_lure_topup_reset", details: { actor: "internal", cursor_keys: [IDP_LURE_TOPUP_CURSOR_KEY] }, outcome: "success" },
    ]);
  }, 60_000);

  it("a failing core on the internal route → generic 500 + failure audit with the detail", async () => {
    const h = makeEnv({ failDb: true });
    const res = await call("/api/internal/backfills/idp-impersonation", {}, h.env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: "An internal error occurred" });
    expect(h.audits.map((a) => [a.action, a.outcome, a.userId, a.details.actor])).toEqual([
      ["backfill_idp_impersonation_started", "success", null, "internal"],
      ["backfill_idp_impersonation", "failure", null, "internal"],
    ]);
    expect(h.audits[1]!.details.error).toBe("D1_ERROR: secret detail");
  }, 60_000);

  it("the admin route is distinguishable: user_id + actor user:<id>", async () => {
    const h = makeEnv();
    const res = await handleBackfillIdpImpersonation(
      new Request(`${BASE}/api/admin/backfills/idp-impersonation?limit=5`, { method: "POST" }), h.env, { userId: "u_admin" } as AuthContext,
    );
    expect(res.status).toBe(200);
    for (const a of h.audits) {
      expect(a.userId).toBe("u_admin");
      expect(a.details.actor).toBe("user:u_admin");
    }
  });
});

describe("internal db/analyze", () => {
  for (const q of ["", "?table=brands", "?table=sqlite_master", "?table=threats;DROP%20TABLE%20threats", "?table=THREATS", "?table=__proto__", "?table=toString"]) {
    it(`rejects non-allowlisted table (${q || "missing"}) → 400 without touching D1`, async () => {
      const h = makeEnv();
      const res = await call(`/api/internal/db/analyze${q}`, {}, h.env);
      expect(res.status).toBe(400);
      expect(h.sql).toEqual([]);
    }, 60_000);
  }

  it("runs the fixed index-scoped statement and audits as internal", async () => {
    const h = makeEnv();
    const res = await call("/api/internal/db/analyze?table=lookalike_domains", {}, h.env);
    expect(res.status).toBe(200);
    expect(h.sql).toEqual(["ANALYZE idx_lookalike_idp_lure_live"]);
    const body = (await res.json()) as { data: { index: string; rows_read: number } };
    expect(body.data).toMatchObject({ index: "idx_lookalike_idp_lure_live", rows_read: 3 });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ userId: null, action: "db_analyze", details: { actor: "internal", table: "lookalike_domains" } });

    const h2 = makeEnv();
    await call("/api/internal/db/analyze?table=threats", {}, h2.env);
    expect(h2.sql).toEqual(["ANALYZE idx_threats_technique_created"]);
  }, 60_000);

  it("failure → generic 500; the real message lives only in the audit row; no cooldown set", async () => {
    const h = makeEnv({ failDb: true });
    const res = await call("/api/internal/db/analyze?table=threats", {}, h.env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: "An internal error occurred" });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      userId: null, action: "db_analyze", outcome: "failure",
      details: { actor: "internal", table: "threats", error: "D1_ERROR: secret detail" },
    });
    expect(h.kv.has(analyzeCooldownKey("threats"))).toBe(false);
  }, 60_000);

  it("one successful ANALYZE per table per hour: second call → 429 without touching D1", async () => {
    const h = makeEnv();
    expect((await call("/api/internal/db/analyze?table=threats", {}, h.env)).status).toBe(200);
    expect(h.sql).toHaveLength(1);
    const res = await call("/api/internal/db/analyze?table=threats", {}, h.env);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { success: boolean; error: string; retry_after_s: number };
    expect(body).toMatchObject({ success: false, error: "cooldown" });
    expect(body.retry_after_s).toBeGreaterThan(0);
    expect(body.retry_after_s).toBeLessThanOrEqual(ANALYZE_COOLDOWN_S);
    expect(h.sql).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
    // Per table: the other table is not on cooldown.
    expect((await call("/api/internal/db/analyze?table=lookalike_domains", {}, h.env)).status).toBe(200);
    // An expired stamp no longer blocks.
    h.kv.set(analyzeCooldownKey("threats"), String(Date.now() - 1));
    expect((await call("/api/internal/db/analyze?table=threats", {}, h.env)).status).toBe(200);
  }, 60_000);

  it("isAnalyzeTable ignores inherited keys", () => {
    expect(isAnalyzeTable("threats")).toBe(true);
    expect(isAnalyzeTable("constructor")).toBe(false);
    expect(isAnalyzeTable(null)).toBe(false);
  });

  it("each statement is valid SQLite and refreshes ONLY its index's stats (real SQLite)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    // Index definitions copied from migrations/0288_idp_impersonation.sql,
    // plus a sibling index per table that must NOT be analyzed.
    db.exec(`
      CREATE TABLE threats (id TEXT PRIMARY KEY, technique TEXT, created_at TEXT, status TEXT);
      CREATE INDEX idx_threats_status ON threats(status);
      CREATE INDEX idx_threats_technique_created ON threats(technique, created_at);
      CREATE TABLE lookalike_domains (id TEXT PRIMARY KEY, brand_id TEXT, first_seen TEXT, idp_lure TEXT, registered INTEGER, status TEXT);
      CREATE INDEX idx_lookalike_brand ON lookalike_domains(brand_id);
      CREATE INDEX idx_lookalike_idp_lure_live ON lookalike_domains(first_seen)
        WHERE idp_lure IS NOT NULL AND registered = 1 AND status != 'benign';
    `);
    for (let i = 0; i < 50; i++) {
      db.prepare("INSERT INTO threats VALUES (?, ?, ?, 'active')").run(`t${i}`, i % 2 ? "idp_tenant_abuse" : null, `2026-10-0${i % 9 + 1}`);
      db.prepare("INSERT INTO lookalike_domains VALUES (?, 'b1', ?, ?, ?, 'monitoring')").run(`l${i}`, `2026-10-0${i % 9 + 1}`, i % 3 ? "okta" : null, i % 2);
    }
    for (const t of Object.values(ANALYZE_TARGETS)) db.exec(t.sql);
    const idx = (db.prepare("SELECT idx FROM sqlite_stat1 ORDER BY idx").all() as Array<{ idx: string }>).map((r) => r.idx);
    expect(idx).toEqual(["idx_lookalike_idp_lure_live", "idx_threats_technique_created"]);
    db.close();
  });
});
