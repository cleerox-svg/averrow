// Observatory Phase B (B3) — weaponization-velocity cube + incremental
// stamping + cube_healer wiring (and the Phase A degraded follow-up).
//
//   1. buildVelocityCubeForHour / healCube('velocity') against real SQLite:
//      the cube equals a fresh aggregate of the source; stale groups go
//   2. EXPLAIN (with ANALYZE stats): the heal + sweep read the window's
//      FLAGGED rows through the partial covering index, never every active
//      row of the window; the stamping page is an id range on its own
//      partial index
//   3. runVelocityStampPage: ≤limit rows, stamps computable rows only,
//      keyset cursor advances / resets, re-run is idempotent
//   4. cube_healer execute(): stamping runs before the heals; velocity heals
//      90 days on the cold tick and the hot window otherwise; a cube with
//      >50% failed days finishes degraded

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildVelocityCubeForHour, cubeStaleSweepSQL } from "../src/lib/cube-builder";
import {
  cubeHealerAgent,
  degradedCubes,
  healCube,
  healSQLForTest,
  HOT_HEAL_WINDOW_DAYS,
  COLD_HEAL_WINDOW_DAYS,
  VELOCITY_COLD_HEAL_WINDOW_DAYS,
} from "../src/agents/cube-healer";
import {
  runVelocityStampPage,
  VELOCITY_STAMP_CURSOR_KEY,
} from "../src/lib/velocity-writer";
import { splitStatements } from "./migration-schema";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { AgentContext } from "../src/lib/agentRunner";
import type { Env } from "../src/types";

let seq = 0;
function threat(raw: SqliteDb, t: {
  created_at: string; status?: string; cc?: string | null; flag?: string | null;
  domain_created_at?: string | null; first_seen?: string; id?: string;
}): string {
  const id = t.id ?? `t${String(++seq).padStart(5, "0")}`;
  raw.prepare(`INSERT INTO threats (id, created_at, first_seen, status, country_code, weaponization_flag, domain_created_at,
      severity, threat_type, source_feed, malicious_url, malicious_domain, ioc_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'high', 'phishing', 'phishtank', ?, ?, ?)`).run(
    id, t.created_at, t.first_seen ?? t.created_at, t.status ?? "active", t.cc === undefined ? "US" : t.cc,
    t.flag ?? null, t.domain_created_at ?? null, `https://${id}.x/`, `${id}.x`, `${id}.x`);
  return id;
}
const cube = (raw: SqliteDb) =>
  raw.prepare(`SELECT hour_bucket, country_code, flag, threat_count FROM threat_cube_velocity ORDER BY 1, 2, 3`).all();
const freshAggregate = (raw: SqliteDb, start: string, end: string) =>
  raw.prepare(`SELECT strftime('%Y-%m-%d %H:00:00', created_at) AS hour_bucket, COALESCE(country_code, 'XX') AS country_code,
      weaponization_flag AS flag, COUNT(*) AS threat_count
    FROM threats WHERE created_at >= ? AND created_at < ? AND status = 'active'
      AND weaponization_flag IN ('very_fast', 'fast')
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`).all(start, end);

