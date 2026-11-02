// /api/observatory/nodes — Worker-side fold parity.
//
// The per-cell fold (severity sums, top country, top threat type, ordering,
// LIMIT) moved out of SQL (cells / cc / tt CTE stages over a materialised
// `g`) into `foldNodeCells` over one base GROUP BY, because D1 billed the
// temp-structure reads (346K rows_read for a 30d request). LEGACY_NODES_SQL
// below is the former statement verbatim (severitySumsSql expanded); every
// case runs both paths on the same seeded SQLite and requires identical
// output: ties, XX-only cells, NULLs, limit truncation and filters.

import { describe, it, expect } from "vitest";
import {
  NODES_BASE_SQL,
  foldNodeCells,
  buildSourceFilter,
  buildObservatoryCubeFilter,
  parseObservatoryFilters,
  parseObservatorySourceFeed,
  snappedWindowStart,
  type NodeBaseRow,
} from "../src/handlers/observatory";
import { hasSqlite, openMigratedDb, type SqliteDb } from "./sqlite-d1-harness";

function LEGACY_NODES_SQL(sourceSql: string): string {
  return `
      WITH g AS (
        SELECT
          ROUND(lat_bucket, 1) AS lat,
          ROUND(lng_bucket, 1) AS lng,
          country_code,
          threat_type,
          LOWER(severity) AS severity,
          SUM(threat_count) AS n
        FROM threat_cube_geo
        WHERE hour_bucket >= ?${sourceSql}
        GROUP BY 1, 2, 3, 4, 5
      ),
      cells AS (
        SELECT
          lat, lng,
          SUM(n) AS threat_count,
          SUM(CASE WHEN LOWER(severity) = 'critical' THEN n ELSE 0 END) AS critical,
          SUM(CASE WHEN LOWER(severity) = 'high' THEN n ELSE 0 END) AS high,
          SUM(CASE WHEN LOWER(severity) = 'medium' THEN n ELSE 0 END) AS medium,
          SUM(CASE WHEN LOWER(severity) = 'low' THEN n ELSE 0 END) AS low
        FROM g
        GROUP BY lat, lng
        ORDER BY threat_count DESC, lat, lng
        LIMIT ?
      ),
      cc AS (
        SELECT lat, lng, country_code,
          ROW_NUMBER() OVER (PARTITION BY lat, lng ORDER BY SUM(n) DESC, country_code) AS rn
        FROM g
        WHERE country_code != 'XX'
        GROUP BY lat, lng, country_code
      ),
      tt AS (
        SELECT lat, lng, threat_type,
          ROW_NUMBER() OVER (PARTITION BY lat, lng ORDER BY SUM(n) DESC, threat_type) AS rn
        FROM g
        GROUP BY lat, lng, threat_type
      )
      SELECT
        c.lat, c.lng, c.threat_count,
        c.critical, c.high, c.medium, c.low,
        cc.country_code,
        tt.threat_type AS top_threat_type
      FROM cells c
      LEFT JOIN cc ON cc.lat = c.lat AND cc.lng = c.lng AND cc.rn = 1
      LEFT JOIN tt ON tt.lat = c.lat AND tt.lng = c.lng AND tt.rn = 1
      ORDER BY c.threat_count DESC, c.lat, c.lng
    `;
}

