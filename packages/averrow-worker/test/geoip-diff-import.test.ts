/**
 * Diff-only GeoIP import — unit coverage for the in-place merge that
 * replaced the full table rebuild (write-budget remediation 2026-06-09).
 *
 * Exercises runGeoipDiffImport against a fake D1 + in-memory zip:
 *   - first run into an empty table inserts every row
 *   - second run with a changed / unchanged / removed / new row produces
 *     exactly one update, one unchanged, one delete, one insert
 *   - insert-phase resume (`resumeFromRow`) skips existence-check/upsert
 *     for already-committed rows but still feeds their key into the
 *     delete pass's incoming-key set, and is a no-op on a delete-resuming
 *     call
 *   - `resumeRowsDeleted` seeds the delete pass's running total so a
 *     multi-attempt delete resume reports the cumulative count
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
  /** Count of INSERT OR REPLACE statements actually run. Used by the
   *  resume tests to prove the insert/update pass is truly skipped
   *  (zero upserts) rather than merely idempotent. */
  upsertCount = 0;
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
      this.db.upsertCount++;
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

  // ── Checkpoint/resume + progress emission (DELETE-pass resume) ──

  it("calls onInsertPhaseComplete exactly once, before any onDeleteProgress, with rowsWritten = inserted+updated", async () => {
    const db = new FakeD1();
    // Seed (fresh run, no callbacks).
    await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",
      "3.0.0.0/24,1,1,,0,0,94043,37.6,-122.2,1000",
    ])));

    const order: Array<
      | { kind: "insertComplete"; rowsWritten: number }
      | { kind: "deleteProgress" }
    > = [];

    const r = await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",   // unchanged
      "2.0.0.0/24,1,1,,0,0,94043,38.5,-122.1,1000",   // lat changed → update
      "4.0.0.0/24,1,1,,0,0,94043,40.0,-100.0,1000",   // new → insert
      // 3.0.0.0/24 dropped → delete
    ])), {
      onInsertPhaseComplete: async (rowsWritten) => {
        order.push({ kind: "insertComplete", rowsWritten });
      },
      onDeleteProgress: async () => {
        order.push({ kind: "deleteProgress" });
      },
    });

    expect(r.rowsInserted).toBe(1);
    expect(r.rowsUpdated).toBe(1);
    expect(r.rowsDeleted).toBe(1);

    const completions = order.filter(
      (e): e is { kind: "insertComplete"; rowsWritten: number } => e.kind === "insertComplete",
    );
    expect(completions).toHaveLength(1);
    expect(completions[0].rowsWritten).toBe(r.rowsInserted + r.rowsUpdated);

    const insertCompleteIdx = order.findIndex((e) => e.kind === "insertComplete");
    const firstDeleteIdx = order.findIndex((e) => e.kind === "deleteProgress");
    expect(insertCompleteIdx).toBeGreaterThanOrEqual(0);
    expect(firstDeleteIdx).toBeGreaterThan(insertCompleteIdx);
  });

  it("advances onDeleteProgress monotonically across delete pages with a consistent lastCommittedRow offset", async () => {
    const db = new FakeD1();
    const TOTAL = 5001;       // > the 5000-row PAGE size forces two delete-scan pages
    const DROP_INDEX = 2500;  // dropped key, sorts into the first page

    const rowLine = (i: number) => {
      const x = Math.floor(i / 256);
      const y = i % 256;
      // Distinct /24 networks, strictly ascending start_ip_int as i increases
      // (same construction as the D1-cap test above).
      return `10.${x}.${y}.0/24,1,1,,0,0,94043,37.4,-122.0,1000`;
    };

    const allRows: string[] = [];
    for (let i = 0; i < TOTAL; i++) allRows.push(rowLine(i));

    // Seed every row (fresh run, no callbacks).
    await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks(allRows)));
    expect(db.rows.size).toBe(TOTAL);

    // Second release: identical except one dropped row → exactly one delete.
    const secondRows = allRows.filter((_, i) => i !== DROP_INDEX);

    const calls: Array<{ deleteCursor: number; lastCommittedRow: number; rowsDeleted: number }> = [];
    const r = await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks(secondRows)), {
      onDeleteProgress: async (p) => { calls.push(p); },
    });

    expect(r.rowsDeleted).toBe(1);
    expect(calls.length).toBeGreaterThanOrEqual(2); // proves the pagination actually spans 2 pages

    // deleteCursor is non-decreasing across successive page-progress calls.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.deleteCursor).toBeGreaterThanOrEqual(calls[i - 1]!.deleteCursor);
    }

    // lastCommittedRow = base + deleteCursor, with an identical base on every call.
    const base = calls[0]!.lastCommittedRow - calls[0]!.deleteCursor;
    expect(base).toBe(10_000_000_000); // DELETE_PROGRESS_BASE, read from source (not exported)
    for (const c of calls) {
      expect(c.lastCommittedRow - c.deleteCursor).toBe(base);
    }

    // Final call's running total matches the function's result.
    expect(calls[calls.length - 1]!.rowsDeleted).toBe(r.rowsDeleted);
  });

  it("resume (resumeDeleteCursor set) skips insert/update writes but still deletes the dropped key", async () => {
    const db = new FakeD1();
    await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",
      "3.0.0.0/24,1,1,,0,0,94043,37.6,-122.2,1000",
    ])));

    const seededHashForKey2 = db.rows.get(33554432 /* 2.0.0.0 */)?.row_hash;
    expect(seededHashForKey2).toBeTruthy();
    const upsertCountBefore = db.upsertCount;

    const r = await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",   // unchanged
      "2.0.0.0/24,1,1,,0,0,94043,38.5,-122.1,1000",   // would be an UPDATE if not resuming
      "4.0.0.0/24,1,1,,0,0,94043,40.0,-100.0,1000",   // would be an INSERT if not resuming
      // 3.0.0.0/24 dropped → still deleted even on resume
    ])), { resumeDeleteCursor: -1 });

    expect(r.rowsInserted).toBe(0);
    expect(r.rowsUpdated).toBe(0);
    expect(r.rowsUnchanged).toBe(0);
    expect(r.rowsDeleted).toBe(1);

    // No INSERT OR REPLACE ran during the resumed call — the insert/update
    // pass was truly skipped, not just idempotent.
    expect(db.upsertCount - upsertCountBefore).toBe(0);

    // Key 2's stored row_hash is untouched — the "update" never wrote.
    expect(db.rows.get(33554432)?.row_hash).toBe(seededHashForKey2);

    // Key 4 was never inserted — the insert pass was skipped.
    expect(db.rows.has(67108864 /* 4.0.0.0 */)).toBe(false);

    // Key 3 was dropped from the incoming release and IS deleted.
    expect(db.rows.has(50331648 /* 3.0.0.0 */)).toBe(false);
  });

  it("resume from a mid-scan cursor only scans/deletes keys strictly greater than the cursor", async () => {
    const db = new FakeD1();
    await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",   // A
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",   // B
      "3.0.0.0/24,1,1,,0,0,94043,37.6,-122.2,1000",   // C
      "4.0.0.0/24,1,1,,0,0,94043,38.0,-101.0,1000",   // D
    ])));
    expect(db.rows.size).toBe(4);

    const cursorAtB = 33554432; // 2.0.0.0

    // The incoming release "drops" both A and C from MaxMind's perspective,
    // but A sits at/under the resume cursor so it must never even be
    // scanned. Only D needs to appear in the incoming set so it isn't
    // mistaken for a drop.
    const r = await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "4.0.0.0/24,1,1,,0,0,94043,38.0,-101.0,1000",   // D — present, so not deleted
    ])), { resumeDeleteCursor: cursorAtB });

    expect(r.rowsDeleted).toBe(1); // only C
    expect(db.rows.has(16777216 /* A: 1.0.0.0, <= cursor, never scanned */)).toBe(true);
    expect(db.rows.has(33554432 /* B: == cursor, excluded by strict > */)).toBe(true);
    expect(db.rows.has(50331648 /* C: > cursor, absent from incoming → deleted */)).toBe(false);
    expect(db.rows.has(67108864 /* D: > cursor, present in incoming → kept */)).toBe(true);
  });

  it("does not call onInsertPhaseComplete on a resuming run", async () => {
    const db = new FakeD1();
    await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",
    ])));

    const order: string[] = [];
    await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      // 2.0.0.0/24 dropped
    ])), {
      resumeDeleteCursor: -1,
      onInsertPhaseComplete: async () => { order.push("insertComplete"); },
      onDeleteProgress: async () => { order.push("deleteProgress"); },
    });

    expect(order).not.toContain("insertComplete");
    expect(order).toContain("deleteProgress");
  });

  // ── Insert-phase resume (`resumeFromRow`) ──

  it("insert-resume: rows <= resumeFromRow skip existence-check + upsert, rows past it are still written", async () => {
    const seedRows = [
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",
      "3.0.0.0/24,1,1,,0,0,94043,37.6,-122.2,1000",
      "4.0.0.0/24,1,1,,0,0,94043,37.7,-122.3,1000",
    ];
    // Second release: row 1 unchanged, row 2 WOULD be an update (lat/lng
    // changed) but sits at/under the resume checkpoint; row 3 unchanged,
    // row 4 is a real update past the checkpoint, row 5 is a real insert
    // past the checkpoint.
    const secondRows = [
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,99.9,-99.9,1000",
      "3.0.0.0/24,1,1,,0,0,94043,37.6,-122.2,1000",
      "4.0.0.0/24,1,1,,0,0,94043,50.0,-50.0,1000",
      "5.0.0.0/24,1,1,,0,0,94043,10.0,-10.0,1000",
    ];

    // Test run: resumeFromRow = 2 skips rows 1 and 2's existence-check/upsert.
    const testDb = new FakeD1();
    await runGeoipDiffImport(testDb as never, new FakeZip(LOCATIONS, blocks(seedRows)));
    const seededHashKey2Test = testDb.rows.get(33554432 /* 2.0.0.0 */)?.row_hash;
    const seededHashKey4Test = testDb.rows.get(67108864 /* 4.0.0.0 */)?.row_hash;
    const upsertsBeforeTest = testDb.upsertCount;

    const testResult = await runGeoipDiffImport(
      testDb as never,
      new FakeZip(LOCATIONS, blocks(secondRows)),
      { resumeFromRow: 2 },
    );

    // Control run: identical second release, but resumeFromRow=0 (full pass) —
    // isolates what the resume skip changed vs. a normal run over the same data.
    const controlDb = new FakeD1();
    await runGeoipDiffImport(controlDb as never, new FakeZip(LOCATIONS, blocks(seedRows)));
    const upsertsBeforeControl = controlDb.upsertCount;

    const controlResult = await runGeoipDiffImport(
      controlDb as never,
      new FakeZip(LOCATIONS, blocks(secondRows)),
      { resumeFromRow: 0 },
    );

    // Control (no resume) sees row 2 as a genuine update.
    expect(controlResult.rowsUpdated).toBe(2);   // rows 2 and 4
    expect(controlResult.rowsUnchanged).toBe(2); // rows 1 and 3
    expect(controlResult.rowsInserted).toBe(1);  // row 5
    expect(controlDb.upsertCount - upsertsBeforeControl).toBe(3); // 2 updates + 1 insert
    expect(controlDb.rows.get(33554432)?.row_hash).not.toBe(seededHashKey2Test);

    // Test (resumeFromRow=2) only ever runs existence-check/upsert for rows
    // 3-5: row 3 unchanged, row 4 update, row 5 insert. Rows 1 and 2 never
    // reach the existence-check.
    expect(testResult.rowsUpdated).toBe(1);   // row 4 only
    expect(testResult.rowsUnchanged).toBe(1); // row 3 only — row 1 was skipped entirely, not counted
    expect(testResult.rowsInserted).toBe(1);  // row 5
    expect(testDb.upsertCount - upsertsBeforeTest).toBe(2); // 1 update + 1 insert — row 2's update never happened
    expect(testResult.rowsDeleted).toBe(0);

    // Row 2 (index <= resumeFromRow, would've been an update) is untouched —
    // its stored row_hash is still the seeded value.
    expect(testDb.rows.get(33554432)?.row_hash).toBe(seededHashKey2Test);
    // Row 4 (index > resumeFromRow, a genuine update) IS rewritten.
    expect(testDb.rows.get(67108864)?.row_hash).not.toBe(seededHashKey4Test);
    // Row 5 (index > resumeFromRow, a genuine insert) IS written.
    expect(testDb.rows.has(83886080 /* 5.0.0.0 */)).toBe(true);
  });

  it("delete pass sees the COMPLETE incoming key set even when insert-phase rows are skipped for resumeFromRow", async () => {
    // Regression guard: if the insert-phase skip branch forgot to record
    // the skipped row's key into the incoming-key set, the delete pass
    // would mistake still-present-but-skipped keys for MaxMind having
    // dropped them, and delete rows that were never actually removed.
    const db = new FakeD1();
    await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000", // A
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000", // B
      "3.0.0.0/24,1,1,,0,0,94043,37.6,-122.2,1000", // C
      "4.0.0.0/24,1,1,,0,0,94043,38.0,-101.0,1000", // D
    ])));
    expect(db.rows.size).toBe(4);

    // Second release drops C. A and B are still present in the incoming
    // set (same data, unchanged) but sit at/under resumeFromRow=2, so
    // their existence-check + upsert is skipped. D is present, past the
    // checkpoint, processed normally.
    const r = await runGeoipDiffImport(
      db as never,
      new FakeZip(LOCATIONS, blocks([
        "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000", // A — present, skipped for resume
        "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000", // B — present, skipped for resume
        "4.0.0.0/24,1,1,,0,0,94043,38.0,-101.0,1000", // D — present, past checkpoint
        // C dropped
      ])),
      { resumeFromRow: 2 },
    );

    expect(r.rowsDeleted).toBe(1);
    expect(db.rows.has(16777216 /* A: still present, must NOT be deleted */)).toBe(true);
    expect(db.rows.has(33554432 /* B: still present, must NOT be deleted */)).toBe(true);
    expect(db.rows.has(50331648 /* C: absent from incoming, correctly deleted */)).toBe(false);
    expect(db.rows.has(67108864 /* D: present, past checkpoint, kept */)).toBe(true);
  });

  it("ignores resumeFromRow when resumeDeleteCursor is set (delete-resuming call)", async () => {
    const db = new FakeD1();
    await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",
      "3.0.0.0/24,1,1,,0,0,94043,37.6,-122.2,1000",
    ])));
    const upsertCountBefore = db.upsertCount;

    // resumeDeleteCursor is set (delete-resuming), so the whole insert pass
    // is skipped regardless of resumeFromRow — pass a non-zero value here
    // to prove it has no effect on the outcome.
    const r = await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",   // unchanged
      "2.0.0.0/24,1,1,,0,0,94043,38.5,-122.1,1000",   // would be an UPDATE if the insert pass ran
      "4.0.0.0/24,1,1,,0,0,94043,40.0,-100.0,1000",   // would be an INSERT if the insert pass ran
      // 3.0.0.0/24 dropped → still deleted
    ])), { resumeDeleteCursor: -1, resumeFromRow: 2 });

    expect(r.rowsInserted).toBe(0);
    expect(r.rowsUpdated).toBe(0);
    expect(r.rowsUnchanged).toBe(0);
    expect(r.rowsDeleted).toBe(1);
    expect(db.upsertCount - upsertCountBefore).toBe(0);
    expect(db.rows.has(50331648 /* 3.0.0.0, dropped */)).toBe(false);
    expect(db.rows.has(67108864 /* 4.0.0.0, never inserted despite resumeFromRow=2 */)).toBe(false);
  });

  // ── Cumulative rows_deleted across a delete resume (`resumeRowsDeleted`) ──

  it("resumeRowsDeleted seeds the running total so rowsDeleted and the final onDeleteProgress report the cumulative count", async () => {
    const db = new FakeD1();
    await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",
      "3.0.0.0/24,1,1,,0,0,94043,37.6,-122.2,1000",
      "4.0.0.0/24,1,1,,0,0,94043,38.0,-101.0,1000",
    ])));

    const calls: Array<{ rowsDeleted: number }> = [];
    const r = await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",
      "4.0.0.0/24,1,1,,0,0,94043,38.0,-101.0,1000",
      // 3.0.0.0/24 dropped → the only real delete this attempt
    ])), {
      resumeDeleteCursor: -1,
      resumeRowsDeleted: 7, // simulates 7 already deleted by a prior attempt
      onDeleteProgress: async (p) => { calls.push({ rowsDeleted: p.rowsDeleted }); },
    });

    expect(r.rowsDeleted).toBe(8); // 7 seeded + 1 real delete this attempt
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]!.rowsDeleted).toBe(8);
  });

  it("defaults resumeRowsDeleted to 0 so a fresh run without it reports only its own delete count", async () => {
    const db = new FakeD1();
    await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",
      "3.0.0.0/24,1,1,,0,0,94043,37.6,-122.2,1000",
    ])));

    // Fresh (non-resuming) run — resumeRowsDeleted not passed.
    const r = await runGeoipDiffImport(db as never, new FakeZip(LOCATIONS, blocks([
      "1.0.0.0/24,1,1,,0,0,94043,37.4,-122.0,1000",
      "2.0.0.0/24,1,1,,0,0,94043,37.5,-122.1,1000",
      // 3.0.0.0/24 dropped
    ])));

    expect(r.rowsDeleted).toBe(1);
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
