// Pin: cube_healer heals its window ONE DAY PER BATCH.
//
// The 14-day cold heal used to run one [sweep, upsert] batch over the whole
// window per cube. D1 runs a batch as one transaction, so a statement /
// duration limit anywhere in it rolled back the entire cube's heal —
// upsert included. Each day is now its own atomic [sweep, upsert] batch over
// an hour-snapped day; a failed day is recorded and the rest still commit.
//
//   1. healDayChunks — contiguous, hour-snapped, day-sized, covers the window
//   2. healCube — one batch per day with that day's binds; a failed day does
//      not abort the others; accounting counts only committed days
//   3. real SQLite — a failed day leaves that day's cube rows untouched while
//      the other days heal
//   4. execute() — partial failures are diagnostics; geo throws only when
//      EVERY geo day failed

import { describe, it, expect } from "vitest";
import {
  healCube,
  healDayChunks,
  healWindow,
  cubeHealerAgent,
  COLD_HEAL_WINDOW_DAYS,
  HOT_HEAL_WINDOW_DAYS,
} from "../src/agents/cube-healer";
import { CUBE_KEY_SPECS, type CubeName } from "../src/lib/cube-builder";
import { hasSqlite, openDerivedDb, d1FromSqlite } from "./sqlite-d1-harness";
import type { AgentContext } from "../src/lib/agentRunner";
import type { Env } from "../src/types";

const toMs = (s: string) => Date.parse(s.replace(" ", "T") + "Z");

// ─── 1. Chunking ───────────────────────────────────────────────────────

describe("healDayChunks", () => {
  for (const [scope, days, at] of [
    ["hot", HOT_HEAL_WINDOW_DAYS, "2026-05-21T06:12:00Z"],
    ["cold", COLD_HEAL_WINDOW_DAYS, "2026-05-21T00:12:00Z"],
  ] as const) {
    it(`${scope}: ${days} contiguous hour-snapped 24h chunks covering exactly the window`, () => {
      const w = healWindow(new Date(at), days);
      const chunks = healDayChunks(w);
      expect(chunks).toHaveLength(days);
      expect(chunks[0].start).toBe(w.start);
      expect(chunks[chunks.length - 1].end).toBe(w.end);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        expect(c.start.endsWith(":00:00")).toBe(true);
        expect(c.end.endsWith(":00:00")).toBe(true);
        expect(toMs(c.end) - toMs(c.start)).toBe(24 * 3_600_000);
        if (i > 0) expect(c.start).toBe(chunks[i - 1].end);
      }
    });
  }

  it("a non-whole-day window ends with a shorter, still hour-snapped chunk", () => {
    const chunks = healDayChunks({ start: "2026-05-20 06:00:00", end: "2026-05-21 09:00:00" });
    expect(chunks).toEqual([
      { start: "2026-05-20 06:00:00", end: "2026-05-21 06:00:00" },
      { start: "2026-05-21 06:00:00", end: "2026-05-21 09:00:00" },
    ]);
  });

  it("an empty window yields no chunks", () => {
    expect(healDayChunks({ start: "2026-05-21 06:00:00", end: "2026-05-21 06:00:00" })).toEqual([]);
  });
});

// ─── 2. healCube batch shape + accounting ─────────────────────────────

interface Call { sql: string; binds: unknown[] }

/** Stub D1: records batches; fails any batch whose day start is in `failStarts`. */
function stubDb(failStarts: Set<string> = new Set()) {
  const batches: Call[][] = [];
  const stmt = (sql: string) => {
    const run = {
      async run() { return { success: true, meta: { changes: 0 } }; },
      async all() { return { success: true, results: [], meta: {} }; },
      async first() { return null; },
    };
    return {
      ...run,
      bind: (...binds: unknown[]) => ({ __call: { sql, binds }, ...run }),
    };
  };
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: Array<{ __call: Call }>) => {
      const calls = stmts.map((s) => s.__call);
      const start = String(calls[0]?.binds[0]);
      if (failStarts.has(start)) throw new Error(`D1_ERROR: limit exceeded @ ${start}`);
      batches.push(calls);
      return calls.map(() => ({ success: true, meta: { changes: 2 } }));
    },
  };
  return { db: db as unknown as D1Database, batches };
}

