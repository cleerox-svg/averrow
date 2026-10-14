// Observatory Phase B (B2) — takedown outcome rollup.
//
//   1. pure — classification (status / resolution), median, cell folding
//   2. real SQLite (migration-derived schema) — the writer builds the rolling
//      window, is idempotent (unchanged source → 0 writes), removes cells
//      whose key vanished and days that aged out of the window
//   3. EXPLAIN — the source read is a range on idx_takedown_submitted_at with
//      PK lookups into threats, never a scan of either table
//   4. cube_healer gate — the rollup runs on the UTC hour-0 (cold) tick only

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyTakedown,
  computeTakedownOutcomeCells,
  median,
  rollupWindowStartDay,
  runTakedownOutcomeRollup,
  TAKEDOWN_ROLLUP_SOURCE_SQL,
  type TakedownSourceRow,
} from "../src/lib/takedown-outcome-rollup";
import { cubeHealerAgent } from "../src/agents/cube-healer";
import { splitStatements } from "./migration-schema";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { AgentContext } from "../src/lib/agentRunner";
import type { Env } from "../src/types";

// ─── 1. Pure ──────────────────────────────────────────────────────────

describe("classifyTakedown", () => {
  it("resolution wins; status fallbacks for taken_down / expired; pending; dispatch-failed is not a refusal", () => {
    expect(classifyTakedown("taken_down", "taken_down")).toBe("taken_down");
    expect(classifyTakedown("taken_down", null)).toBe("taken_down");
    expect(classifyTakedown("failed", "refused")).toBe("refused");
    expect(classifyTakedown("expired", "expired")).toBe("expired");
    expect(classifyTakedown("expired", null)).toBe("expired");
    expect(classifyTakedown("submitted", null)).toBe("pending");
    expect(classifyTakedown("pending_response", null)).toBe("pending");
    // Sparrow / hand-submit dispatch error: status failed, NO resolution.
    expect(classifyTakedown("failed", null)).toBeNull();
    expect(classifyTakedown("withdrawn", "withdrawn")).toBeNull();
    expect(classifyTakedown("draft", null)).toBeNull();
  });
});

describe("median", () => {
  it("odd / even / empty, rounded to 2dp", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([1 / 3])).toBe(0.33);
  });
});

describe("computeTakedownOutcomeCells", () => {
  const row = (r: Partial<TakedownSourceRow>): TakedownSourceRow => ({
    submitted_at: "2026-10-10 10:00:00", resolved_at: null, status: "submitted", resolution: null,
    country_code: null, hosting_provider_id: null, ...r,
  });

  it("one cell per (day, dim, key); counts, median over taken_down only; unknown keys", () => {
    const cells = computeTakedownOutcomeCells([
      row({ status: "taken_down", resolution: "taken_down", resolved_at: "2026-10-10 14:00:00", country_code: "us", hosting_provider_id: "hp_1" }),
      row({ status: "taken_down", resolution: "taken_down", resolved_at: "2026-10-11 10:00:00", country_code: "US", hosting_provider_id: "hp_1" }),
      row({ status: "failed", resolution: "refused", resolved_at: "2026-10-10 12:00:00", country_code: "US", hosting_provider_id: "hp_2" }),
      row({ status: "pending_response", country_code: "XX" }),
      row({ submitted_at: "2026-10-09 23:59:59", status: "expired", resolution: "expired" }),
      row({ submitted_at: "garbage" }),
    ]);
    expect(cells).toEqual([
      { day: "2026-10-09", dim: "country", key: "unknown", submitted: 1, taken_down: 0, refused: 0, expired: 1, pending: 0, median_hours: null },
      { day: "2026-10-09", dim: "provider", key: "unknown", submitted: 1, taken_down: 0, refused: 0, expired: 1, pending: 0, median_hours: null },
      { day: "2026-10-10", dim: "country", key: "US", submitted: 3, taken_down: 2, refused: 1, expired: 0, pending: 0, median_hours: 14 },
      { day: "2026-10-10", dim: "country", key: "unknown", submitted: 1, taken_down: 0, refused: 0, expired: 0, pending: 1, median_hours: null },
      { day: "2026-10-10", dim: "provider", key: "hp_1", submitted: 2, taken_down: 2, refused: 0, expired: 0, pending: 0, median_hours: 14 },
      { day: "2026-10-10", dim: "provider", key: "hp_2", submitted: 1, taken_down: 0, refused: 1, expired: 0, pending: 0, median_hours: null },
      { day: "2026-10-10", dim: "provider", key: "unknown", submitted: 1, taken_down: 0, refused: 0, expired: 0, pending: 1, median_hours: null },
    ]);
  });

  it("a resolved_at before submitted_at never yields a negative duration", () => {
    const [c] = computeTakedownOutcomeCells([
      row({ status: "taken_down", resolution: "taken_down", resolved_at: "2026-10-09 10:00:00" }),
    ]);
    expect(c!.taken_down).toBe(1);
    expect(c!.median_hours).toBeNull();
  });

  it("window start = today and the previous 89 days (UTC)", () => {
    expect(rollupWindowStartDay(new Date("2026-10-14T00:12:00Z"))).toBe("2026-07-17");
    expect(rollupWindowStartDay(new Date("2026-10-14T23:59:00Z"), 30)).toBe("2026-09-15");
  });
});