function applyIndexes(raw: SqliteDb, file: string): void {
  const sql = readFileSync(resolve(__dirname, `../migrations/${file}`), "utf-8");
  for (const stmt of splitStatements(sql)) {
    if (/^\s*CREATE INDEX/i.test(stmt) && /\bON threats\s*\(/i.test(stmt)) raw.exec(stmt);
  }
}

// ─── 1. Cube semantics ────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("threat_cube_velocity — real SQLite", () => {
  it("hour build = fresh aggregate (active, fast flags only, NULL country → XX); stale groups swept", async () => {
    const raw = openDerivedDb(["threats", "threat_cube_velocity"]);
    const env = { DB: d1FromSqlite(raw) } as unknown as Env;
    const H = "2026-10-10 05:00:00";
    threat(raw, { created_at: "2026-10-10 05:10:00", flag: "very_fast", cc: "RU" });
    threat(raw, { created_at: "2026-10-10 05:20:00", flag: "very_fast", cc: "RU" });
    threat(raw, { created_at: "2026-10-10 05:30:00", flag: "fast", cc: null });
    threat(raw, { created_at: "2026-10-10 05:40:00", flag: "normal", cc: "RU" });         // not a fast flag
    threat(raw, { created_at: "2026-10-10 05:41:00", flag: "very_fast", status: "down" }); // inactive
    threat(raw, { created_at: "2026-10-10 05:42:00", flag: null });                        // unstamped
    threat(raw, { created_at: "2026-10-10 06:00:00", flag: "fast" });                      // next hour
    raw.prepare(`INSERT INTO threat_cube_velocity (hour_bucket, country_code, flag, threat_count) VALUES (?, 'CN', 'fast', 9)`).run(H);
    raw.prepare(`INSERT INTO threat_cube_velocity (hour_bucket, country_code, flag, threat_count) VALUES ('2026-10-10 06:00:00', 'ZZ', 'fast', 3)`).run();

    const r = await buildVelocityCubeForHour(env, H);
    expect(r.error).toBeNull();
    expect(cube(raw).filter((x) => (x as { hour_bucket: string }).hour_bucket === H)).toEqual([
      { hour_bucket: H, country_code: "RU", flag: "very_fast", threat_count: 2 },
      { hour_bucket: H, country_code: "XX", flag: "fast", threat_count: 1 },
    ]);
    // The other hour is untouched by an hour build …
    expect(cube(raw)).toContainEqual({ hour_bucket: "2026-10-10 06:00:00", country_code: "ZZ", flag: "fast", threat_count: 3 });

    // … and healed by the day-chunked window heal, which equals the source.
    const w = { start: "2026-10-09 00:00:00", end: "2026-10-11 00:00:00" };
    const h = await healCube(env.DB, "velocity", w);
    expect(h.failures).toEqual([]);
    expect(cube(raw)).toEqual(freshAggregate(raw, w.start, w.end));

    // Idempotent: a second heal writes nothing.
    expect((await healCube(env.DB, "velocity", w)).rowsWritten).toBe(0);
  });

  it("CHECK rejects a flag outside very_fast / fast", () => {
    const raw = openDerivedDb(["threat_cube_velocity"]);
    expect(() => raw.prepare(`INSERT INTO threat_cube_velocity (hour_bucket, country_code, flag) VALUES ('h', 'US', 'normal')`).run())
      .toThrow(/CHECK/);
  });

  it("migration 0300: heal + sweep read only the flagged rows via the partial covering index", () => {
    const raw = openDerivedDb(["threats", "threat_cube_velocity"]);
    applyIndexes(raw, "0045_performance_indexes.sql");
    applyIndexes(raw, "0300_threat_cube_velocity.sql");
    // Realistic stats: most rows active, few flagged — the shape in which a
    // (created_at)-only partial index lost to idx_threats_status_created.
    for (let i = 0; i < 3000; i++) {
      threat(raw, { created_at: `2026-10-0${1 + (i % 9)} 10:00:00`, flag: i % 60 === 0 ? "fast" : null,
        domain_created_at: i % 3 ? "2026-01-01 00:00:00" : null });
    }
    raw.exec("ANALYZE");
    const plan = (sql: string, ...binds: unknown[]) =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");

    const heal = plan(healSQLForTest("velocity"), "2026-10-01 00:00:00", "2026-10-02 00:00:00");
    expect(heal).toContain("COVERING INDEX idx_threats_velocity_fast_created");
    expect(heal).not.toContain("idx_threats_status_created");
    const sweep = plan(cubeStaleSweepSQL("velocity"), "2026-10-01 00:00:00", "2026-10-02 00:00:00");
    expect(sweep).toContain("COVERING INDEX idx_threats_velocity_fast_created");
    expect(sweep).not.toMatch(/SCAN threats\b/);

    const stamp = plan(`SELECT id, domain_created_at, first_seen FROM threats
      WHERE domain_created_at IS NOT NULL AND weaponization_flag IS NULL AND id > ? ORDER BY id LIMIT ?`, "", 500);
    expect(stamp).toContain("idx_threats_velocity_unstamped");
    expect(stamp).not.toContain("TEMP B-TREE");
  });
});

// ─── 3. Incremental stamping ──────────────────────────────────────────

