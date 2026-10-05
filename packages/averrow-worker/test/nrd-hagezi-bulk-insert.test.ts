// nrd_hagezi brand-match threats are written in bulk (bulkInsertThreats),
// not per match. The old loop did, per matched domain and in series:
// KV GET (isDuplicate) → D1 INSERT (insertThreat) → D1 UPDATE brands
// (insertThreat's counter bump) → KV PUT (markSeen). A busy NRD day with
// short brand keywords + homoglyphs produced thousands of matches → thousands
// of serial subrequests. These tests pin the bulk path: ≤100 binds per
// statement, a bounded number of D1 round trips independent of N, no KV
// traffic, and new/duplicate/error accounting + brands.threat_count identical
// to the per-row path.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { nrd_hagezi, collectBrandMatchRows, NRD_SNAPSHOT_KEY } from "../src/feeds/nrd_hagezi";
import { THREAT_INSERT_CHUNK } from "../src/lib/feedRunner";
import { threatId } from "../src/feeds/types";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { fakeR2Bucket, gzipText, type FakeR2Bucket } from "./fake-r2-bucket";
import type { Env } from "../src/types";

const D1_MAX_BINDS = 100;

interface Stats {
  maxBinds: number;
  /** D1 round trips: one per batch() call + one per standalone run/all/first. */
  roundTrips: number;
  batchCalls: number;
}

/**
 * Wrap a D1 so (a) any statement bound with >100 params throws (prod D1
 * behaviour) and (b) every network round trip is counted: each `batch()` is
 * one, each standalone `run()`/`all()`/`first()` is one.
 */
function instrumented(db: D1Database, stats: Stats): D1Database {
  const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const s = stmt as unknown as Record<string, unknown>;
    return {
      ...s,
      bind: (...args: unknown[]) => {
        stats.maxBinds = Math.max(stats.maxBinds, args.length);
        if (args.length > D1_MAX_BINDS) throw new Error(`too many SQL variables (${args.length})`);
        return wrapStmt(stmt.bind(...args));
      },
      run: () => { stats.roundTrips++; return stmt.run(); },
      all: () => { stats.roundTrips++; return stmt.all(); },
      first: (col?: string) => { stats.roundTrips++; return col ? stmt.first(col) : stmt.first(); },
    } as unknown as D1PreparedStatement;
  };
  return {
    ...db,
    prepare: (sql: string) => wrapStmt(db.prepare(sql)),
    batch: async <T>(stmts: D1PreparedStatement[]) => {
      stats.batchCalls++;
      stats.roundTrips++;
      // Unwrap: the harness batch() calls .run() on each, which would
      // otherwise count one batch as N round trips.
      return db.batch<T>(stmts.map((st) => unwrapForBatch(db, st)));
    },
  } as D1Database;
}

/** Rebuild a raw harness statement from a wrapped one so batch() doesn't count per-row runs. */
function unwrapForBatch(db: D1Database, st: D1PreparedStatement): D1PreparedStatement {
  const s = st as unknown as { __sql: string; __bound: unknown[] };
  return db.prepare(s.__sql).bind(...s.__bound);
}

interface CountingKv { kv: KVNamespace & { store: Map<string, string> }; ops: { get: number; put: number } }
function countingKv(seed: Record<string, string> = {}): CountingKv {
  const base = fakeKv(seed);
  const ops = { get: 0, put: 0 };
  const kv = {
    ...base,
    store: base.store,
    get: async (k: string) => { ops.get++; return base.get(k); },
    put: async (k: string, v: string) => { ops.put++; return base.put(k, v); },
  } as unknown as KVNamespace & { store: Map<string, string> };
  return { kv, ops };
}

let raw: SqliteDb;
let stats: Stats;
let db: D1Database;
let r2: FakeR2Bucket;

/**
 * The feed diffs the list against the previous run's R2 snapshot and, with
 * no snapshot, only bootstraps. These tests are about the D1 write path, so
 * they start from an EMPTY prior snapshot: every listed domain is "new".
 */
async function emptyPriorSnapshot(): Promise<FakeR2Bucket> {
  return fakeR2Bucket({
    [NRD_SNAPSHOT_KEY]: { bytes: await gzipText(""), customMetadata: { version: "prior" } },
  });
}

const count = (sql: string, ...p: unknown[]): number =>
  (raw.prepare(sql).all(...p)[0] as { n: number }).n;

const brandThreatCount = (id: string): number =>
  (raw.prepare("SELECT threat_count AS n FROM brands WHERE id = ?").all(id)[0] as { n: number }).n;

/** Serve a list in the upstream's byte-sorted order (the diff requires it). */
function serve(domains: string[]): void {
  const body = `# header\n${[...domains].sort().join("\n")}\n`;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
}

async function ingest(kv: KVNamespace) {
  const env = { DB: db, CACHE: kv, GEOIP_STAGING: r2.bucket } as unknown as Env;
  return nrd_hagezi.ingest({ env, feedName: "nrd_hagezi", feedUrl: "" });
}

