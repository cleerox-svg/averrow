// Pin: cube rebuilds remove stale rows (Observatory overhaul Phase A, item 1).
//
// Every cube writer used to be an upsert only. A group whose threats all went
// inactive (or moved severity / country / provider / brand) kept its last
// count forever, so every window summing over it over-counted permanently.
// Each rebuild is now ONE batch of [stale-row sweep, guarded upsert]:
//   1. shape — every builder issues exactly that batch with the right binds;
//   2. semantics — against real SQLite (node:sqlite) with the migration-
//      derived schema, a rebuilt hour exactly equals a fresh aggregate of the
//      source, other hours are untouched, and the healer's window heal does
//      the same over [start, end).

import { describe, it, expect } from "vitest";
import {
  buildGeoCubeForHour,
  buildProviderCubeForHour,
  buildBrandCubeForHour,
  buildStatusCubeForHour,
  buildArcsCubeForHour,
  cubeStaleSweepSQL,
  CUBE_KEY_SPECS,
  type CubeName,
} from "../src/lib/cube-builder";
import { healCube, healWindow } from "../src/agents/cube-healer";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

// ─── 1. Batch shape ───────────────────────────────────────────────────

interface Call { sql: string; binds: unknown[] }

function shapeEnv() {
  const batches: Call[][] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({ __call: { sql, binds } }),
      }),
      batch: async (stmts: Array<{ __call: Call }>) => {
        batches.push(stmts.map((s) => s.__call));
        return stmts.map(() => ({ meta: { changes: 1 }, success: true }));
      },
    },
  } as unknown as Env;
  return { env, batches };
}

const BUILDERS: Array<[CubeName, (env: Env, hour: string) => Promise<{ rowsWritten: number; error: string | null }>]> = [
  ["geo", buildGeoCubeForHour],
  ["provider", buildProviderCubeForHour],
  ["brand", buildBrandCubeForHour],
  ["status", buildStatusCubeForHour],
  ["arcs", buildArcsCubeForHour],
];