describe.skipIf(!hasSqlite())("runVelocityStampPage — real SQLite", () => {
  it("pages ≤limit, stamps computable rows only, advances then resets the cursor, idempotent", async () => {
    const raw = openDerivedDb(["threats"]);
    const cache = fakeKv();
    const env = { DB: d1FromSqlite(raw), CACHE: cache } as unknown as Env;
    threat(raw, { id: "a1", created_at: "2026-10-10 10:00:00", first_seen: "2026-10-10 10:00:00", domain_created_at: "2026-10-10 00:00:00" }); // 10h → very_fast
    threat(raw, { id: "a2", created_at: "2026-10-10 10:00:00", first_seen: "2026-10-12 10:00:00", domain_created_at: "2026-10-10 10:00:00" }); // 48h → fast
    threat(raw, { id: "a3", created_at: "2026-10-10 10:00:00", first_seen: "2026-10-10 10:00:00", domain_created_at: "1970-01-01 00:00:00" }); // sentinel → not computable
    threat(raw, { id: "a4", created_at: "2026-10-10 10:00:00", first_seen: "2026-10-20 10:00:00", domain_created_at: "2026-10-10 10:00:00" }); // 240h → normal
    threat(raw, { id: "a5", created_at: "2026-10-10 10:00:00", domain_created_at: null });                                                  // no reg date
    threat(raw, { id: "a6", created_at: "2026-10-10 10:00:00", flag: "fast", domain_created_at: "2026-10-10 00:00:00" });                    // already stamped

    const p1 = await runVelocityStampPage(env, 2);
    expect(p1).toMatchObject({ cursor_from: "", cursor_to: "a2", scanned: 2, written: 2 });
    expect(cache.store.get(VELOCITY_STAMP_CURSOR_KEY)).toBe("a2");
    const p2 = await runVelocityStampPage(env, 2);
    expect(p2).toMatchObject({ cursor_from: "a2", cursor_to: "a4", scanned: 2, written: 1 });
    expect(p2.by_flag).toEqual({ very_fast: 0, fast: 0, normal: 1, not_computable: 1 });
    // a3 is left NULL (not computable) and stays behind the cursor; the next
    // page comes back short → the cycle completes and the cursor resets.
    const p3 = await runVelocityStampPage(env, 2);
    expect(p3).toMatchObject({ cursor_from: "a4", cursor_to: "", scanned: 0, written: 0 });

    const flags = raw.prepare(`SELECT id, weaponization_flag AS f, weaponization_hours AS h FROM threats ORDER BY id`).all();
    expect(flags).toEqual([
      { id: "a1", f: "very_fast", h: 10 },
      { id: "a2", f: "fast", h: 48 },
      { id: "a3", f: null, h: null },
      { id: "a4", f: "normal", h: 240 },
      { id: "a5", f: null, h: null },
      { id: "a6", f: "fast", h: null }, // never revisited (not in the unstamped set)
    ]);

    // New cycle: only the not-computable row is left; re-stamping writes nothing.
    const p4 = await runVelocityStampPage(env, 2);
    expect(p4).toMatchObject({ cursor_from: "", cursor_to: "", scanned: 1, written: 0 });
  });

  it("the default page is 500 rows", async () => {
    const raw = openDerivedDb(["threats"]);
    for (let i = 0; i < 520; i++) {
      threat(raw, { created_at: "2026-10-10 10:00:00", first_seen: "2026-10-10 12:00:00", domain_created_at: "2026-10-10 10:00:00" });
    }
    const env = { DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env;
    const p = await runVelocityStampPage(env);
    expect(p.scanned).toBe(500);
    expect(p.written).toBe(500);
  });
});

// ─── 4. cube_healer wiring ────────────────────────────────────────────

interface Rec { sql: string; binds: unknown[] }
function stubCtx(scheduledTime: string, opts: { failBatch?: (sql: string, n: number) => boolean } = {}) {
  const calls: Rec[] = [];
  const batches: Rec[][] = [];
  const counters = new Map<string, number>();
  const stmt = (sql: string, binds: unknown[] = []) => {
    const r = {
      sql, binds,
      run: async () => { calls.push({ sql, binds }); return { meta: { changes: 0 } }; },
      all: async () => { calls.push({ sql, binds }); return { results: [] }; },
      first: async () => { calls.push({ sql, binds }); return null; },
    };
    return { ...r, bind: (...b: unknown[]) => stmt(sql, b) };
  };
  const env = {
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (stmts: Rec[]) => {
        const key = stmts[0]!.sql.match(/(?:DELETE FROM|INSERT INTO) (\w+)/)?.[1] ?? "?";
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        if (opts.failBatch?.(stmts[0]!.sql, n)) throw new Error(`D1_ERROR: ${key} #${n}`);
        batches.push(stmts.map((s) => ({ sql: s.sql, binds: s.binds })));
        return stmts.map(() => ({ meta: { changes: 0 } }));
      },
    },
    CACHE: fakeKv({ "cube_healer:last_analyze_at": String(Date.now()) }),
  } as unknown as Env;
  return { ctx: { env, input: { scheduledTime } } as unknown as AgentContext, calls, batches };
}
const velocityBatches = (b: Rec[][]) => b.filter((x) => x[0]!.sql.includes("threat_cube_velocity"));