function seedBrand(id: string, name: string, canonical: string): void {
  raw.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES (?, ?, ?)").run(id, name, canonical);
  raw.prepare(
    "INSERT INTO monitored_brands (brand_id, tenant_id, added_by, status) VALUES (?, '__internal__', 'u1', 'active')",
  ).run(id);
}

describe.skipIf(!hasSqlite())("nrd_hagezi — bulk brand-match insert", () => {
  beforeEach(async () => {
    raw = openDerivedDb(["brands", "monitored_brands", "threats"]);
    stats = { maxBinds: 0, roundTrips: 0, batchCalls: 0 };
    db = instrumented(d1FromSqlite(raw), stats);
    r2 = await emptyPriorSnapshot();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("1,500 matches insert with ≤100 binds/statement, O(N/chunk) round trips and zero KV ops", async () => {
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    const matching = Array.from({ length: 1500 }, (_, i) => `acmebank-${i}.example`);
    const noise = Array.from({ length: 500 }, (_, i) => `unrelated-${i}.example`);
    serve([...matching, ...noise]);
    const { kv, ops } = countingKv();

    const result = await ingest(kv);

    expect(result).toEqual({ itemsFetched: 2000, itemsNew: 1500, itemsDuplicate: 0, itemsError: 0 });
    expect(stats.maxBinds).toBeLessThanOrEqual(D1_MAX_BINDS);
    // Threat inserts: ceil(1500/50) = 30 batches + 1 brand-counter flush.
    // Plus the fixed overhead: nrd_domains CREATE + its batch, brands SELECT.
    const threatBatches = Math.ceil(1500 / THREAT_INSERT_CHUNK);
    expect(stats.roundTrips).toBeLessThanOrEqual(threatBatches + 1 + 5);
    // The per-row path was ≥3 round trips per match (4 counting the bump).
    expect(stats.roundTrips).toBeLessThan(1500 / 10);
    expect(ops).toEqual({ get: 0, put: 0 });

    expect(count("SELECT COUNT(*) AS n FROM threats WHERE source_feed = 'nrd_hagezi'")).toBe(1500);
    expect(brandThreatCount("b_acme")).toBe(1500);
  });

  it("pre-existing threat rows count as duplicates and are not re-counted on the brand", async () => {
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    raw.prepare(
      `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, target_brand_id, ioc_value, status, created_at)
       VALUES (?, 'nrd_hagezi', 'typosquatting', 'acmebank-0.example', 'b_acme', 'acmebank-0.example', 'active', datetime('now'))`,
    ).run(threatId("nrd_hagezi", "domain", "acmebank-0.example"));
    raw.prepare("UPDATE brands SET threat_count = 1 WHERE id = 'b_acme'").run();

    serve(["acmebank-0.example", "acmebank-1.example", "acmebank-2.example"]);
    const result = await ingest(countingKv().kv);

    expect(result).toEqual({ itemsFetched: 3, itemsNew: 2, itemsDuplicate: 1, itemsError: 0 });
    expect(brandThreatCount("b_acme")).toBe(3);
  });

  it("a retry that re-diffs the same list (snapshot not advanced) yields 0 new, all duplicates, threat_count unchanged", async () => {
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    const domains = [...Array.from({ length: 120 }, (_, i) => `acmebank-${i}.example`), "plain.example"];
    serve(domains);

    const first = await ingest(countingKv().kv);
    expect(first).toEqual({ itemsFetched: 121, itemsNew: 120, itemsDuplicate: 0, itemsError: 0 });
    expect(brandThreatCount("b_acme")).toBe(120);

    // Simulate a retry after a run whose snapshot PUT never happened: the
    // same list is diffed against the same (empty) prior snapshot again.
    // Fresh KV (cold cache) — dedup is the PK, not the 24h KV key.
    r2 = await emptyPriorSnapshot();
    const second = await ingest(countingKv().kv);
    expect(second).toEqual({ itemsFetched: 121, itemsNew: 0, itemsDuplicate: 120, itemsError: 0 });
    expect(brandThreatCount("b_acme")).toBe(120);
    expect(count("SELECT COUNT(*) AS n FROM threats WHERE source_feed = 'nrd_hagezi'")).toBe(120);
  });

  it("a domain repeated in the archive is one threat + one duplicate", async () => {
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    serve(["acmebank-x.example", "acmebank-x.example", "acmebank-y.example"]);

    const result = await ingest(countingKv().kv);

    expect(result).toEqual({ itemsFetched: 3, itemsNew: 2, itemsDuplicate: 1, itemsError: 0 });
    expect(brandThreatCount("b_acme")).toBe(2);
  });

  it("KV dedup keys from other feeds no longer suppress the nrd row (per-feed PK dedup)", async () => {
    // Intentional, matches phishing_database/phishdestroy: the shared
    // `dedup:domain:*` KV key (written by certstream/digitalside/...) used
    // to cross-suppress this feed's own typosquat row. Dedup is now this
    // feed's deterministic threatId PK only.
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    serve(["acmebank-seen.example"]);
    const { kv, ops } = countingKv({ "dedup:domain:acmebank-seen.example": "1" });

    const result = await ingest(kv);

    expect(result).toEqual({ itemsFetched: 1, itemsNew: 1, itemsDuplicate: 0, itemsError: 0 });
    expect(ops).toEqual({ get: 0, put: 0 });
  });

  it("one brand per domain (first brand wins); a brand's canonical domain falls through to the next brand", async () => {
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    seedBrand("b_bank", "Bank", "bank.example");
    serve([
      "acmebank-login.example", // matches both → first brand (b_acme)
      "acmebank.com", // canonical for b_acme → skipped for it, still matches b_bank ("bank")
      "bank.example", // b_bank's own canonical, matches no other brand → no threat
      "mybank-secure.example", // b_bank only
    ]);

    const result = await ingest(countingKv().kv);

    expect(result).toEqual({ itemsFetched: 4, itemsNew: 3, itemsDuplicate: 0, itemsError: 0 });
    const brandOf = (d: string) =>
      (raw.prepare("SELECT target_brand_id AS b FROM threats WHERE malicious_domain = ?").all(d) as Array<{ b: string }>)
        .map((r) => r.b);
    expect(brandOf("acmebank-login.example")).toEqual(["b_acme"]);
    expect(brandOf("acmebank.com")).toEqual(["b_bank"]);
    expect(brandOf("bank.example")).toEqual([]);
    expect(brandOf("mybank-secure.example")).toEqual(["b_bank"]);
    expect(brandThreatCount("b_acme")).toBe(1);
    expect(brandThreatCount("b_bank")).toBe(2);
  });

  it("a failing threat-insert batch counts its whole chunk as itemsError; other chunks land; counters bump only for landed rows", async () => {
    // Intended change vs the per-row path (one bad row = 1 error): D1 batch
    // is one transaction, so a thrown chunk is rolled back in full.
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    const n = 120; // chunks of 50: [0..49] ok, [50..99] throws, [100..119] ok
    serve(Array.from({ length: n }, (_, i) => `acmebank-${i}.example`));

    let threatBatches = 0;
    const inner = db;
    db = {
      ...inner,
      batch: async <T>(stmts: D1PreparedStatement[]) => {
        const sql = (stmts[0] as unknown as { __sql?: string }).__sql ?? "";
        if (sql.includes("INSERT OR IGNORE INTO threats") && ++threatBatches === 2) {
          throw new Error("D1_ERROR: simulated chunk failure");
        }
        return inner.batch<T>(stmts);
      },
    } as D1Database;

    const result = await ingest(countingKv().kv);

    expect(threatBatches).toBe(Math.ceil(n / THREAT_INSERT_CHUNK));
    expect(result).toEqual({ itemsFetched: n, itemsNew: 70, itemsDuplicate: 0, itemsError: THREAT_INSERT_CHUNK });
    expect(count("SELECT COUNT(*) AS n FROM threats WHERE source_feed = 'nrd_hagezi'")).toBe(70);
    expect(count("SELECT COUNT(*) AS n FROM threats WHERE malicious_domain = 'acmebank-50.example'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM threats WHERE malicious_domain = 'acmebank-100.example'")).toBe(1);
    expect(brandThreatCount("b_acme")).toBe(70);
    // The failed chunk must be retried: the snapshot is NOT advanced.
    expect(r2.ops.put).toBe(0);
    expect(r2.store.get(NRD_SNAPSHOT_KEY)?.customMetadata.version).toBe("prior");
  });

  it("writes the same threat fields the per-row path did", async () => {
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    serve(["acmeb4nk-secure.example"]);

    await ingest(countingKv().kv);

    const row = raw.prepare(
      `SELECT id, source_feed, threat_type, severity, confidence_score, malicious_url, malicious_domain, ioc_value, target_brand_id
         FROM threats`,
    ).all()[0];
    expect(row).toEqual({
      id: threatId("nrd_hagezi", "domain", "acmeb4nk-secure.example"),
      source_feed: "nrd_hagezi",
      threat_type: "typosquatting",
      severity: "medium",
      confidence_score: 60,
      malicious_url: null,
      malicious_domain: "acmeb4nk-secure.example",
      ioc_value: "acmeb4nk-secure.example",
      target_brand_id: "b_acme",
    });
  });
});

describe("collectBrandMatchRows (pure)", () => {
  it("is first-brand-wins, skips canonical per brand, and counts in-list repeats", () => {
    const brands = [
      { id: "a", domain: "acme.com", needles: ["acme"] },
      { id: "b", domain: "shop.com", needles: ["acme", "shop"] },
    ];
    const { rows, inPayloadDuplicates } = collectBrandMatchRows(
      ["acme-x.io", "acme.com", "acme-x.io", "nothing.io", "shop-y.io"],
      brands,
    );
    expect(rows.map((r) => [r.malicious_domain, r.target_brand_id])).toEqual([
      ["acme-x.io", "a"],
      ["acme.com", "b"],
      ["shop-y.io", "b"],
    ]);
    expect(inPayloadDuplicates).toBe(1);
  });
});