describe("healCube — one atomic [sweep, upsert] batch per day", () => {
  const w = healWindow(new Date("2026-05-21T00:12:00Z"), COLD_HEAL_WINDOW_DAYS);
  const chunks = healDayChunks(w);

  for (const cube of Object.keys(CUBE_KEY_SPECS) as CubeName[]) {
    it(`${cube}: ${COLD_HEAL_WINDOW_DAYS} batches, each bound to its own day`, async () => {
      const { db, batches } = stubDb();
      const r = await healCube(db, cube, w);
      expect(r).toEqual({ rowsWritten: COLD_HEAL_WINDOW_DAYS * 4, chunks: COLD_HEAL_WINDOW_DAYS, failures: [] });
      expect(batches).toHaveLength(COLD_HEAL_WINDOW_DAYS);
      batches.forEach((b, i) => {
        expect(b).toHaveLength(2);
        const [sweep, upsert] = b;
        expect(sweep.sql).toContain(`DELETE FROM ${CUBE_KEY_SPECS[cube].table}`);
        expect(upsert.sql).toContain(`INSERT INTO ${CUBE_KEY_SPECS[cube].table}`);
        expect(sweep.binds).toEqual([chunks[i].start, chunks[i].end]);
        expect(upsert.binds).toEqual([chunks[i].start, chunks[i].end]);
      });
      // No batch ever spans more than a day.
      for (const b of batches) {
        expect(toMs(String(b[0].binds[1])) - toMs(String(b[0].binds[0]))).toBeLessThanOrEqual(24 * 3_600_000);
      }
    });
  }

  it("a failed day is recorded and the remaining days still run", async () => {
    const bad = new Set([chunks[3].start, chunks[9].start]);
    const { db, batches } = stubDb(bad);
    const r = await healCube(db, "geo", w);
    expect(r.chunks).toBe(COLD_HEAL_WINDOW_DAYS);
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]).toMatchObject({ start: chunks[3].start, end: chunks[3].end });
    expect(r.failures[0].error).toContain("limit exceeded");
    expect(r.failures[1]).toMatchObject({ start: chunks[9].start, end: chunks[9].end });
    expect(batches).toHaveLength(COLD_HEAL_WINDOW_DAYS - 2);
    // Only committed days count toward rowsWritten.
    expect(r.rowsWritten).toBe((COLD_HEAL_WINDOW_DAYS - 2) * 4);
  });

  it("never throws, even when every day fails", async () => {
    const { db } = stubDb(new Set(chunks.map((c) => c.start)));
    const r = await healCube(db, "brand", w);
    expect(r.failures).toHaveLength(COLD_HEAL_WINDOW_DAYS);
    expect(r.rowsWritten).toBe(0);
  });
});

// ─── 3. Real SQLite — a failed day rolls back only that day ───────────

describe.skipIf(!hasSqlite())("healCube — real SQLite, per-day atomicity", () => {
  it("days that succeed are healed; a failed day's cube rows are untouched", async () => {
    const raw = openDerivedDb(["threats", "threat_cube_geo"]);
    const d1 = d1FromSqlite(raw);
    const insert = (id: string, created: string) => raw.prepare(
      `INSERT INTO threats (id, created_at, status, lat, lng, country_code, severity, threat_type, source_feed,
         malicious_url, malicious_domain, ioc_value)
       VALUES (?, ?, 'active', 5, 5, 'US', 'high', 'phishing', 'phishtank', ?, ?, ?)`,
    ).run(id, created, `https://${id}.x/`, `${id}.x`, `${id}.x`);
    insert("a", "2026-05-19 10:15:00"); // day 1
    insert("b", "2026-05-20 10:15:00"); // day 2 — its batch will fail
    // A stale cube row in each day (key absent from the source).
    for (const hour of ["2026-05-19 03:00:00", "2026-05-20 03:00:00"]) {
      raw.prepare(`INSERT INTO threat_cube_geo (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed, threat_count)
        VALUES (?, 9, 9, 'XX', 'phishing', 'high', 'phishtank', 7)`).run(hour);
    }
    const window = { start: "2026-05-19 00:00:00", end: "2026-05-21 00:00:00" };
    let day = 0;
    const failing = {
      prepare: d1.prepare.bind(d1),
      batch: async (stmts: D1PreparedStatement[]) => {
        // Fail day 2 like a D1 limit would: nothing in its batch commits.
        day++;
        if (day === 2) throw new Error("D1_ERROR: statement too long");
        return d1.batch(stmts);
      },
    };

    const r = await healCube(failing as unknown as D1Database, "geo", window);
    expect(r.chunks).toBe(2);
    expect(r.failures.map((f) => f.start)).toEqual(["2026-05-20 00:00:00"]);
    const rows = raw.prepare(`SELECT hour_bucket, lat_bucket, threat_count FROM threat_cube_geo ORDER BY hour_bucket`).all();
    expect(rows).toEqual([
      // day 1: stale row swept, real group upserted
      { hour_bucket: "2026-05-19 10:00:00", lat_bucket: 5, threat_count: 1 },
      // day 2: failed batch → stale row still there, no upsert
      { hour_bucket: "2026-05-20 03:00:00", lat_bucket: 9, threat_count: 7 },
    ]);
  });
});