describe("cube_healer — velocity wiring", () => {
  it("stamping page runs before any cube heal", async () => {
    const { ctx, calls, batches } = stubCtx("2026-10-14T06:12:00Z");
    await cubeHealerAgent.execute(ctx);
    const stampIdx = calls.findIndex((c) => c.sql.includes("weaponization_flag IS NULL"));
    expect(stampIdx).toBeGreaterThanOrEqual(0);
    expect(batches.length).toBeGreaterThan(0);
    // Every SELECT recorded before the first batch includes the stamping read
    // (batches are recorded separately; the stamp read happens first in execute()).
    expect(calls[0]!.sql).toContain("weaponization_flag IS NULL");
  });

  it("velocity heals the hot window on hot ticks and 90 days on the cold tick", async () => {
    const hot = stubCtx("2026-10-14T06:12:00Z");
    await cubeHealerAgent.execute(hot.ctx);
    expect(velocityBatches(hot.batches)).toHaveLength(HOT_HEAL_WINDOW_DAYS);

    const cold = stubCtx("2026-10-14T00:12:00Z");
    await cubeHealerAgent.execute(cold.ctx);
    expect(velocityBatches(cold.batches)).toHaveLength(VELOCITY_COLD_HEAL_WINDOW_DAYS);
    // The other cubes keep their 14-day cold window.
    expect(cold.batches.filter((x) => x[0]!.sql.includes("threat_cube_geo"))).toHaveLength(COLD_HEAL_WINDOW_DAYS);
  });

  it("a stamping failure is a medium diagnostic and the heals still run", async () => {
    const { ctx, batches } = stubCtx("2026-10-14T06:12:00Z");
    const db = ctx.env.DB as unknown as { prepare: (sql: string) => unknown };
    const orig = db.prepare;
    db.prepare = (sql: string) => {
      if (sql.includes("weaponization_flag IS NULL")) throw new Error("D1_ERROR: stamp");
      return orig(sql);
    };
    const res = await cubeHealerAgent.execute(ctx);
    const d = (res.agentOutputs ?? []).find((o) => (o.details as { stage?: string }).stage === "velocity_stamp");
    expect(d?.severity).toBe("medium");
    expect(velocityBatches(batches)).toHaveLength(HOT_HEAL_WINDOW_DAYS);
  });
});

describe("cube_healer — degraded when most of a cube's days fail (Phase A follow-up)", () => {
  it("degradedCubes: strictly more than half", () => {
    expect(degradedCubes([
      { table: "geo", failed: 8, chunks: 14 },
      { table: "provider", failed: 7, chunks: 14 },
      { table: "arcs", failed: 0, chunks: 0 },
      { table: "velocity", failed: 2, chunks: 2 },
    ])).toEqual(["geo", "velocity"]);
  });

  it("8/14 geo days failed → run finishes degraded (agent_runs 'partial'), not success", async () => {
    const { ctx } = stubCtx("2026-10-14T00:12:00Z", {
      failBatch: (sql, n) => sql.includes("threat_cube_geo") && n <= 8,
    });
    const res = await cubeHealerAgent.execute(ctx);
    expect(res.degraded?.reason).toContain("geo");
    expect((res.output as { degradedCubes: string[] }).degradedCubes).toEqual(["geo"]);
  });

  it("a minority of failed days stays a diagnostic-only success", async () => {
    const { ctx } = stubCtx("2026-10-14T00:12:00Z", {
      failBatch: (sql, n) => sql.includes("threat_cube_geo") && n <= 7,
    });
    const res = await cubeHealerAgent.execute(ctx);
    expect(res.degraded).toBeUndefined();
    expect((res.agentOutputs ?? []).some((o) => (o.details as { stage?: string }).stage === "geo")).toBe(true);
  });

  it("every geo day failing still throws (→ failed)", async () => {
    const { ctx } = stubCtx("2026-10-14T00:12:00Z", { failBatch: (sql) => sql.includes("threat_cube_geo") });
    await expect(cubeHealerAgent.execute(ctx)).rejects.toThrow(/geo heal failed for every day/);
  });
});

describe("cube_healer — completion telemetry", () => {
  it("emits one telemetry agent_events row (target_agent NULL) after the work", async () => {
    const { ctx, calls } = stubCtx("2026-10-14T06:12:00Z");
    await cubeHealerAgent.execute(ctx);
    const ev = calls.filter((c) => c.sql.includes("INSERT INTO agent_events"));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.sql).toContain("'cubes_healed', 'cube_healer', NULL");
    const payload = JSON.parse(String(ev[0]!.binds[1])) as Record<string, unknown>;
    expect(payload).toMatchObject({ scope: "hot", partial_failures: 0, degraded_cubes: [] });
    // It is the last statement of the run.
    expect(calls[calls.length - 1]!.sql).toContain("INSERT INTO agent_events");
  });
});
