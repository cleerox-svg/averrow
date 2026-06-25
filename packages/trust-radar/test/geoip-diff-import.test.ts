/**
 * Diff-only GeoIP import — unit coverage for the in-place merge that
 * replaced the full table rebuild (write-budget remediation 2026-06-09).
 *
 * Exercises runGeoipDiffImport against a fake D1 + in-memory zip:
 *   - first run into an empty table inserts every row
 *   - second run with a changed / unchanged / removed / new row produces
 *     exactly one update, one unchanged, one delete, one insert
 * Plus computeRowHash determinism + change-sensitivity (the skip-vs-write
 * decision rides entirely on the hash).
 */

import { describe, it, expect } from "vitest";
import {
  runGeoipDiffImport,
  computeRowHash,
  type ZipReaderLike,
} from "../src/lib/geoip-import";

// ── Fake D1 keyed by start_ip_int ──────────────────────────────────
interface LiveRow { row_hash: string | null }

class FakeD1 {
  rows = new Map<number, LiveRow>();
  /** Largest bound-variable count seen on any `start_ip_int IN (...)`
   *  existence check — D1 caps a single statement at 100 variables, so
   *  a regression that lets the IN(...) grow with D1_BATCH_LIMIT (500)
   *  would surface here. */
  maxInVars = 0;
  prepare(sql: string) { return new FakeStmt(this, sql); }
  async batch(stmts: FakeStmt[]) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

class FakeStmt {
  private args: unknown[] = [];
  constructor(private db: FakeD1, private sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }

  async first<T>(): Promise<T> {
    if (this.sql.includes("COUNT(*)")) {
      return { n: this.db.rows.size } as unknown as T;
    }
    return null as unknown as T;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("WHERE start_ip_int IN")) {
      if (this.args.length > this.db.maxInVars) this.db.maxInVars = this.args.length;
      const results = (this.args as number[])
        .filter((k) => this.db.rows.has(k))
        .map((k) => ({ start_ip_int: k, row_hash: this.db.rows.get(k)!.row_hash }));
      return { results: results as unknown as T[] };
    }
    if (this.sql.includes("WHERE start_ip_int >")) {
      const cursor = this.args[0] as number;
      const limit = this.args[1] as number;
      const keys = [...this.db.rows.keys()].filter((k) => k > cursor).sort((a, b) => a - b).slice(0, limit);
      return { results: keys.map((k) => ({ start_ip_int: k })) as unknown as T[] };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes("INSERT OR REPLACE INTO geo_ip_ranges")) {
      const key = this.args[0] as number;
      const hash = this.args[9] as string;
      this.db.rows.set(key, { row_hash: hash });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("DELETE FROM geo_ip_ranges")) {
      this.db.rows.delete(this.args[0] as number);
      return { meta: { changes: 1 } };
    }
    // UPDATE geo_ip_refresh_log (onProgress) — no-op
    return { meta: { changes: 0 } };
  }
}