// ─── 2. Real SQLite ───────────────────────────────────────────────────

let seq = 0;
function threat(raw: SqliteDb, cc: string | null, hp: string | null): string {
  const id = `thr_${++seq}`;
  raw.prepare(`INSERT INTO threats (id, created_at, status, country_code, hosting_provider_id, severity, threat_type,
      source_feed, malicious_url, malicious_domain, ioc_value)
    VALUES (?, '2026-10-01 00:00:00', 'active', ?, ?, 'high', 'phishing', 'phishtank', ?, ?, ?)`)
    .run(id, cc, hp, `https://${id}.x/`, `${id}.x`, `${id}.x`);
  return id;
}
function takedown(raw: SqliteDb, t: {
  submitted_at: string | null; status: string; resolution?: string | null; resolved_at?: string | null;
  source_type?: string | null; source_id?: string | null;
}): string {
  const id = `td_${++seq}`;
  raw.prepare(`INSERT INTO takedown_requests (id, brand_id, target_type, target_value, evidence_summary,
      source_type, source_id, status, resolution, submitted_at, resolved_at)
    VALUES (?, 'brand_1', 'domain', ?, 'evidence', ?, ?, ?, ?, ?, ?)`)
    .run(id, `${id}.x`, t.source_type ?? null, t.source_id ?? null, t.status, t.resolution ?? null,
      t.submitted_at, t.resolved_at ?? null);
  return id;
}
const rollupRows = (raw: SqliteDb) =>
  raw.prepare(`SELECT day, dim, key, submitted, taken_down, refused, expired, pending, median_hours
    FROM takedown_outcome_daily ORDER BY day, dim, key`).all();

function applyMigration(raw: SqliteDb, file: string): void {
  const sql = readFileSync(resolve(__dirname, `../migrations/${file}`), "utf-8");
  for (const stmt of splitStatements(sql)) {
    if (/^\s*CREATE INDEX/i.test(stmt)) raw.exec(stmt);
  }
}

describe.skipIf(!hasSqlite())("runTakedownOutcomeRollup — real SQLite", () => {
  const NOW = new Date("2026-10-14T00:12:00Z");

  it("builds the window, is idempotent, sweeps vanished keys and aged-out days", async () => {
    const raw = openDerivedDb(["takedown_requests", "threats", "takedown_outcome_daily"]);
    const env = { DB: d1FromSqlite(raw) } as unknown as Env;
    const t1 = threat(raw, "RU", "hp_ru");
    const t2 = threat(raw, null, null);
    takedown(raw, { submitted_at: "2026-10-10 08:00:00", status: "taken_down", resolution: "taken_down",
      resolved_at: "2026-10-10 20:00:00", source_type: "threat", source_id: t1 });
    takedown(raw, { submitted_at: "2026-10-10 09:00:00", status: "failed", resolution: "refused",
      resolved_at: "2026-10-11 09:00:00", source_type: "threat", source_id: t2 });
    // Not threat-sourced → unknown, even though the source_id matches a threat id.
    const lookalike = takedown(raw, { submitted_at: "2026-10-12 09:00:00", status: "submitted", source_type: "lookalike", source_id: t1 });
    takedown(raw, { submitted_at: null, status: "draft" });                           // never submitted
    takedown(raw, { submitted_at: "2026-06-01 00:00:00", status: "taken_down", resolution: "taken_down" }); // outside 90d
    // Pre-existing rows: one aged out, one whose key will not be recomputed.
    raw.prepare(`INSERT INTO takedown_outcome_daily (day, dim, key, submitted) VALUES ('2026-07-01', 'country', 'US', 4)`).run();
    raw.prepare(`INSERT INTO takedown_outcome_daily (day, dim, key, submitted) VALUES ('2026-10-11', 'country', 'DE', 2)`).run();

    const r1 = await runTakedownOutcomeRollup(env, NOW);
    expect(r1).toMatchObject({ windowStart: "2026-07-17", sourceRows: 3, cells: 6, staleDeleted: 1 });
    expect(rollupRows(raw)).toEqual([
      { day: "2026-10-10", dim: "country", key: "RU", submitted: 1, taken_down: 1, refused: 0, expired: 0, pending: 0, median_hours: 12 },
      { day: "2026-10-10", dim: "country", key: "unknown", submitted: 1, taken_down: 0, refused: 1, expired: 0, pending: 0, median_hours: null },
      { day: "2026-10-10", dim: "provider", key: "hp_ru", submitted: 1, taken_down: 1, refused: 0, expired: 0, pending: 0, median_hours: 12 },
      { day: "2026-10-10", dim: "provider", key: "unknown", submitted: 1, taken_down: 0, refused: 1, expired: 0, pending: 0, median_hours: null },
      { day: "2026-10-12", dim: "country", key: "unknown", submitted: 1, taken_down: 0, refused: 0, expired: 0, pending: 1, median_hours: null },
      { day: "2026-10-12", dim: "provider", key: "unknown", submitted: 1, taken_down: 0, refused: 0, expired: 0, pending: 1, median_hours: null },
    ]);

    // Unchanged source → zero row writes (guarded upsert).
    const r2 = await runTakedownOutcomeRollup(env, NOW);
    expect(r2.rowsWritten).toBe(0);
    expect(r2.staleDeleted).toBe(0);

    // The pending takedown resolves → that cell is rewritten in place.
    raw.prepare(`UPDATE takedown_requests SET status = 'expired', resolution = 'expired' WHERE id = ?`).run(lookalike);
    const r3 = await runTakedownOutcomeRollup(env, NOW);
    expect(r3.rowsWritten).toBe(2);
    expect(raw.prepare(`SELECT pending, expired FROM takedown_outcome_daily WHERE day = '2026-10-12' AND dim = 'country'`).all())
      .toEqual([{ pending: 0, expired: 1 }]);

    // The RU threat loses its country → the RU cell vanishes, unknown absorbs it.
    raw.prepare(`UPDATE threats SET country_code = NULL WHERE id = ?`).run(t1);
    const r4 = await runTakedownOutcomeRollup(env, NOW);
    expect(r4.staleDeleted).toBe(1);
    expect(raw.prepare(`SELECT key, submitted FROM takedown_outcome_daily WHERE day = '2026-10-10' AND dim = 'country'`).all())
      .toEqual([{ key: "unknown", submitted: 2 }]);
  });

  it("migration 0299: the source read is index-backed (no full scan of takedown_requests or threats; endpoint read pinned in observatory-lenses-b5)", () => {
    const raw = openDerivedDb(["takedown_requests", "threats", "takedown_outcome_daily"]);
    applyMigration(raw, "0039_takedown_requests.sql");
    applyMigration(raw, "0299_takedown_outcome_daily.sql");
    const plan = (sql: string, ...binds: unknown[]) =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");

    const src = plan(TAKEDOWN_ROLLUP_SOURCE_SQL, "2026-07-17 00:00:00");
    expect(src).toContain("idx_takedown_submitted_at");
    expect(src).not.toMatch(/SCAN tr\b|SCAN takedown_requests/);
    expect(src).toMatch(/SEARCH t USING INDEX sqlite_autoindex_threats_1|SEARCH t USING INTEGER PRIMARY KEY/);
  });
});