// ─── 4. execute() — partial-failure accounting ────────────────────────

function ctxFor(db: D1Database): AgentContext {
  const env = {
    DB: db,
    CACHE: {
      get: async () => String(Date.now()), // ANALYZE ran recently → skipped
      put: async () => {},
    },
  } as unknown as Env;
  return { env, input: { scheduledTime: "2026-05-21T00:12:00Z" } } as unknown as AgentContext;
}

describe("cube_healer execute() — per-day failures", () => {
  it("one failed provider day → a diagnostic naming the day; every other cube still heals", async () => {
    // The window is computed from wall-clock time inside execute(), so fail
    // whichever day the stub sees second for the provider cube.
    const seen: string[] = [];
    const batches: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({ sql, binds, run: async () => ({ meta: { changes: 0 } }), all: async () => ({ results: [] }), first: async () => null }),
        run: async () => ({ meta: { changes: 0 } }), all: async () => ({ results: [] }), first: async () => null,
      }),
      batch: async (stmts: Array<{ sql: string; binds: unknown[] }>) => {
        const sql = stmts[0].sql;
        if (sql.includes("threat_cube_provider")) {
          seen.push(String(stmts[0].binds[0]));
          if (seen.length === 2) throw new Error("D1_ERROR: too many SQL variables");
        }
        batches.push(sql);
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    const res = await cubeHealerAgent.execute(ctxFor(db));
    const cubeDiag = (res.agentOutputs ?? []).filter((o) =>
      ["geo", "provider", "brand", "status", "arcs"].includes(String((o.details as { stage?: string } | undefined)?.stage)));
    expect(cubeDiag).toHaveLength(1);
    const d = cubeDiag[0];
    expect(d.severity).toBe("high");
    expect(d.summary).toContain(`provider heal failed for 1/${COLD_HEAL_WINDOW_DAYS} day(s)`);
    const details = d.details as { failedDays: Array<{ start: string }>; daysAttempted: number; error: string };
    expect(details.failedDays.map((f) => f.start)).toEqual([seen[1]]);
    expect(details.daysAttempted).toBe(COLD_HEAL_WINDOW_DAYS);
    expect(details.error).toContain("too many SQL variables");
    // 5 cubes × 14 days, minus the one failed provider day.
    const cubeBatches = batches.filter((s) => /threat_cube_(geo|provider|brand|status|arcs)/.test(s));
    expect(cubeBatches).toHaveLength(5 * COLD_HEAL_WINDOW_DAYS - 1);
    expect((res.output as { scope: string }).scope).toBe("cold");
  });

  it("geo: some days failing is partial; EVERY day failing throws (→ run failed)", async () => {
    const mk = (failGeo: (n: number) => boolean) => {
      let geoN = 0;
      return {
        prepare: (sql: string) => ({
          bind: (...binds: unknown[]) => ({ sql, binds, run: async () => ({ meta: { changes: 0 } }), all: async () => ({ results: [] }), first: async () => null }),
          run: async () => ({ meta: { changes: 0 } }), all: async () => ({ results: [] }), first: async () => null,
        }),
        batch: async (stmts: Array<{ sql: string }>) => {
          if (stmts[0].sql.includes("threat_cube_geo") && failGeo(++geoN)) throw new Error("D1_ERROR: geo");
          return stmts.map(() => ({ meta: { changes: 0 } }));
        },
      } as unknown as D1Database;
    };
    const partial = await cubeHealerAgent.execute(ctxFor(mk((n) => n === 1)));
    expect((partial.agentOutputs ?? []).some((o) => (o.details as { stage?: string }).stage === "geo")).toBe(true);
    await expect(cubeHealerAgent.execute(ctxFor(mk(() => true)))).rejects.toThrow(/geo heal failed for every day/);
  });
});