// ── In-memory zip ──────────────────────────────────────────────────
function streamOf(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

class FakeZip implements ZipReaderLike {
  constructor(private locations: string, private blocks: string) {}
  findEntry(name: string) {
    if (name.includes("Locations")) return { name: "loc" } as never;
    if (name.includes("Blocks")) return { name: "blocks" } as never;
    return null;
  }
  listEntries() { return []; }
  async streamEntry(entry: { name: string }): Promise<ReadableStream<Uint8Array>> {
    return streamOf(entry.name === "loc" ? this.locations : this.blocks);
  }
}

const LOCATIONS =
  "geoname_id,locale_code,continent_code,continent_name,country_iso_code,country_name,sub1_iso,sub1_name,sub2_iso,sub2_name,city_name\n" +
  '1,en,NA,"North America",US,"United States",CA,California,,,"Mountain View"\n';

// network, geoname_id, registered_country, represented, anon, sat, postal, lat, lng, accuracy
const blocks = (rows: string[]) =>
  "network,geoname_id,registered_country_geoname_id,represented_country_geoname_id,is_anonymous_proxy,is_satellite_provider,postal_code,latitude,longitude,accuracy_radius\n" +
  rows.join("\n") + "\n";

describe("runGeoipDiffImport", () => {
  it("inserts every row on the first run into an empty table", async () => {
    const db = new FakeD1();
    const zip = new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",
      "3.0.0.0/24,1,1,,0,0,94043,37.6,-122.2,1000",
    ]));
    const r = await runGeoipDiffImport(db as never, zip);
    expect(r.rowsInserted).toBe(3);
    expect(r.rowsUpdated).toBe(0);
    expect(r.rowsUnchanged).toBe(0);
    expect(r.rowsDeleted).toBe(0);
    expect(db.rows.size).toBe(3);
  });

  it("writes only the delta on a subsequent run (update + insert + delete, skip unchanged)", async () => {
    const db = new FakeD1();
    // Seed via a first run.
    await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",
      "3.0.0.0/24,1,1,,0,0,94043,37.6,-122.2,1000",
    ])));

    // Second release: 1 unchanged, 2 lat changed, 3 removed, 4 new.
    const r = await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",   // unchanged
      "2.0.0.0/24,1,1,,0,0,94043,38.5,-122.1,1000",   // lat changed → update
      "4.0.0.0/24,1,1,,0,0,94043,40.0,-100.0,1000",   // new → insert
    ])));

    expect(r.rowsInserted).toBe(1);
    expect(r.rowsUpdated).toBe(1);
    expect(r.rowsUnchanged).toBe(1);
    expect(r.rowsDeleted).toBe(1);
    // Final live set is {1,2,4}; 3 was deleted.
    const keys = [...db.rows.keys()].sort((a, b) => a - b);
    expect(keys).toEqual([16777216 /*1.0.0.0*/, 33554432 /*2.0.0.0*/, 67108864 /*4.0.0.0*/]);
  });

  it("keeps the existence-check IN(...) under D1's 100-variable cap across many rows", async () => {
    // Regression for "too many SQL variables at offset 282: SQLITE_ERROR":
    // the per-chunk existence SELECT must sub-chunk its IN(...) below D1's
    // 100-param-per-statement limit, independent of D1_BATCH_LIMIT (500).
    // 250 distinct rows forces multiple existence-check chunks and a
    // mid-stream processChunk flush.
    const db = new FakeD1();
    const rows: string[] = [];
    for (let i = 0; i < 250; i++) {
      // Distinct /24 networks: 10.x.y.0/24 for i = x*256 + y.
      const x = Math.floor(i / 256);
      const y = i % 256;
      rows.push(`10.${x}.${y}.0/24,1,1,,0,0,94043,37.4,-122.0,1000`);
    }
    const r = await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks(rows)));

    expect(r.rowsInserted).toBe(250);
    expect(db.rows.size).toBe(250);
    expect(db.maxInVars).toBeGreaterThan(0);          // the SELECT path ran
    expect(db.maxInVars).toBeLessThanOrEqual(100);    // never exceeds D1's cap
  });
});

describe("computeRowHash", () => {
  it("is stable for identical field values", () => {
    const a = computeRowHash(100, "US", "United States", "CA", "Mountain View", "94043", 37.4, -122.0);
    const b = computeRowHash(100, "US", "United States", "CA", "Mountain View", "94043", 37.4, -122.0);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when any field changes", () => {
    const base = computeRowHash(100, "US", "United States", "CA", "Mountain View", "94043", 37.4, -122.0);
    expect(computeRowHash(101, "US", "United States", "CA", "Mountain View", "94043", 37.4, -122.0)).not.toBe(base); // end_ip
    expect(computeRowHash(100, "CA", "United States", "CA", "Mountain View", "94043", 37.4, -122.0)).not.toBe(base); // country
    expect(computeRowHash(100, "US", "United States", "CA", "Mountain View", "94043", 38.4, -122.0)).not.toBe(base); // lat
    expect(computeRowHash(100, "US", "United States", "CA", "San Jose", "94043", 37.4, -122.0)).not.toBe(base);      // city
  });

  it("treats null and absent the same (both mean no value)", () => {
    expect(computeRowHash(100, null, null, null, null, null, null, null))
      .toBe(computeRowHash(100, null, null, null, null, null, null, null));
  });
});