function hourAgo(h: number): string {
  const d = new Date(Date.now() - h * 3_600_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

interface GeoRow {
  hour?: string;
  lat: number | null;
  lng: number | null;
  cc: string | null;
  type: string | null;
  sev: string | null;
  feed?: string;
  n: number;
}

function insert(db: SqliteDb, rows: GeoRow[]): void {
  const stmt = db.prepare(`INSERT OR REPLACE INTO threat_cube_geo
    (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed, threat_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) stmt.run(r.hour ?? hourAgo(2), r.lat, r.lng, r.cc, r.type, r.sev, r.feed ?? "phishtank", r.n);
}

const plain = (rows: unknown[]) => rows.map((r) => ({ ...(r as Record<string, unknown>) }));

/** Run the legacy SQL and the new base SQL + fold for one query string; return both. */
function both(db: SqliteDb, query: string, limit: number) {
  const params = new URLSearchParams(query);
  const source = parseObservatorySourceFeed(params.get("source_feed"));
  if (!source.ok) throw new Error("bad source");
  const parsed = parseObservatoryFilters(params);
  if (!parsed.ok) throw new Error(parsed.error);
  const sf = buildSourceFilter(source.feed);
  const cf = buildObservatoryCubeFilter(parsed.filters, { brandColumn: false });
  const windowStart = snappedWindowStart("7d");
  const binds = [windowStart, ...sf.params, ...cf.params] as Array<string | number | null>;
  const legacy = plain(db.prepare(LEGACY_NODES_SQL(sf.sql + cf.sql)).all(...binds, limit));
  const base = plain(db.prepare(NODES_BASE_SQL(sf.sql + cf.sql)).all(...binds)) as unknown as NodeBaseRow[];
  return { legacy, folded: plain(foldNodeCells(base, limit)) };
}

const QUERIES = [
  "",
  "severity=critical",
  "severity=high,low",
  "threat_type=phishing",
  "threat_type=c2,malware_distribution",
  "severity=medium&threat_type=phishing",
  "source_feed=spam_trap",
  "source_feed=feeds&severity=critical,high",
];

describe.skipIf(!hasSqlite())("nodes fold == legacy NODES_SQL", () => {
  it("hand-built edge cases: ties, XX, case, other severities, window, limit", () => {
    const db = openMigratedDb();
    insert(db, [
      // Cell (10.0, 20.0): DE and FR tie at 3 (DE wins alphabetically), XX
      // has the most; 0.01° buckets fold into one 0.1° cell; DE spans hours.
      { lat: 10.01, lng: 20.02, cc: "XX", type: "phishing", sev: "medium", n: 5 },
      { lat: 10.02, lng: 20.01, cc: "FR", type: "phishing", sev: "critical", n: 3 },
      { lat: 10.03, lng: 20.03, cc: "DE", type: "c2", sev: "high", n: 2 },
      { hour: hourAgo(5), lat: 10.03, lng: 20.03, cc: "DE", type: "c2", sev: "high", n: 1 },
      // threat types tie at 8 vs 8: c2 < phishing alphabetically.
      { lat: 10.04, lng: 20.04, cc: "XX", type: "c2", sev: "low", n: 5 },
      // Cell (50, 60): all XX → null country.
      { lat: 50, lng: 60, cc: "XX", type: "phishing", sev: "low", n: 4 },
      { lat: 50.01, lng: 60, cc: "XX", type: "malware_distribution", sev: "low", n: 4 },
      // Equal threat_count cells: lat then lng ordering, negatives.
      { lat: -33.9, lng: 151.2, cc: "AU", type: "phishing", sev: "high", n: 4 },
      { lat: -33.9, lng: -70.6, cc: "CL", type: "phishing", sev: "high", n: 4 },
      { lat: 1.3, lng: 103.8, cc: "SG", type: "phishing", sev: "high", n: 4 },
      // Mixed-case severity folds; a non-ranked severity counts only in the total.
      { lat: 35.6, lng: 139.7, cc: "JP", type: "phishing", sev: "CRITICAL", n: 2 },
      { lat: 35.6, lng: 139.7, cc: "JP", type: "phishing", sev: "High", n: 1 },
      { lat: 35.6, lng: 139.7, cc: "JP", type: "phishing", sev: "info", n: 5 },
      // Lower-case 'xx' is NOT the sentinel (`!= 'XX'` is case-sensitive).
      { lat: 48.8, lng: 2.3, cc: "xx", type: "phishing", sev: "low", n: 1 },
      // Feed split for the source filters.
      { lat: 40.7, lng: -74, cc: "US", type: "phishing", sev: "high", n: 7, feed: "spam_trap" },
      { lat: 40.7, lng: -74, cc: "CA", type: "c2", sev: "critical", n: 2 },
      // Outside the 7d window.
      { hour: hourAgo(24 * 9), lat: 0.5, lng: 0.5, cc: "US", type: "phishing", sev: "high", n: 99 },
    ]);
    for (const q of QUERIES) {
      for (const limit of [1, 2, 3, 5, 2000]) {
        const { legacy, folded } = both(db, q, limit);
        expect(folded, `${q} limit=${limit}`).toEqual(legacy);
      }
    }
    // Spot-check the semantics the parity rests on.
    const { folded } = both(db, "", 2000);
    const cellA = folded.find((c) => c.lat === 10 && c.lng === 20)!;
    expect(cellA).toMatchObject({ threat_count: 16, country_code: "DE", top_threat_type: "c2", critical: 3, high: 3, medium: 5, low: 5 });
    expect(folded.find((c) => c.lat === 50 && c.lng === 60)).toMatchObject({ country_code: null, threat_count: 8 });
    expect(folded.find((c) => c.lat === 35.6)).toMatchObject({ threat_count: 8, critical: 2, high: 1, medium: 0, low: 0 });
    expect(folded.find((c) => c.lat === 48.8)).toMatchObject({ country_code: "xx" });
    expect(folded.some((c) => c.threat_count === 99)).toBe(false);
  });

  it("randomised: many ties across cells, countries and types, every filter, every limit", () => {
    const db = openMigratedDb();
    let seed = 0x5eed;
    const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
    const ccs = ["US", "RU", "CN", "DE", "XX", "NL", "BR"];
    const types = ["phishing", "c2", "malware_distribution", "credential_harvesting"];
    const sevs = ["critical", "high", "medium", "low", "HIGH", "info"];
    const rows: GeoRow[] = [];
    for (let i = 0; i < 3000; i++) {
      rows.push({
        hour: hourAgo(rnd(24 * 8)), // some land outside the 7d window
        lat: (rnd(40) - 20) / 10 + rnd(10) / 100,
        lng: (rnd(40) - 20) / 10 + rnd(10) / 100,
        cc: ccs[rnd(ccs.length)]!,
        type: types[rnd(types.length)]!,
        sev: sevs[rnd(sevs.length)]!,
        feed: rnd(4) === 0 ? "spam_trap" : "phishtank",
        n: 1 + rnd(3),
      });
    }
    insert(db, rows);
    for (const q of QUERIES) {
      for (const limit of [1, 7, 50, 400, 2000]) {
        const { legacy, folded } = both(db, q, limit);
        expect(legacy.length, q).toBeGreaterThan(0);
        expect(folded, `${q} limit=${limit}`).toEqual(legacy);
      }
    }
  });

  it("NULL country / threat type / severity / lat behave exactly as the old SQL", () => {
    // The real cube columns are NOT NULL; a nullable twin proves the fold's
    // NULL semantics match anyway (prod's table predates the migrations).
    const db = openMigratedDb();
    db.exec("DROP TABLE threat_cube_geo");
    db.exec(`CREATE TABLE threat_cube_geo (
      hour_bucket TEXT, lat_bucket REAL, lng_bucket REAL, country_code TEXT,
      threat_type TEXT, severity TEXT, source_feed TEXT, threat_count INTEGER)`);
    insert(db, [
      // NULL country never wins (dropped by `!= 'XX'`); the cell falls to FR.
      { lat: 1, lng: 1, cc: null, type: "phishing", sev: "high", n: 10 },
      { lat: 1, lng: 1, cc: "FR", type: "phishing", sev: "high", n: 1 },
      // Only NULL / XX countries → null.
      { lat: 2, lng: 2, cc: null, type: "phishing", sev: "low", n: 3 },
      { lat: 2, lng: 2, cc: "XX", type: "phishing", sev: "low", n: 3 },
      // NULL threat type ties with 'a…': NULL sorts first → top type null.
      { lat: 3, lng: 3, cc: "US", type: null, sev: "medium", n: 2 },
      { lat: 3, lng: 3, cc: "US", type: "c2", sev: "medium", n: 2 },
      // NULL threat type with the larger sum wins outright.
      { lat: 4, lng: 4, cc: "US", type: null, sev: "medium", n: 5 },
      { lat: 4, lng: 4, cc: "US", type: "phishing", sev: "medium", n: 1 },
      // NULL severity counts in the total only.
      { lat: 5, lng: 5, cc: "DE", type: "phishing", sev: null, n: 4 },
      // NULL lat: its own cell, ordered first among equals, never joined.
      { lat: null, lng: 6, cc: "DE", type: "phishing", sev: "high", n: 4 },
      { lat: 6, lng: null, cc: "DE", type: "phishing", sev: "high", n: 4 },
    ]);
    for (const q of ["", "severity=high", "threat_type=phishing"]) {
      for (const limit of [1, 2, 4, 2000]) {
        const { legacy, folded } = both(db, q, limit);
        expect(folded, `${q} limit=${limit}`).toEqual(legacy);
      }
    }
    const { folded } = both(db, "", 2000);
    expect(folded.find((c) => c.lat === 1)).toMatchObject({ country_code: "FR", threat_count: 11 });
    expect(folded.find((c) => c.lat === 2)).toMatchObject({ country_code: null });
    expect(folded.find((c) => c.lat === 3)).toMatchObject({ top_threat_type: null });
    expect(folded.find((c) => c.lat === null)).toMatchObject({ country_code: null, top_threat_type: null });
  });

  it("empty window → empty result on both paths", () => {
    const db = openMigratedDb();
    const { legacy, folded } = both(db, "", 2000);
    expect(legacy).toEqual([]);
    expect(folded).toEqual([]);
  });
});