describe("cube builders — one atomic [sweep, upsert] batch per hour", () => {
  for (const [cube, build] of BUILDERS) {
    it(`${cube}: batch = DELETE stale rows of the hour, then upsert`, async () => {
      const { env, batches } = shapeEnv();
      const r = await build(env, "2026-05-22 16:00:00");
      expect(r.error).toBeNull();
      expect(batches).toHaveLength(1);
      const [sweep, upsert] = batches[0];
      const table = CUBE_KEY_SPECS[cube].table;
      expect(sweep.sql).toContain(`DELETE FROM ${table}`);
      expect(sweep.sql).toMatch(/NOT IN \(/);
      expect(sweep.binds).toEqual(["2026-05-22 16:00:00", "2026-05-22 17:00:00"]);
      expect(upsert.sql).toContain(`INSERT INTO ${table}`);
      expect(upsert.binds).toEqual(["2026-05-22 16:00:00", "2026-05-22 16:00:00", "2026-05-22 17:00:00"]);
      // rows written sums both statements
      expect(r.rowsWritten).toBe(2);
    });
  }

  it("sweep is scoped to the bound window (never an unbounded DELETE)", () => {
    for (const [cube] of BUILDERS) {
      const sql = cubeStaleSweepSQL(cube);
      expect(sql).toContain("hour_bucket >= ?1");
      expect(sql).toContain("hour_bucket < ?2");
      expect(sql).toContain("created_at >= ?1");
      expect(sql).toContain("created_at < ?2");
    }
  });

  it("sweep source filter matches the cube population", () => {
    expect(cubeStaleSweepSQL("geo")).toContain("status = 'active'");
    expect(cubeStaleSweepSQL("arcs")).toContain("target_brand_id IS NOT NULL");
    // Status cube holds every status — its sweep must not filter on status.
    expect(cubeStaleSweepSQL("status")).not.toContain("status = 'active'");
  });
});

// ─── 2. Semantics against real SQLite ─────────────────────────────────

let seq = 0;
function insertThreat(raw: SqliteDb, t: {
  created_at: string; status?: string; lat?: number | null; lng?: number | null;
  country_code?: string | null; severity?: string; threat_type?: string; source_feed?: string;
  target_brand_id?: string | null; hosting_provider_id?: string | null;
}): string {
  const id = `t${++seq}`;
  raw.prepare(
    `INSERT INTO threats (id, created_at, status, lat, lng, country_code, severity, threat_type,
       source_feed, target_brand_id, hosting_provider_id, malicious_url, malicious_domain, ioc_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, t.created_at, t.status ?? "active", t.lat ?? null, t.lng ?? null, t.country_code ?? null,
    t.severity ?? "high", t.threat_type ?? "phishing", t.source_feed ?? "phishtank",
    t.target_brand_id ?? null, t.hosting_provider_id ?? null, `https://${id}.example/`, `${id}.example`, `${id}.example`,
  );
  return id;
}

type Row = Record<string, unknown>;
const rowsOf = (raw: SqliteDb, sql: string): Row[] => raw.prepare(sql).all() as Row[];

/** Cube contents for one table, minus volatile updated_at, sorted. */
function cubeRows(raw: SqliteDb, table: string): Row[] {
  return rowsOf(raw, `SELECT * FROM ${table} ORDER BY 1, 2, 3, 4, 5, 6`).map((r) => {
    const { updated_at: _u, ...rest } = r;
    return rest;
  });
}

const CUBE_TABLES = ["threats", "threat_cube_geo", "threat_cube_provider", "threat_cube_brand", "threat_cube_status", "threat_cube_arcs"];

function envFor(raw: SqliteDb): Env {
  return { DB: d1FromSqlite(raw) } as unknown as Env;
}

describe.skipIf(!hasSqlite())("stale-row sweep — real SQLite", () => {
  const H = "2026-05-22 16:00:00";
  const OTHER = "2026-05-22 15:00:00";

  it("geo: a group whose threats went inactive is removed; a moved group is re-keyed", async () => {
    const raw = openDerivedDb(CUBE_TABLES);
    const env = envFor(raw);
    const a = insertThreat(raw, { created_at: "2026-05-22 16:05:00", lat: 10, lng: 20, country_code: "US", severity: "high" });
    const b = insertThreat(raw, { created_at: "2026-05-22 16:10:00", lat: 30, lng: 40, country_code: "DE", severity: "low" });
    insertThreat(raw, { created_at: "2026-05-22 16:20:00", lat: 30, lng: 40, country_code: "DE", severity: "low" });
    insertThreat(raw, { created_at: "2026-05-22 15:30:00", lat: 1, lng: 2, country_code: "FR" });

    expect((await buildGeoCubeForHour(env, OTHER)).error).toBeNull();
    expect((await buildGeoCubeForHour(env, H)).error).toBeNull();
    expect(rowsOf(raw, `SELECT SUM(threat_count) AS n FROM threat_cube_geo WHERE hour_bucket = '${H}'`)[0].n).toBe(3);

    // a goes inactive (its group empties); b changes severity (moves group).
    raw.prepare("UPDATE threats SET status = 'remediated' WHERE id = ?").run(a);
    raw.prepare("UPDATE threats SET severity = 'critical' WHERE id = ?").run(b);
    const otherBefore = rowsOf(raw, `SELECT * FROM threat_cube_geo WHERE hour_bucket = '${OTHER}'`);

    expect((await buildGeoCubeForHour(env, H)).error).toBeNull();
    const hourRows = rowsOf(raw, `SELECT lat_bucket, lng_bucket, country_code, severity, threat_count
      FROM threat_cube_geo WHERE hour_bucket = '${H}' ORDER BY severity`);
    expect(hourRows).toEqual([
      { lat_bucket: 30, lng_bucket: 40, country_code: "DE", severity: "critical", threat_count: 1 },
      { lat_bucket: 30, lng_bucket: 40, country_code: "DE", severity: "low", threat_count: 1 },
    ]);
    // Other hours untouched.
    expect(rowsOf(raw, `SELECT * FROM threat_cube_geo WHERE hour_bucket = '${OTHER}'`)).toEqual(otherBefore);
  });

  it("every cube: rebuilt hour equals a from-scratch rebuild after arbitrary churn", async () => {
    const raw = openDerivedDb(CUBE_TABLES);
    const env = envFor(raw);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(insertThreat(raw, {
        created_at: `2026-05-22 16:${String(i * 4).padStart(2, "0")}:00`,
        lat: i % 3, lng: 10 + (i % 2), country_code: i % 4 === 0 ? null : "US",
        severity: ["critical", "high", "low"][i % 3], threat_type: i % 2 ? "phishing" : "malware_distribution",
        target_brand_id: i % 5 === 0 ? null : `b${i % 3}`, hosting_provider_id: i % 2 ? `p${i % 2}` : null,
      }));
    }
    for (const [, build] of BUILDERS) expect((await build(env, H)).error).toBeNull();

    // Churn: deactivate, re-severity, re-brand, re-provider, re-locate.
    raw.prepare("UPDATE threats SET status = 'down' WHERE id IN (?, ?, ?)").run(ids[0], ids[5], ids[7]);
    raw.prepare("UPDATE threats SET severity = 'medium' WHERE id = ?").run(ids[1]);
    raw.prepare("UPDATE threats SET target_brand_id = 'b9' WHERE id = ?").run(ids[2]);
    raw.prepare("UPDATE threats SET hosting_provider_id = 'p9' WHERE id = ?").run(ids[3]);
    raw.prepare("UPDATE threats SET lat = 55, lng = 66, country_code = 'JP' WHERE id = ?").run(ids[4]);
    for (const [, build] of BUILDERS) expect((await build(env, H)).error).toBeNull();
    const incremental = Object.fromEntries(BUILDERS.map(([c]) => [c, cubeRows(raw, CUBE_KEY_SPECS[c].table)]));

    // Ground truth: wipe the cubes and build once from the current source.
    for (const [c] of BUILDERS) raw.exec(`DELETE FROM ${CUBE_KEY_SPECS[c].table}`);
    for (const [, build] of BUILDERS) expect((await build(env, H)).error).toBeNull();
    for (const [c] of BUILDERS) {
      expect(incremental[c], `${c} cube drifted from source`).toEqual(cubeRows(raw, CUBE_KEY_SPECS[c].table));
    }
  });

  it("healer: window heal removes stale rows inside [start, end) and leaves rows outside alone", async () => {
    const raw = openDerivedDb(CUBE_TABLES);
    const env = envFor(raw);
    const window = { start: "2026-05-20 00:00:00", end: "2026-05-22 00:00:00" };
    const inside = insertThreat(raw, { created_at: "2026-05-21 10:15:00", lat: 5, lng: 5, country_code: "US" });
    insertThreat(raw, { created_at: "2026-05-21 11:15:00", lat: 6, lng: 6, country_code: "US" });
    // A stale row OUTSIDE the window (older) — must survive the heal.
    raw.prepare(`INSERT INTO threat_cube_geo (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed, threat_count)
      VALUES ('2026-05-19 23:00:00', 1, 1, 'XX', 'phishing', 'high', 'phishtank', 7)`).run();

    await healCube(env.DB, "geo", window);
    expect(rowsOf(raw, "SELECT COUNT(*) AS n FROM threat_cube_geo WHERE hour_bucket >= '2026-05-20 00:00:00'")[0].n).toBe(2);

    raw.prepare("UPDATE threats SET status = 'remediated' WHERE id = ?").run(inside);
    await healCube(env.DB, "geo", window);
    expect(rowsOf(raw, `SELECT hour_bucket, threat_count FROM threat_cube_geo ORDER BY hour_bucket`)).toEqual([
      { hour_bucket: "2026-05-19 23:00:00", threat_count: 7 },
      { hour_bucket: "2026-05-21 11:00:00", threat_count: 1 },
    ]);
  });

  it("healer: a snapped window never rebuilds the oldest hour from a partial slice", async () => {
    const raw = openDerivedDb(CUBE_TABLES);
    const env = envFor(raw);
    // Two threats in the oldest hour of the window, one before the
    // (unsnapped) wall-clock minute, one after.
    insertThreat(raw, { created_at: "2026-05-19 06:05:00", lat: 5, lng: 5, country_code: "US" });
    insertThreat(raw, { created_at: "2026-05-19 06:40:00", lat: 5, lng: 5, country_code: "US" });
    const window = healWindow(new Date("2026-05-21T06:12:00Z"), 2);
    expect(window.start).toBe("2026-05-19 06:00:00");
    await healCube(env.DB, "geo", window);
    expect(rowsOf(raw, "SELECT threat_count FROM threat_cube_geo WHERE hour_bucket = '2026-05-19 06:00:00'")[0].threat_count).toBe(2);
  });
});