// ─── 4. cube_healer gate ──────────────────────────────────────────────

function healerCtx(scheduledTime: string, sqls: string[]): AgentContext {
  const record = (sql: string) => sqls.push(sql);
  const stmt = (sql: string) => {
    const r = {
      run: async () => { record(sql); return { meta: { changes: 0 } }; },
      all: async () => { record(sql); return { results: [] }; },
      first: async () => { record(sql); return null; },
    };
    return { ...r, bind: () => r };
  };
  const env = {
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())),
    },
    CACHE: fakeKv({ "cube_healer:last_analyze_at": String(Date.now()) }),
  } as unknown as Env;
  return { env, input: { scheduledTime } } as unknown as AgentContext;
}

describe("cube_healer — takedown rollup hour-only gate", () => {
  it("runs on the UTC hour-0 (cold) tick, at any minute", async () => {
    for (const t of ["2026-10-14T00:12:00Z", "2026-10-14T00:00:00Z", "2026-10-14T00:59:00Z"]) {
      const sqls: string[] = [];
      const res = await cubeHealerAgent.execute(healerCtx(t, sqls));
      expect(sqls.some((s) => s.includes("FROM takedown_requests"))).toBe(true);
      expect((res.output as { takedownRollup: unknown }).takedownRollup).not.toBeNull();
    }
  });

  it("never runs on the hot ticks", async () => {
    for (const t of ["2026-10-14T06:12:00Z", "2026-10-14T12:12:00Z", "2026-10-14T18:12:00Z"]) {
      const sqls: string[] = [];
      const res = await cubeHealerAgent.execute(healerCtx(t, sqls));
      expect(sqls.some((s) => s.includes("takedown_requests") || s.includes("takedown_outcome_daily"))).toBe(false);
      expect((res.output as { takedownRollup: unknown }).takedownRollup).toBeNull();
    }
  });

  it("a rollup failure is a diagnostic, never a failed run", async () => {
    const sqls: string[] = [];
    const ctx = healerCtx("2026-10-14T00:12:00Z", sqls);
    const db = ctx.env.DB as unknown as { prepare: (sql: string) => unknown };
    const orig = db.prepare;
    db.prepare = (sql: string) => {
      if (sql.includes("FROM takedown_requests")) throw new Error("D1_ERROR: boom");
      return orig(sql);
    };
    const res = await cubeHealerAgent.execute(ctx);
    const diag = (res.agentOutputs ?? []).find((o) => (o.details as { stage?: string }).stage === "takedown_outcome_rollup");
    expect(diag?.severity).toBe("high");
    expect(res.degraded).toBeUndefined();
  });
});
